import { DurableObject } from "cloudflare:workers";
import {
  assertJson,
  assertJsonSize,
  JsonValidationError,
  type RoomActionResponse,
  type RoomActionResult,
  type JsonValue,
  type RoomLeave,
  type RoomPresence,
  type RoomPlayer,
  type RoomSnapshot,
  type RoomStart,
} from "@playweft/game-protocol";
import {
  GameRuntimeError,
  type GameRuntime,
  type GameTimerOperation,
} from "@playweft/runtime-core";
import type { Env } from "./env";
import {
  createRuntime,
  isRuntimeKind,
  type RuntimeKind,
} from "./runtime-registry";

const MAX_ACTION_BYTES = 8 * 1024;
const MAX_LATENCY_ACK_ID_LENGTH = 64;
const MIN_LATENCY_ACK_INTERVAL_MS = 3_000;
const MAX_RECENT_ACTIONS = 256;
const MAX_PLAYER_ID_LENGTH = 64;
const MAX_PLAYER_NAME_LENGTH = 100;
const MAX_AVATAR_BYTES = 1024 * 1024;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_SERVER_SOURCE_BYTES = 1024 * 1024;
const SERVER_FETCH_TIMEOUT_MS = 8_000;
const ROOM_IDLE_TTL_MS = 60 * 60 * 1_000;
const HOST_OFFLINE_TIMEOUT_MS = 45_000;
const LIVE_ACTIVITY_FLUSH_MS = 1_000;
const MAX_PLAYERS = 32;
const GAME_PROTOCOL_VERSION = 1;
const MAX_PENDING_TIMERS = 32;
const MAX_TIMER_PAYLOAD_BYTES = 8 * 1024;
const MAX_TIMER_PAYLOAD_TOTAL_BYTES = 32 * 1024;
const TIMER_BUDGET_CAPACITY = 16;
const TIMER_BUDGET_REFILL_MS = 5_000;
const MAX_TIMER_FIRES_PER_DAY = 2_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

interface RoomConfig {
  gameId: string;
  gameVersion: string;
  serverUrl: string;
  runtime: RuntimeKind;
  script: string;
  scriptHash: string;
  minPlayers: number;
  maxPlayers: number;
  liveRoom: boolean;
}

interface RoomLaunch {
  manifestUrl: string;
}

interface RoomState {
  state: JsonValue;
  version: number;
  match: {
    id: string;
    startedAt: number;
    randomSeed: string;
  };
  recentActions: StoredAction[];
  timers: RoomTimer[];
  timerBudget: TimerBudget;
}

interface RoomTimer {
  id: string;
  dueAt: number;
  payload?: JsonValue;
}

interface TimerBudget {
  tokens: number;
  updatedAt: number;
  dayStart: number;
  firedToday: number;
}

type TimerBudgetConsumption =
  | { allowed: true; budget: TimerBudget }
  | { allowed: false; budget: TimerBudget; nextAllowedAt: number };

interface StoredAction {
  actorId: string;
  requestId: string;
  actionHash: string;
  result: RoomActionResult;
}

type GameActor = {
  [key: string]: JsonValue;
  id: string;
  role: "player" | "spectator";
  isOwner: boolean;
};

interface RoomMeta {
  roomId: string;
  manifestUrl: string;
  ownerPlayerId: string;
  phase: "lobby" | "playing";
  /** Monotonic version of membership and outer room lifecycle state. */
  presenceRevision: number;
  /** Persisted separately from live WebSocket attachments for reconnect grace. */
  ownerLastSeenAt?: number;
  fault?: {
    message: string;
    at: number;
  };
  lastActivity?: number;
  members: Record<string, RoomMember>;
  config?: RoomConfig;
}

interface SocketAttachment {
  playerId: string;
  actorId: string;
  lastSeenAt: number;
  /** Last platform latency acknowledgement sent on this socket. */
  lastLatencyAckAt?: number;
  isOwner: boolean;
}

interface RoomMember {
  actorId: string;
  name?: string;
  avatarUrl?: string;
  avatarToken?: string;
  joinedAt: number;
  seat?: number;
  ready?: boolean;
}

class RoomHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * One Durable Object is one authoritative game room. It serializes every
 * mutation, executes the room's selected game runtime, then persists and broadcasts the
 * resulting state before accepting the next action.
 */
export class GameRoom extends DurableObject<Env> {
  private readonly bindings: Env;
  private runtime?: {
    kind: RuntimeKind;
    scriptHash: string;
    engine: GameRuntime;
  };
  private liveRoomState?: RoomState;
  private liveMeta?: RoomMeta;
  private liveMetaSavedAt = 0;
  private liveSockets = new Set<WebSocket>();
  private liveSocketAttachments = new Map<WebSocket, SocketAttachment>();
  private tail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.bindings = env;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      const avatarMatch = /^\/avatars\/([a-zA-Z0-9_-]{32})$/.exec(path);
      if (request.method === "GET" && avatarMatch) {
        const source = await this.enqueue(() =>
          this.avatarSource(avatarMatch[1]!),
        );
        return await proxyAvatar(source, request);
      }
      switch (`${request.method} ${path}`) {
        case "POST /create":
          return Response.json(await this.enqueue(() => this.create(request)));
        case "GET /launch":
          return Response.json(await this.enqueue(() => this.launch()));
        case "PUT /game":
          return Response.json(
            await this.enqueue(() => this.changeGame(request)),
          );
        case "GET /state":
          return Response.json(
            await this.enqueue(() => this.stateFor(request)),
          );
        case "PUT /initialize":
          return Response.json(
            await this.enqueue(() => this.initialize(request)),
          );
        case "POST /join":
          return Response.json(await this.enqueue(() => this.join(request)));
        case "POST /start":
          return Response.json(await this.enqueue(() => this.start(request)));
        case "POST /leave":
          return Response.json(await this.enqueue(() => this.leave(request)));
        case "POST /seat":
          return Response.json(await this.enqueue(() => this.setSeat(request)));
        case "POST /ready":
          return Response.json(
            await this.enqueue(() => this.setReady(request)),
          );
        case "PUT /profile-avatar":
          return Response.json(
            await this.enqueue(() => this.setProfileAvatar(request)),
          );
        case "POST /kick":
          return Response.json(await this.enqueue(() => this.kick(request)));
        case "POST /transfer-host":
          return Response.json(
            await this.enqueue(() => this.transferHost(request)),
          );
        case "POST /dissolve":
          return Response.json(
            await this.enqueue(() => this.dissolve(request)),
          );
        case "POST /return-to-room":
          return Response.json(
            await this.enqueue(() => this.returnToRoom(request)),
          );
        case "POST /actions":
          return Response.json(
            await this.enqueue(() => this.applyAction(request)),
          );
        case "GET /connect":
          return this.connectWebSocket(request);
        default:
          return this.jsonError(404, "unknown room endpoint");
      }
    } catch (error) {
      return this.handleError(error);
    }
  }

  async alarm(): Promise<void> {
    await this.enqueue(() => this.handleAlarm());
  }

  private async handleAlarm(): Promise<void> {
    let meta: RoomMeta;
    try {
      meta = await this.meta();
    } catch (error) {
      if (!(error instanceof RoomHttpError) || error.status !== 404)
        throw error;
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.runDueTimers(Date.now());
    meta = await this.meta();
    await this.transferOfflineHost();
    if (this.sockets().length > 0) {
      await this.touch();
      return;
    }
    const expiresAt = (meta.lastActivity ?? 0) + ROOM_IDLE_TTL_MS;
    const hasTimers = await this.hasPendingTimers();
    if (!hasTimers && Date.now() >= expiresAt) {
      this.disposeRuntime();
      this.liveRoomState = undefined;
      this.liveMeta = undefined;
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.scheduleAlarm(expiresAt);
  }

  async webSocketMessage(
    webSocket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    await this.handleWebSocketMessage(webSocket, message);
  }

  private async handleWebSocketMessage(
    webSocket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    let requestId: string | undefined;
    try {
      if (typeof message !== "string")
        throw new RoomHttpError(400, "messages must be JSON text");
      const input = parseJson(message);
      const attachment = this.socketAttachment(webSocket);
      if (!attachment) throw new RoomHttpError(401, "socket has no identity");
      if (isRecord(input) && input.type === "heartbeat") {
        const acknowledgedAttachment = this.acknowledgeLatencyProbe(
          webSocket,
          attachment,
          latencyAckId(input),
        );
        await this.enqueue(() =>
          this.noteSocketSeen(webSocket, acknowledgedAttachment),
        );
        return;
      }
      if (!isRecord(input) || input.type !== "action") {
        throw new RoomHttpError(
          400,
          "expected { type: 'heartbeat' } or { type: 'action', requestId, action }",
        );
      }
      const actionId = validateActionId(input.requestId);
      requestId = actionId;
      const acknowledgedAttachment = this.acknowledgeLatencyProbe(
        webSocket,
        attachment,
        latencyAckId(input),
      );
      const receivedAt = Date.now();
      const response = await this.enqueue(async () => {
        await this.noteSocketSeen(webSocket, acknowledgedAttachment);
        return this.applyActionInput({
          playerId: attachment.playerId,
          actorId: attachment.actorId,
          requestId: actionId,
          action: input.action,
          receivedAt,
        });
      });
      webSocket.send(JSON.stringify(response.result));
    } catch (error) {
      webSocket.send(
        JSON.stringify({
          type: "error",
          error: errorMessage(error),
          ...(requestId ? { requestId } : {}),
        }),
      );
    }
  }

  private async create(request: Request): Promise<RoomLaunch> {
    const input = await parseRequestJson(request);
    if (!isRecord(input) || typeof input.manifestUrl !== "string") {
      throw new RoomHttpError(400, "expected { manifestUrl }");
    }
    const manifestUrl = normalizeManifestUrl(input.manifestUrl);
    const roomId = this.roomId(request);
    const existing = await this.ctx.storage.get<RoomMeta>("roomMeta");
    if (existing !== undefined) {
      throw new RoomHttpError(409, "room has already been created");
    }
    await this.ctx.storage.put("roomMeta", {
      roomId,
      manifestUrl,
      ownerPlayerId: this.playerId(request),
      phase: "lobby",
      presenceRevision: 0,
      ownerLastSeenAt: Date.now(),
      members: {},
    });
    await this.touch();
    return { manifestUrl };
  }

  private async launch(): Promise<RoomLaunch> {
    const { manifestUrl } = await this.meta();
    await this.touch();
    return { manifestUrl };
  }

  private async changeGame(request: Request): Promise<RoomLaunch> {
    await this.launch();
    const playerId = this.playerId(request);
    if (playerId !== (await this.ownerPlayerId()))
      throw new RoomHttpError(403, "only the room host can change the game");
    if ((await this.phase()) !== "lobby")
      throw new RoomHttpError(
        409,
        "the game cannot be changed after it starts",
      );
    const input = await parseRequestJson(request);
    if (!isRecord(input) || typeof input.manifestUrl !== "string")
      throw new RoomHttpError(400, "expected { manifestUrl }");
    const manifestUrl = normalizeManifestUrl(input.manifestUrl);

    this.disposeRuntime();
    this.liveRoomState = undefined;
    this.liveMeta = undefined;
    const meta = await this.meta();
    for (const member of Object.values(meta.members)) {
      delete member.avatarUrl;
      delete member.avatarToken;
    }
    meta.manifestUrl = manifestUrl;
    meta.phase = "lobby";
    meta.config = undefined;
    this.bumpPresenceRevision(meta);
    await this.saveMeta(meta);
    await this.ctx.storage.delete("gameState");
    await this.touch();
    this.broadcast({ type: "game_changed", manifestUrl });
    this.broadcast(await this.presence());
    return { manifestUrl };
  }

  private async initialize(request: Request): Promise<RoomPresence> {
    await this.launch();
    const input = await parseRequestJson(request);
    if (
      !isRecord(input) ||
      typeof input.serverUrl !== "string" ||
      typeof input.gameId !== "string" ||
      typeof input.gameVersion !== "string"
    ) {
      throw new RoomHttpError(
        400,
        "expected { gameId, gameVersion, serverUrl, runtime, minPlayers, maxPlayers, liveRoom? }",
      );
    }
    const meta = await this.meta();
    const gameId = validateGameId(input.gameId, meta.manifestUrl);
    const gameVersion = validateGameVersion(input.gameVersion);
    const serverUrl = validateServerUrl(input.serverUrl, meta.manifestUrl);

    if (typeof input.runtime !== "string" || !isRuntimeKind(input.runtime)) {
      throw new RoomHttpError(400, "runtime must be a supported runtime kind");
    }
    const runtime = input.runtime;

    const minPlayers = validatePlayerLimit(input.minPlayers, "minPlayers");
    const maxPlayers = validatePlayerLimit(input.maxPlayers, "maxPlayers");
    if (minPlayers > maxPlayers)
      throw new RoomHttpError(400, "minPlayers must not exceed maxPlayers");
    const liveRoom = input.liveRoom === true;

    const existing = await this.storedConfig();
    if (existing) {
      if (
        existing.gameId !== gameId ||
        existing.gameVersion !== gameVersion ||
        existing.serverUrl !== serverUrl ||
        existing.runtime !== runtime ||
        existing.minPlayers !== minPlayers ||
        existing.maxPlayers !== maxPlayers ||
        existing.liveRoom !== liveRoom
      ) {
        throw new RoomHttpError(
          409,
          "room is already initialized with a different game configuration",
        );
      }
      return this.presence();
    }

    const script = await fetchServerSource(
      serverUrl,
      new URL(request.url).origin,
      this.bindings.ASSETS,
    );
    const scriptHash = await hash(script);
    const engine = await createRuntime(runtime, script);
    try {
      // Compile once now so an invalid script fails before anybody joins.
      // setup() runs only after the platform locks the roster at game start.
      meta.config = {
        gameId,
        gameVersion,
        serverUrl,
        runtime,
        script,
        scriptHash,
        minPlayers,
        maxPlayers,
        liveRoom,
      };
      this.bumpPresenceRevision(meta);
      await this.saveMeta(meta);
      await this.touch();
      return this.presence();
    } catch (error) {
      throw error;
    } finally {
      engine.dispose();
    }
  }

  private async join(
    request: Request,
  ): Promise<RoomPresence & { selfId: string }> {
    await this.launch();
    const config = await this.config();
    const playerId = this.playerId(request);
    const phase = await this.phase();
    const members = await this.members();
    const existing = members[playerId];
    const name = this.playerName(request);
    let membershipChanged = false;
    if (!existing) {
      if (phase === "playing")
        throw new RoomHttpError(403, "the game has already started");
      const occupiedSeats = new Set(
        Object.values(members)
          .map((member) => member.seat)
          .filter((seat): seat is number => typeof seat === "number"),
      );
      const seat = Array.from(
        { length: config.maxPlayers },
        (_, index) => index + 1,
      ).find((number) => !occupiedSeats.has(number));
      members[playerId] = {
        actorId: await this.actorId(request),
        ...(name ? { name } : {}),
        joinedAt: Date.now(),
        seat,
        ready: false,
      };
      membershipChanged = true;
    } else if (phase === "lobby") {
      if (existing.name !== name) {
        if (name) existing.name = name;
        else delete existing.name;
        membershipChanged = true;
      }
    }
    if (membershipChanged) {
      const ownerPlayerId = await this.ownerPlayerId();
      if (members[ownerPlayerId]) {
        await this.saveMembers(members);
      } else {
        const nextOwnerPlayerId = this.nextOwnerPlayerId(members);
        this.ensureOwnerSeat(nextOwnerPlayerId, members, config.maxPlayers);
        await this.saveMembershipAndOwnership(members, nextOwnerPlayerId);
      }
      await this.touch();
      this.broadcast(await this.presence());
    }
    return { ...(await this.presence()), selfId: members[playerId]!.actorId };
  }

  private async start(request: Request): Promise<RoomStart> {
    await this.launch();
    const playerId = this.playerId(request);
    if (playerId !== (await this.ownerPlayerId()))
      throw new RoomHttpError(403, "only the room host can start the game");
    if ((await this.phase()) !== "lobby")
      throw new RoomHttpError(409, "the game has already started");

    const [config, members] = await Promise.all([
      this.config(),
      this.members(),
    ]);
    const players = Object.values(members)
      .filter((member) => member.seat !== undefined)
      .sort((a, b) => a.seat! - b.seat!)
      .map((member) => ({
        id: member.actorId,
        ...(member.name ? { name: member.name } : {}),
        seat: member.seat!,
      }));
    if (players.length < config.minPlayers)
      throw new RoomHttpError(
        409,
        `waiting for at least ${config.minPlayers} players`,
      );
    const ownerPlayerId = await this.ownerPlayerId();
    if (
      Object.entries(members).some(
        ([id, member]) =>
          id !== ownerPlayerId && member.seat !== undefined && !member.ready,
      )
    ) {
      throw new RoomHttpError(409, "waiting for all players to get ready");
    }
    const engine = await this.engine(config);
    const startedAt = Date.now();
    const match = {
      id: `match_${crypto.randomUUID().replaceAll("-", "")}`,
      startedAt,
      randomSeed: secureRandomSeed(),
    };
    const setup = engine.setup({
      protocolVersion: GAME_PROTOCOL_VERSION,
      serverTime: startedAt,
      match: {
        id: match.id,
        ownerId: members[ownerPlayerId]!.actorId,
        startedAt: match.startedAt,
        randomSeed: match.randomSeed,
      },
      players,
    });
    assertJsonSize(setup.state, "initial state", MAX_STATE_BYTES);
    this.assertTimerSupport(config, setup.timerOps ?? []);
    const timers = this.applyTimerOps([], setup.timerOps ?? [], startedAt);
    const snapshot: RoomSnapshot = {
      type: "snapshot",
      state: setup.state,
      events: setup.events,
      matchId: match.id,
      version: 0,
      serverTime: startedAt,
      scriptHash: config.scriptHash,
    };
    const visibleSnapshot = this.snapshotForViewer(
      snapshot,
      this.gameActor(members[playerId]!, true),
      engine,
    );
    const messages = this.prepareStateBroadcast(
      snapshot,
      engine,
      members,
      ownerPlayerId,
    );
    const meta = await this.meta();
    meta.phase = "playing";
    this.bumpPresenceRevision(meta);
    await this.saveMeta(meta);
    const presence = await this.presence();
    await this.saveRoomState({
      state: setup.state,
      version: 0,
      match,
      recentActions: [],
      timers,
      timerBudget: initialTimerBudget(startedAt),
    });
    await this.touch();
    this.broadcast(presence);
    this.sendPreparedBroadcast(messages);
    return { presence, snapshot: visibleSnapshot };
  }

  private async kick(request: Request): Promise<RoomPresence> {
    await this.launch();
    const playerId = this.playerId(request);
    if (playerId !== (await this.ownerPlayerId()))
      throw new RoomHttpError(403, "only the room host can remove players");
    if ((await this.phase()) !== "lobby")
      throw new RoomHttpError(
        409,
        "players cannot be removed after the game starts",
      );
    const input = await parseRequestJson(request);
    if (!isRecord(input) || typeof input.playerId !== "string")
      throw new RoomHttpError(400, "expected { playerId }");

    const members = await this.members();
    const target = Object.entries(members).find(
      ([, member]) => member.actorId === input.playerId,
    );
    if (!target) throw new RoomHttpError(404, "player is not in this room");
    if (target[0] === playerId)
      throw new RoomHttpError(409, "the room host cannot remove themselves");
    delete members[target[0]];
    await this.saveMembers(members);
    await this.touch();
    for (const socket of this.sockets()) {
      const attachment = this.socketAttachment(socket);
      if (attachment?.playerId !== target[0]) continue;
      try {
        socket.send(
          JSON.stringify({
            type: "error",
            error: "you were removed from the room",
          }),
        );
        socket.close(4003, "removed from room");
      } catch {
        // The peer may have disconnected while the host was removing them.
      }
    }
    const presence = await this.presence();
    this.broadcast(presence);
    return presence;
  }

  private async transferHost(request: Request): Promise<RoomPresence> {
    await this.launch();
    const playerId = this.playerId(request);
    if (playerId !== (await this.ownerPlayerId()))
      throw new RoomHttpError(403, "only the room host can transfer ownership");
    if ((await this.phase()) !== "lobby")
      throw new RoomHttpError(
        409,
        "room ownership cannot be transferred after the game starts",
      );
    const input = await parseRequestJson(request);
    if (!isRecord(input) || typeof input.playerId !== "string")
      throw new RoomHttpError(400, "expected { playerId }");

    const members = await this.members();
    const target = Object.entries(members).find(
      ([, member]) => member.actorId === input.playerId,
    );
    if (!target) throw new RoomHttpError(404, "player is not in this room");
    if (target[0] === playerId)
      throw new RoomHttpError(409, "the room host already owns this room");
    if (target[1].seat === undefined)
      throw new RoomHttpError(409, "the new room host must be seated");

    target[1].ready = false;
    await this.saveOwnership(target[0], members);
    this.updateSocketOwnership(target[0]);
    await this.touch();
    const presence = await this.presence();
    this.broadcast(presence);
    return presence;
  }

  private async dissolve(request: Request): Promise<{ dissolved: true }> {
    const playerId = this.playerId(request);
    if (playerId !== (await this.ownerPlayerId())) {
      throw new RoomHttpError(403, "only the room host can dissolve the room");
    }
    if ((await this.phase()) !== "lobby") {
      throw new RoomHttpError(
        409,
        "the room can only be dissolved from the lobby",
      );
    }

    this.broadcast({
      type: "room_dissolved",
      error: "The room was dissolved by the host",
    });
    this.closeRoomSockets(4004, "room dissolved");
    this.liveRoomState = undefined;
    this.liveMeta = undefined;
    await this.ctx.storage.deleteAll();
    return { dissolved: true };
  }

  private async returnToRoom(request: Request): Promise<RoomPresence> {
    await this.launch();
    const playerId = this.playerId(request);
    if (playerId !== (await this.ownerPlayerId())) {
      throw new RoomHttpError(
        403,
        "only the room host can return the room to the lobby",
      );
    }
    if ((await this.phase()) !== "playing") {
      throw new RoomHttpError(409, "the room is already in the lobby");
    }
    await this.runDueTimers(Date.now());

    const [config, room, members, ownerPlayerId] = await Promise.all([
      this.config(),
      this.roomState(),
      this.members(),
      this.ownerPlayerId(),
    ]);
    const engine = await this.engine(config);
    const serverTime = Date.now();
    const currentMeta = await this.meta();
    const allowed = currentMeta.fault
      ? true
      : engine.returnToRoom(room.state, {
          protocolVersion: GAME_PROTOCOL_VERSION,
          matchId: room.match.id,
          version: room.version,
          serverTime,
          actor: this.gameActor(members[playerId]!, playerId === ownerPlayerId),
        });
    if (!allowed) {
      throw new RoomHttpError(
        409,
        "the game does not allow returning to the room yet",
      );
    }

    for (const [memberId, member] of Object.entries(members)) {
      if (memberId !== playerId) member.ready = false;
    }
    this.ensureOwnerSeat(ownerPlayerId, members, config.maxPlayers);
    this.disposeRuntime();
    const meta = await this.meta();
    meta.phase = "lobby";
    meta.members = members;
    delete meta.fault;
    this.bumpPresenceRevision(meta);
    await this.saveMeta(meta);
    await this.clearRoomState(config);
    await this.touch();
    const presence = await this.presence();
    this.broadcast(presence);
    return presence;
  }

  private async leave(request: Request): Promise<RoomLeave> {
    await this.launch();
    const playerId = this.playerId(request);
    const [phase, members, ownerPlayerId] = await Promise.all([
      this.phase(),
      this.members(),
      this.ownerPlayerId(),
    ]);
    const member = members[playerId];
    if (!member) throw new RoomHttpError(404, "player is not in this room");
    const ownerLeft = playerId === ownerPlayerId;
    if (Object.keys(members).length === 1) {
      this.closePlayerSockets(playerId);
      await this.deleteEmptyRoom();
      return { left: true, roomClosed: true };
    }

    if (phase === "lobby") {
      delete members[playerId];
      this.closePlayerSockets(playerId);
      const nextOwnerPlayerId = ownerLeft
        ? this.nextOwnerPlayerId(members)
        : ownerPlayerId;
      if (ownerLeft) {
        this.ensureOwnerSeat(
          nextOwnerPlayerId,
          members,
          (await this.config()).maxPlayers,
        );
      }
      await this.saveMembershipAndOwnership(members, nextOwnerPlayerId);
      await this.touch();
      const presence = await this.presence();
      this.broadcast(presence);
      return { left: true, roomClosed: false };
    }

    await this.runDueTimers(Date.now());

    const [config, room] = await Promise.all([this.config(), this.roomState()]);
    const engine = await this.engine(config);
    const leftAt = Date.now();
    const result = engine.playerLeft(room.state, {
      protocolVersion: GAME_PROTOCOL_VERSION,
      matchId: room.match.id,
      version: room.version,
      leftAt,
      serverTime: leftAt,
      actor: this.gameActor(member, playerId === ownerPlayerId),
    });
    const version = room.version + 1;
    const snapshot: RoomSnapshot = {
      type: "snapshot",
      state: result.state,
      events: result.events,
      matchId: room.match.id,
      version,
      serverTime: leftAt,
      scriptHash: config.scriptHash,
    };
    delete members[playerId];
    this.closePlayerSockets(playerId);
    const nextOwnerPlayerId = ownerLeft
      ? this.nextOwnerPlayerId(members)
      : ownerPlayerId;
    if (ownerLeft) members[nextOwnerPlayerId]!.ready = false;
    const messages = this.prepareStateBroadcast(
      snapshot,
      engine,
      members,
      nextOwnerPlayerId,
    );
    this.assertTimerSupport(config, result.timerOps ?? []);
    await this.saveRoomState({
      ...room,
      state: result.state,
      version,
      timers: this.applyTimerOps(room.timers, result.timerOps ?? [], leftAt),
    });
    await this.saveMembershipAndOwnership(members, nextOwnerPlayerId);
    await this.touch();
    this.broadcast(await this.presence());
    this.sendPreparedBroadcast(messages);
    return { left: true, roomClosed: false };
  }

  private async setSeat(request: Request): Promise<RoomPresence> {
    await this.launch();
    if ((await this.phase()) !== "lobby")
      throw new RoomHttpError(
        409,
        "seats cannot be changed after the game starts",
      );
    const input = await parseRequestJson(request);
    if (
      !isRecord(input) ||
      (input.seat !== null &&
        (!Number.isInteger(input.seat) || typeof input.seat !== "number"))
    ) {
      throw new RoomHttpError(400, "expected { seat: number | null }");
    }
    const playerId = this.playerId(request);
    const [config, members, ownerPlayerId] = await Promise.all([
      this.config(),
      this.members(),
      this.ownerPlayerId(),
    ]);
    const member = members[playerId];
    if (!member)
      throw new RoomHttpError(403, "join the room before choosing a seat");
    if (input.seat === null) {
      if (playerId === ownerPlayerId)
        throw new RoomHttpError(409, "the room host must keep a seat");
      member.seat = undefined;
    } else {
      if (input.seat < 1 || input.seat > config.maxPlayers)
        throw new RoomHttpError(400, "seat is outside this room");
      if (
        Object.entries(members).some(
          ([id, candidate]) => id !== playerId && candidate.seat === input.seat,
        )
      )
        throw new RoomHttpError(409, "that seat is already taken");
      member.seat = input.seat;
    }
    member.ready = false;
    await this.saveMembers(members);
    await this.touch();
    const presence = await this.presence();
    this.broadcast(presence);
    return presence;
  }

  private async setReady(request: Request): Promise<RoomPresence> {
    await this.launch();
    if ((await this.phase()) !== "lobby")
      throw new RoomHttpError(
        409,
        "readiness cannot be changed after the game starts",
      );
    const input = await parseRequestJson(request);
    if (!isRecord(input) || typeof input.ready !== "boolean")
      throw new RoomHttpError(400, "expected { ready: boolean }");
    const playerId = this.playerId(request);
    const [members, ownerPlayerId] = await Promise.all([
      this.members(),
      this.ownerPlayerId(),
    ]);
    const member = members[playerId];
    if (!member?.seat)
      throw new RoomHttpError(409, "spectators cannot get ready");
    if (playerId === ownerPlayerId)
      throw new RoomHttpError(409, "the room host does not need to get ready");
    member.ready = input.ready;
    await this.saveMembers(members);
    await this.touch();
    const presence = await this.presence();
    this.broadcast(presence);
    return presence;
  }

  private async setProfileAvatar(request: Request): Promise<RoomPresence> {
    await this.launch();
    const input = await parseRequestJson(request);
    if (!isRecord(input) || typeof input.shared !== "boolean") {
      throw new RoomHttpError(400, "expected { shared: boolean }");
    }
    const playerId = this.playerId(request);
    const members = await this.members();
    const member = members[playerId];
    if (!member) {
      throw new RoomHttpError(
        403,
        "join the room before sharing a profile avatar",
      );
    }
    const avatarUrl = input.shared ? this.playerAvatarUrl(request) : undefined;
    const unchanged = avatarUrl
      ? member.avatarUrl === avatarUrl && Boolean(member.avatarToken)
      : !member.avatarUrl && !member.avatarToken;
    if (unchanged) return this.presence();

    if (avatarUrl) {
      member.avatarUrl = avatarUrl;
      member.avatarToken = randomAvatarToken();
    } else {
      delete member.avatarUrl;
      delete member.avatarToken;
    }
    await this.saveMembers(members);
    await this.touch();
    const presence = await this.presence();
    this.broadcast(presence);
    return presence;
  }

  private async applyAction(request: Request): Promise<object> {
    const input = await parseRequestJson(request);
    if (!isRecord(input) || !("action" in input)) {
      throw new RoomHttpError(400, "expected { requestId, action }");
    }
    const playerId = this.playerId(request);
    const actorId = await this.memberActorId(playerId);
    await this.notePlayerSeen(playerId);
    const receivedAt = Date.now();
    return this.applyActionInput({
      playerId,
      actorId,
      requestId: validateActionId(input.requestId),
      action: input.action,
      receivedAt,
    });
  }

  private async applyActionInput(input: {
    playerId: string;
    actorId: string;
    requestId: string;
    action: unknown;
    receivedAt: number;
  }): Promise<RoomActionResponse> {
    if (!input.actorId || input.actorId.length > MAX_PLAYER_ID_LENGTH) {
      throw new RoomHttpError(
        400,
        `actorId must be 1-${MAX_PLAYER_ID_LENGTH} characters`,
      );
    }
    if ((await this.phase()) !== "playing")
      throw new RoomHttpError(409, "the game has not started");
    if ((await this.memberActorId(input.playerId)) !== input.actorId) {
      throw new RoomHttpError(403, "player is not in this game");
    }
    if ((await this.meta()).fault) {
      throw new RoomHttpError(409, "the game is paused after a timer error");
    }
    await this.runDueTimers(input.receivedAt);
    if ((await this.meta()).fault) {
      throw new RoomHttpError(409, "the game is paused after a timer error");
    }
    assertJson(input.action, "action");
    assertJsonSize(input.action, "action", MAX_ACTION_BYTES);

    const [config, room, meta] = await Promise.all([
      this.config(),
      this.roomState(),
      this.meta(),
    ]);
    const actionHash = await hash(canonicalJson(input.action));
    const previous = room.recentActions.find(
      (item) =>
        item.actorId === input.actorId && item.requestId === input.requestId,
    );
    if (previous) {
      if (previous.actionHash !== actionHash) {
        throw new RoomHttpError(
          409,
          "requestId was already used for a different action",
        );
      }
      return { result: previous.result };
    }

    const engine = await this.engine(config);
    const member = meta.members[input.playerId]!;
    const serverTime = Date.now();
    const result = engine.applyAction(room.state, input.action, {
      protocolVersion: GAME_PROTOCOL_VERSION,
      matchId: room.match.id,
      actionId: input.requestId,
      actionAt: input.receivedAt,
      serverTime,
      version: room.version,
      actor: this.gameActor(member, input.playerId === meta.ownerPlayerId),
    });
    if (!result.accepted) {
      const actionResult: RoomActionResult = {
        type: "action-result",
        requestId: input.requestId,
        accepted: false,
        matchId: room.match.id,
        version: room.version,
        error: result.error,
      };
      await this.saveRoomState({
        ...room,
        recentActions: this.rememberAction(room, {
          actorId: input.actorId,
          requestId: input.requestId,
          actionHash,
          result: actionResult,
        }),
      });
      await this.touch();
      return { result: actionResult };
    }

    const version = room.version + 1;
    const update: RoomSnapshot = {
      type: "state",
      state: result.state,
      events: result.events,
      matchId: room.match.id,
      version,
      serverTime,
      scriptHash: config.scriptHash,
    };
    const visibleUpdate = this.snapshotForViewer(
      update,
      this.gameActor(member, input.playerId === meta.ownerPlayerId),
      engine,
    );
    const messages = this.prepareStateBroadcast(
      update,
      engine,
      meta.members,
      meta.ownerPlayerId,
    );
    const actionResult: RoomActionResult = {
      type: "action-result",
      requestId: input.requestId,
      accepted: true,
      matchId: room.match.id,
      version,
    };
    this.assertTimerSupport(config, result.timerOps ?? []);
    await this.saveRoomState({
      ...room,
      state: result.state,
      version,
      timers: this.applyTimerOps(
        room.timers,
        result.timerOps ?? [],
        serverTime,
      ),
      recentActions: this.rememberAction(room, {
        actorId: input.actorId,
        requestId: input.requestId,
        actionHash,
        result: actionResult,
      }),
    });
    await this.touch();
    this.sendPreparedBroadcast(messages);
    return { result: actionResult, update: visibleUpdate };
  }

  /**
   * Alarms are best-effort, so every action also drains timers that were due
   * when its request reached the room. This prevents a late alarm from letting
   * an action bypass an authoritative deadline.
   */
  private async runDueTimers(cutoffAt: number): Promise<void> {
    if ((await this.phase()) !== "playing") return;
    const config = await this.config();
    if (config.liveRoom) return;

    for (let count = 0; count < 16; count += 1) {
      const [room, meta] = await Promise.all([this.roomState(), this.meta()]);
      const timer = room.timers
        .filter((candidate) => candidate.dueAt <= cutoffAt)
        .sort(compareTimers)[0];
      if (!timer) return;

      const firedAt = Date.now();
      const budget = consumeTimerBudget(room.timerBudget, firedAt);
      if (!budget.allowed) {
        await this.saveRoomState({
          ...room,
          timers: room.timers
            .map((candidate) =>
              candidate.id === timer.id
                ? { ...candidate, dueAt: budget.nextAllowedAt }
                : candidate,
            )
            .sort(compareTimers),
          timerBudget: budget.budget,
        });
        await this.scheduleAlarm();
        return;
      }

      const engine = await this.engine(config);
      let result;
      try {
        result = engine.onTimer(
          room.state,
          {
            id: timer.id,
            ...(timer.payload === undefined ? {} : { payload: timer.payload }),
          },
          {
            protocolVersion: GAME_PROTOCOL_VERSION,
            matchId: room.match.id,
            version: room.version,
            dueAt: timer.dueAt,
            firedAt,
            lateByMs: Math.max(0, firedAt - timer.dueAt),
          },
        );
      } catch (error) {
        if (!(error instanceof GameRuntimeError)) throw error;
        await this.pauseForTimerError(room, error, firedAt);
        return;
      }
      const version = room.version + 1;
      const snapshot: RoomSnapshot = {
        type: "state",
        state: result.state,
        events: result.events,
        matchId: room.match.id,
        version,
        serverTime: firedAt,
        scriptHash: config.scriptHash,
      };
      const messages = this.prepareStateBroadcast(
        snapshot,
        engine,
        meta.members,
        meta.ownerPlayerId,
      );
      let timers: RoomTimer[];
      try {
        timers = this.applyTimerOps(
          room.timers.filter((candidate) => candidate.id !== timer.id),
          result.timerOps ?? [],
          firedAt,
        );
      } catch (error) {
        if (!(error instanceof GameRuntimeError)) throw error;
        await this.pauseForTimerError(room, error, firedAt);
        return;
      }
      await this.saveRoomState({
        ...room,
        state: result.state,
        version,
        timers,
        timerBudget: budget.budget,
      });
      await this.touch();
      this.sendPreparedBroadcast(messages);
    }
  }

  private applyTimerOps(
    existing: RoomTimer[],
    operations: GameTimerOperation[],
    scheduledAt: number,
  ): RoomTimer[] {
    const timers = new Map(existing.map((timer) => [timer.id, timer]));
    for (const operation of operations) {
      if (operation.op === "cancel") {
        timers.delete(operation.id);
        continue;
      }
      if (operation.payload !== undefined) {
        assertJsonSize(
          operation.payload,
          `timer ${operation.id} payload`,
          MAX_TIMER_PAYLOAD_BYTES,
        );
      }
      timers.set(operation.id, {
        id: operation.id,
        dueAt: scheduledAt + operation.afterMs,
        ...(operation.payload === undefined
          ? {}
          : { payload: operation.payload }),
      });
    }
    if (timers.size > MAX_PENDING_TIMERS) {
      throw new GameRuntimeError(
        `a room may have at most ${MAX_PENDING_TIMERS} pending timers`,
      );
    }
    const result = [...timers.values()].sort(compareTimers);
    const payloadBytes = result.reduce(
      (total, timer) =>
        total +
        (timer.payload === undefined
          ? 0
          : new TextEncoder().encode(JSON.stringify(timer.payload)).byteLength),
      0,
    );
    if (payloadBytes > MAX_TIMER_PAYLOAD_TOTAL_BYTES) {
      throw new GameRuntimeError(
        `timer payloads exceed the ${MAX_TIMER_PAYLOAD_TOTAL_BYTES}-byte room limit`,
      );
    }
    return result;
  }

  private assertTimerSupport(
    config: RoomConfig,
    operations: GameTimerOperation[],
  ): void {
    if (config.liveRoom && operations.length > 0) {
      throw new GameRuntimeError(
        "timerOps require persisted room storage; live rooms cannot schedule timers",
      );
    }
  }

  private async pauseForTimerError(
    room: RoomState,
    error: GameRuntimeError,
    at: number,
  ): Promise<void> {
    const meta = await this.meta();
    meta.fault = { message: error.message.slice(0, 500), at };
    await this.saveMeta(meta);
    await this.saveRoomState({ ...room, timers: [] });
    this.disposeRuntime();
    this.broadcast({
      type: "error",
      error: "The game was paused because a scheduled event failed",
    });
    await this.scheduleAlarm();
  }

  private async hasPendingTimers(): Promise<boolean> {
    if ((await this.phase()) !== "playing") return false;
    const config = await this.config();
    if (config.liveRoom) return false;
    return (await this.roomState()).timers.length > 0;
  }

  private async nextTimerAt(): Promise<number> {
    if ((await this.phase()) !== "playing") return Number.POSITIVE_INFINITY;
    const config = await this.config();
    if (config.liveRoom) return Number.POSITIVE_INFINITY;
    return (
      (await this.roomState()).timers[0]?.dueAt ?? Number.POSITIVE_INFINITY
    );
  }

  private async snapshot(actorId: string): Promise<RoomSnapshot> {
    await this.runDueTimers(Date.now());
    const [config, room, meta] = await Promise.all([
      this.config(),
      this.roomState(),
      this.meta(),
    ]);
    const snapshot: RoomSnapshot = {
      type: "snapshot",
      state: room.state,
      matchId: room.match.id,
      version: room.version,
      serverTime: Date.now(),
      scriptHash: config.scriptHash,
    };
    return this.snapshotForViewer(
      snapshot,
      this.viewerForActor(actorId, meta.members, meta.ownerPlayerId),
      await this.engine(config),
    );
  }

  private async stateFor(request: Request): Promise<RoomSnapshot> {
    const actorId = await this.memberActorId(this.playerId(request));
    if ((await this.phase()) !== "playing")
      throw new RoomHttpError(409, "the game has not started");
    return this.snapshot(actorId);
  }

  private async connectWebSocket(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      throw new RoomHttpError(426, "expected WebSocket upgrade");
    }
    const { attachment, liveRoom } = await this.enqueue(async () => {
      await this.launch();
      const config = await this.config();
      const playerId = this.playerId(request);
      const now = Date.now();
      const attachment = {
        playerId,
        actorId: await this.memberActorId(playerId),
        lastSeenAt: now,
        isOwner: playerId === (await this.ownerPlayerId()),
      } satisfies SocketAttachment;
      if (attachment.isOwner) {
        await this.recordOwnerSeen(now);
        await this.scheduleAlarm(undefined, now, true);
      }
      return { attachment, liveRoom: config.liveRoom };
    });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    if (liveRoom) {
      this.acceptLiveWebSocket(server, attachment);
    } else {
      this.acceptHibernatingWebSocket(server, attachment);
    }
    this.sendInitialSocketMessage(server, attachment.actorId);
    return new Response(null, { status: 101, webSocket: client });
  }

  private acceptLiveWebSocket(
    server: WebSocket,
    attachment: SocketAttachment,
  ): void {
    server.accept();
    this.liveSockets.add(server);
    this.liveSocketAttachments.set(server, attachment);
    server.addEventListener("message", (event) => {
      void this.handleWebSocketMessage(server, event.data);
    });
    const cleanup = () => {
      this.liveSockets.delete(server);
      this.liveSocketAttachments.delete(server);
    };
    server.addEventListener("close", cleanup);
    server.addEventListener("error", cleanup);
  }

  private acceptHibernatingWebSocket(
    server: WebSocket,
    attachment: SocketAttachment,
  ): void {
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);
  }

  private sendInitialSocketMessage(server: WebSocket, actorId: string): void {
    this.ctx.waitUntil(
      this.enqueue(async () => {
        try {
          const presence = await this.presence();
          server.send(JSON.stringify(presence));
          if (presence.phase === "playing") {
            server.send(JSON.stringify(await this.snapshot(actorId)));
          }
        } catch (error) {
          server.send(
            JSON.stringify({ type: "error", error: errorMessage(error) }),
          );
        }
      }),
    );
  }

  private async config(): Promise<RoomConfig> {
    const config = await this.storedConfig();
    if (!config) {
      throw new RoomHttpError(
        409,
        "room has no valid game runtime; initialize it first",
      );
    }
    return config;
  }

  private async storedConfig(): Promise<RoomConfig | undefined> {
    return (await this.meta()).config;
  }

  private async roomState(): Promise<RoomState> {
    const config = await this.config();
    if (config.liveRoom) {
      if (this.liveRoomState !== undefined) return this.liveRoomState;
      throw new RoomHttpError(409, "room has no live state; start it first");
    }
    const stored = await this.ctx.storage.get<RoomState>("gameState");
    if (stored !== undefined) {
      return {
        ...stored,
        timers: stored.timers ?? [],
        timerBudget: stored.timerBudget ?? initialTimerBudget(Date.now()),
      };
    }
    throw new RoomHttpError(
      409,
      "room has no persisted state; start a new match first",
    );
  }

  private async saveRoomState(room: RoomState): Promise<void> {
    const config = await this.config();
    if (config.liveRoom) {
      this.liveRoomState = room;
      return;
    }
    await this.ctx.storage.put("gameState", room);
  }

  private async clearRoomState(config?: RoomConfig): Promise<void> {
    const roomConfig = config ?? (await this.config());
    if (roomConfig.liveRoom) {
      this.liveRoomState = undefined;
      this.liveMeta = undefined;
      return;
    }
    await this.ctx.storage.delete("gameState");
  }

  private async meta(): Promise<RoomMeta> {
    // All room mutations are serialized; return a copy so callers cannot mutate the cache.
    if (this.liveMeta) return structuredClone(this.liveMeta);
    const stored = await this.ctx.storage.get<RoomMeta>("roomMeta");
    if (stored === undefined)
      throw new RoomHttpError(404, "room does not exist");
    if (stored.config?.liveRoom) this.liveMeta = structuredClone(stored);
    return stored;
  }

  private async saveMeta(meta: RoomMeta): Promise<void> {
    await this.ctx.storage.put("roomMeta", meta);
    this.liveMeta = meta.config?.liveRoom ? structuredClone(meta) : undefined;
    this.liveMetaSavedAt = Date.now();
  }

  private async saveActivity(meta: RoomMeta): Promise<void> {
    if (!meta.config?.liveRoom) return this.saveMeta(meta);
    this.liveMeta = structuredClone(meta);
    // Only activity timestamps may be delayed. Membership/config/lifecycle still use saveMeta.
    // A reset can lose at most one second of presence; the live match itself is non-durable.
    if (Date.now() - this.liveMetaSavedAt >= LIVE_ACTIVITY_FLUSH_MS) await this.saveMeta(meta);
  }

  private async saveMembers(
    members: Record<string, RoomMember>,
  ): Promise<void> {
    const meta = await this.meta();
    meta.members = members;
    this.bumpPresenceRevision(meta);
    await this.saveMeta(meta);
  }

  private async saveOwnership(
    ownerPlayerId: string,
    members: Record<string, RoomMember>,
  ): Promise<void> {
    const meta = await this.meta();
    meta.ownerPlayerId = ownerPlayerId;
    meta.members = members;
    meta.ownerLastSeenAt =
      this.socketLastSeenByPlayer().get(ownerPlayerId) ?? Date.now();
    this.bumpPresenceRevision(meta);
    await this.saveMeta(meta);
  }

  private async saveMembershipAndOwnership(
    members: Record<string, RoomMember>,
    ownerPlayerId: string,
  ): Promise<void> {
    const meta = await this.meta();
    meta.members = members;
    meta.ownerPlayerId = ownerPlayerId;
    meta.ownerLastSeenAt =
      this.socketLastSeenByPlayer().get(ownerPlayerId) ?? Date.now();
    this.bumpPresenceRevision(meta);
    await this.saveMeta(meta);
    this.updateSocketOwnership(ownerPlayerId);
  }

  private nextOwnerPlayerId(members: Record<string, RoomMember>): string {
    const joined = Object.entries(members).sort(
      ([, left], [, right]) => left.joinedAt - right.joinedAt,
    );
    const nextOwner =
      joined.find(([, member]) => member.seat !== undefined) ?? joined[0];
    if (!nextOwner) {
      throw new RoomHttpError(409, "the room has no remaining owner");
    }
    return nextOwner[0];
  }

  private ensureOwnerSeat(
    ownerPlayerId: string,
    members: Record<string, RoomMember>,
    maxPlayers: number,
  ): void {
    const owner = members[ownerPlayerId];
    if (!owner || owner.seat !== undefined) return;
    const occupiedSeats = new Set(
      Object.values(members)
        .map((member) => member.seat)
        .filter((seat): seat is number => seat !== undefined),
    );
    const seat = Array.from(
      { length: maxPlayers },
      (_, index) => index + 1,
    ).find((candidate) => !occupiedSeats.has(candidate));
    if (seat === undefined) {
      throw new RoomHttpError(409, "the room host has no available seat");
    }
    owner.seat = seat;
    owner.ready = false;
  }

  private async deleteEmptyRoom(): Promise<void> {
    this.closeRoomSockets(4004, "room empty");
    this.disposeRuntime();
    this.liveRoomState = undefined;
    this.liveMeta = undefined;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  private bumpPresenceRevision(meta: RoomMeta): void {
    meta.presenceRevision = (meta.presenceRevision ?? 0) + 1;
  }

  private async engine(config: RoomConfig): Promise<GameRuntime> {
    if (
      this.runtime?.kind === config.runtime &&
      this.runtime.scriptHash === config.scriptHash
    )
      return this.runtime.engine;
    this.disposeRuntime();
    const engine = await createRuntime(config.runtime, config.script);
    this.runtime = {
      kind: config.runtime,
      scriptHash: config.scriptHash,
      engine,
    };
    return engine;
  }

  private disposeRuntime(): void {
    this.runtime?.engine.dispose();
    this.runtime = undefined;
  }

  private async touch(): Promise<void> {
    const now = Date.now();
    const meta = await this.meta();
    meta.lastActivity = now;
    await this.saveActivity(meta);
    await this.transferOfflineHost();
    await this.scheduleAlarm(now + ROOM_IDLE_TTL_MS, undefined, meta.config?.liveRoom === true);
  }

  private async recordOwnerSeen(seenAt: number): Promise<void> {
    const meta = await this.meta();
    if (seenAt <= (meta.ownerLastSeenAt ?? 0)) return;
    meta.ownerLastSeenAt = seenAt;
    await this.saveActivity(meta);
  }

  private async noteSocketSeen(
    webSocket: WebSocket,
    attachment: SocketAttachment,
  ): Promise<void> {
    const now = Date.now();
    const currentAttachment = this.socketAttachment(webSocket) ?? attachment;
    const updatedAttachment = { ...currentAttachment, lastSeenAt: now };
    this.saveSocketAttachment(webSocket, updatedAttachment);
    if (currentAttachment.isOwner) {
      await this.recordOwnerSeen(now);
      await this.scheduleAlarm(undefined, now, true);
    }
  }

  /**
   * HTTP game actions prove that their authenticated player is still present,
   * even though durable rooms deliver the action over HTTP rather than the
   * room WebSocket. Refresh every socket for that player so an active tab can
   * still take over from an offline host.
   */
  private async notePlayerSeen(playerId: string): Promise<void> {
    const now = Date.now();
    for (const socket of this.sockets()) {
      const attachment = this.socketAttachment(socket);
      if (attachment?.playerId !== playerId) continue;
      this.saveSocketAttachment(socket, { ...attachment, lastSeenAt: now });
    }
    if (playerId === (await this.ownerPlayerId())) {
      await this.recordOwnerSeen(now);
      await this.scheduleAlarm(undefined, now, true);
    }
  }

  private acknowledgeLatencyProbe(
    webSocket: WebSocket,
    attachment: SocketAttachment,
    ackId: string | undefined,
  ): SocketAttachment {
    if (!ackId) return attachment;
    const now = Date.now();
    if (
      attachment.lastLatencyAckAt !== undefined &&
      now - attachment.lastLatencyAckAt < MIN_LATENCY_ACK_INTERVAL_MS
    )
      return attachment;
    const updatedAttachment = {
      ...attachment,
      lastLatencyAckAt: now,
    };
    webSocket.send(JSON.stringify({ type: "platform.ack", ackId }));
    this.saveSocketAttachment(webSocket, updatedAttachment);
    return updatedAttachment;
  }

  private async transferOfflineHost(
    knownMembers?: Record<string, RoomMember>,
  ): Promise<void> {
    const meta = await this.meta();
    const ownerPlayerId = meta.ownerPlayerId;
    const members = knownMembers ?? meta.members;
    const lastSeenByPlayer = this.socketLastSeenByPlayer();
    const ownerLastSeenAt = Math.max(
      lastSeenByPlayer.get(ownerPlayerId) ?? 0,
      meta.ownerLastSeenAt ?? 0,
    );
    if (ownerLastSeenAt === 0) {
      // Rooms created before ownerLastSeenAt was introduced get one full grace
      // period rather than being treated as immediately abandoned on upgrade.
      const seenAt = Date.now();
      meta.ownerLastSeenAt = seenAt;
      await this.saveMeta(meta);
      await this.scheduleAlarm(undefined, seenAt);
      return;
    }
    if (
      ownerLastSeenAt !== undefined &&
      Date.now() - ownerLastSeenAt < HOST_OFFLINE_TIMEOUT_MS
    )
      return;

    const nextOwner = Object.entries(members)
      .filter(
        ([playerId, member]) =>
          member.seat !== undefined &&
          isRecent(lastSeenByPlayer.get(playerId), HOST_OFFLINE_TIMEOUT_MS),
      )
      .sort(([, left], [, right]) => left.joinedAt - right.joinedAt)[0];
    if (!nextOwner || nextOwner[0] === ownerPlayerId) return;

    nextOwner[1].ready = false;
    await this.saveOwnership(nextOwner[0], members);
    const nextOwnerLastSeenAt = lastSeenByPlayer.get(nextOwner[0]);
    this.updateSocketOwnership(nextOwner[0]);
    if (nextOwnerLastSeenAt !== undefined)
      await this.scheduleAlarm(undefined, nextOwnerLastSeenAt);
    this.broadcast(await this.presence());
  }

  private async scheduleAlarm(
    fallbackAt?: number,
    ownerLastSeenAtOverride?: number,
    onlyAdvance = false,
  ): Promise<void> {
    const {
      ownerPlayerId,
      ownerLastSeenAt: storedOwnerLastSeenAt,
      lastActivity,
    } = await this.meta();
    const ownerLastSeenAt =
      ownerLastSeenAtOverride ??
      Math.max(
        this.socketLastSeenByPlayer().get(ownerPlayerId) ?? 0,
        storedOwnerLastSeenAt ?? 0,
      );
    const presenceCheckAt =
      ownerLastSeenAt && Date.now() - ownerLastSeenAt < HOST_OFFLINE_TIMEOUT_MS
        ? ownerLastSeenAt + HOST_OFFLINE_TIMEOUT_MS
        : Number.POSITIVE_INFINITY;
    const timerAt = await this.nextTimerAt();
    const idleExpiryAt = Number.isFinite(timerAt)
      ? Number.POSITIVE_INFINITY
      : (fallbackAt ?? (lastActivity ?? Date.now()) + ROOM_IDLE_TTL_MS);
    const scheduledAt = Math.min(presenceCheckAt, timerAt, idleExpiryAt);
    if (onlyAdvance) {
      const existing = await this.ctx.storage.getAlarm();
      if (existing !== null && existing <= scheduledAt) return;
    }
    await this.ctx.storage.setAlarm(scheduledAt);
  }

  private socketLastSeenByPlayer(): Map<string, number> {
    const latest = new Map<string, number>();
    for (const socket of this.sockets()) {
      const attachment = this.socketAttachment(socket);
      if (!attachment) continue;
      latest.set(
        attachment.playerId,
        Math.max(latest.get(attachment.playerId) ?? 0, attachment.lastSeenAt),
      );
    }
    return latest;
  }

  private updateSocketOwnership(ownerPlayerId: string): void {
    for (const socket of this.sockets()) {
      const attachment = this.socketAttachment(socket);
      if (!attachment) continue;
      this.saveSocketAttachment(socket, {
        ...attachment,
        isOwner: attachment.playerId === ownerPlayerId,
      });
    }
  }

  private broadcast(message: object): void {
    const serialized = JSON.stringify(message);
    for (const socket of this.sockets()) {
      try {
        socket.send(serialized);
      } catch {
        // A peer may close between getWebSockets() and send().
      }
    }
  }

  private snapshotForViewer(
    snapshot: RoomSnapshot,
    viewer: GameActor,
    engine: GameRuntime,
  ): RoomSnapshot {
    const visible = engine.view(snapshot.state, snapshot.events ?? [], {
      protocolVersion: GAME_PROTOCOL_VERSION,
      matchId: snapshot.matchId,
      version: snapshot.version,
      serverTime: snapshot.serverTime,
      viewer,
    });
    return {
      ...snapshot,
      state: visible.state,
      events: visible.events,
    };
  }

  private prepareStateBroadcast(
    snapshot: RoomSnapshot,
    engine: GameRuntime,
    members: Record<string, RoomMember>,
    ownerPlayerId: string,
  ): Array<[WebSocket, string]> {
    const serializedByActor = new Map<string, string>();
    const messages: Array<[WebSocket, string]> = [];
    for (const socket of this.sockets()) {
      const attachment = this.socketAttachment(socket);
      if (!attachment) continue;
      let serialized = serializedByActor.get(attachment.actorId);
      if (!serialized) {
        const member = members[attachment.playerId];
        if (!member) continue;
        serialized = JSON.stringify(
          this.snapshotForViewer(
            snapshot,
            this.gameActor(member, attachment.playerId === ownerPlayerId),
            engine,
          ),
        );
        serializedByActor.set(attachment.actorId, serialized);
      }
      messages.push([socket, serialized]);
    }
    return messages;
  }

  private gameActor(member: RoomMember, isOwner: boolean): GameActor {
    return {
      id: member.actorId,
      ...(member.name ? { name: member.name } : {}),
      role: member.seat === undefined ? "spectator" : "player",
      ...(member.seat === undefined ? {} : { seat: member.seat }),
      isOwner,
    };
  }

  private viewerForActor(
    actorId: string,
    members: Record<string, RoomMember>,
    ownerPlayerId: string,
  ): GameActor {
    const entry = Object.entries(members).find(
      ([, member]) => member.actorId === actorId,
    );
    if (!entry) throw new RoomHttpError(403, "player is not in this game");
    return this.gameActor(entry[1], entry[0] === ownerPlayerId);
  }

  private rememberAction(
    room: RoomState,
    action: StoredAction,
  ): StoredAction[] {
    return [...room.recentActions, action].slice(-MAX_RECENT_ACTIONS);
  }

  private sendPreparedBroadcast(messages: Array<[WebSocket, string]>): void {
    for (const [socket, serialized] of messages) {
      try {
        socket.send(serialized);
      } catch {
        // A peer may close between preparing and sending an update.
      }
    }
  }

  private closePlayerSockets(playerId: string): void {
    for (const socket of this.sockets()) {
      const attachment = this.socketAttachment(socket);
      if (attachment?.playerId !== playerId) continue;
      try {
        socket.close(4001, "left room");
      } catch {
        // The peer may already be disconnected.
      }
    }
  }

  private closeRoomSockets(code: number, reason: string): void {
    for (const socket of this.sockets()) {
      try {
        socket.close(code, reason);
      } catch {
        // A peer may already be disconnected.
      }
    }
  }

  private sockets(): WebSocket[] {
    return [...this.ctx.getWebSockets(), ...this.liveSockets];
  }

  private socketAttachment(socket: WebSocket): SocketAttachment | null {
    return (
      this.liveSocketAttachments.get(socket) ??
      (socket.deserializeAttachment() as SocketAttachment | null)
    );
  }

  private saveSocketAttachment(
    socket: WebSocket,
    attachment: SocketAttachment,
  ): void {
    if (this.liveSocketAttachments.has(socket)) {
      this.liveSocketAttachments.set(socket, attachment);
      return;
    }
    socket.serializeAttachment(attachment);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private handleError(error: unknown): Response {
    if (error instanceof RoomHttpError)
      return this.jsonError(error.status, error.message);
    if (error instanceof JsonValidationError)
      return this.jsonError(422, error.message);
    if (error instanceof GameRuntimeError)
      return this.jsonError(422, error.message);
    console.error("room request failed", error);
    return this.jsonError(500, "internal room error");
  }

  private jsonError(status: number, error: string): Response {
    return Response.json({ error }, { status });
  }

  private playerId(request: Request): string {
    const playerId = request.headers.get("X-Playweft-Player-Id");
    if (!playerId || playerId.length > MAX_PLAYER_ID_LENGTH) {
      throw new RoomHttpError(401, "trusted platform identity is required");
    }
    return playerId;
  }

  private playerName(request: Request): string | undefined {
    const encoded = request.headers.get("X-Playweft-Player-Name");
    if (!encoded) return undefined;
    try {
      const name = decodeURIComponent(encoded).trim();
      return name.length > 0 && name.length <= MAX_PLAYER_NAME_LENGTH
        ? name
        : undefined;
    } catch {
      return undefined;
    }
  }

  private playerAvatarUrl(request: Request): string | undefined {
    const encoded = request.headers.get("X-Playweft-Player-Avatar");
    if (!encoded) return undefined;
    try {
      const url = new URL(decodeURIComponent(encoded));
      return url.protocol === "https:" &&
        (url.hostname === "pbs.twimg.com" || url.hostname === "abs.twimg.com")
        ? url.toString()
        : undefined;
    } catch {
      return undefined;
    }
  }

  private roomId(request: Request): string {
    const roomId = request.headers.get("X-Playweft-Room-Id");
    if (!roomId || !/^[a-zA-Z0-9_-]{1,128}$/.test(roomId)) {
      throw new RoomHttpError(400, "trusted room identity is required");
    }
    return roomId;
  }

  private async actorId(request: Request): Promise<string> {
    const playerId = this.playerId(request);
    const actors =
      (await this.ctx.storage.get<Record<string, string>>("actors")) ?? {};
    const existing = actors[playerId];
    if (existing) return existing;

    const actorId = `actor_${crypto.randomUUID().replaceAll("-", "")}`;
    actors[playerId] = actorId;
    await this.ctx.storage.put("actors", actors);
    return actorId;
  }

  private async members(): Promise<Record<string, RoomMember>> {
    return (await this.meta()).members;
  }

  private async memberActorId(playerId: string): Promise<string> {
    const member = (await this.members())[playerId];
    if (!member) throw new RoomHttpError(403, "join the room before playing");
    return member.actorId;
  }

  private async avatarSource(token: string): Promise<string> {
    const member = Object.values(await this.members()).find(
      (candidate) => candidate.avatarToken === token,
    );
    if (!member?.avatarUrl) {
      throw new RoomHttpError(410, "room avatar is no longer available");
    }
    return member.avatarUrl;
  }

  private async ownerPlayerId(): Promise<string> {
    return (await this.meta()).ownerPlayerId;
  }

  private async phase(): Promise<"lobby" | "playing"> {
    return (await this.meta()).phase;
  }

  private async presence(): Promise<RoomPresence> {
    const { config, phase, members, ownerPlayerId, presenceRevision, roomId } =
      await this.meta();
    if (!config) {
      throw new RoomHttpError(
        409,
        "room has no valid game runtime; initialize it first",
      );
    }
    const players: RoomPlayer[] = Object.values(members)
      .filter((member) => member.seat !== undefined)
      .sort((left, right) => left.seat! - right.seat!)
      .map((member) => ({
        id: member.actorId,
        ...(member.name ? { name: member.name } : {}),
        ...(member.avatarToken
          ? { avatarUrl: roomAvatarPath(roomId, member.avatarToken) }
          : {}),
        seat: member.seat!,
        ready: member.ready === true,
      }));
    const spectators = Object.values(members)
      .filter((member) => member.seat === undefined)
      .sort((left, right) => left.joinedAt - right.joinedAt)
      .map((member) => ({
        id: member.actorId,
        ...(member.name ? { name: member.name } : {}),
        ...(member.avatarToken
          ? { avatarUrl: roomAvatarPath(roomId, member.avatarToken) }
          : {}),
      }));
    return {
      type: "room.presence",
      revision: presenceRevision ?? 0,
      phase,
      players,
      spectators,
      ownerId: members[ownerPlayerId]?.actorId ?? "",
      minPlayers: config.minPlayers,
      maxPlayers: config.maxPlayers,
    };
  }
}

function isRecent(lastSeenAt: number | undefined, timeoutMs: number): boolean {
  return lastSeenAt !== undefined && Date.now() - lastSeenAt < timeoutMs;
}

function validateGameId(value: string, manifestUrl: string): string {
  let gameId: URL;
  let manifest: URL;
  try {
    gameId = new URL(value);
    manifest = new URL(manifestUrl);
  } catch {
    throw new RoomHttpError(400, "gameId must be an absolute URL");
  }
  if (
    value.length > 2_048 ||
    value.trim() !== value ||
    gameId.origin !== manifest.origin ||
    gameId.username.length > 0 ||
    gameId.password.length > 0
  ) {
    throw new RoomHttpError(
      400,
      "gameId must use the Manifest origin without credentials",
    );
  }
  gameId.hash = "";
  return gameId.toString();
}

function validateGameVersion(value: string): string {
  if (
    value.length > 64 ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      value,
    )
  ) {
    throw new RoomHttpError(400, "gameVersion must be a semantic version");
  }
  return value;
}

function validateServerUrl(value: string, manifestUrl: string): string {
  let server: URL;
  let manifest: URL;
  try {
    server = new URL(value);
    manifest = new URL(manifestUrl);
  } catch {
    throw new RoomHttpError(400, "serverUrl must be an absolute URL");
  }
  if (
    server.origin !== manifest.origin ||
    server.username.length > 0 ||
    server.password.length > 0
  ) {
    throw new RoomHttpError(
      400,
      "serverUrl must use the Manifest origin without credentials",
    );
  }
  const isLocalHttp =
    server.protocol === "http:" &&
    (server.hostname === "localhost" || server.hostname === "127.0.0.1");
  if (server.protocol !== "https:" && !isLocalHttp) {
    throw new RoomHttpError(
      400,
      "serverUrl must use HTTPS (or localhost HTTP during development)",
    );
  }
  server.hash = "";
  return server.toString();
}

async function fetchServerSource(
  serverUrl: string,
  platformOrigin: string,
  assets: Fetcher,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SERVER_FETCH_TIMEOUT_MS);
  try {
    const request = new Request(serverUrl, {
      headers: { Accept: "text/plain" },
      redirect: "manual",
      signal: controller.signal,
    });
    let response: Response;
    try {
      response =
        new URL(serverUrl).origin === platformOrigin
          ? await assets.fetch(request)
          : await fetch(request);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new RoomHttpError(504, "game server entry request timed out");
      }
      throw new RoomHttpError(
        502,
        `could not fetch game server entry: ${errorMessage(error)}`,
      );
    }
    if (!response.ok) {
      throw new RoomHttpError(
        502,
        `game server entry request failed (${response.status})`,
      );
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_SERVER_SOURCE_BYTES
    ) {
      throw new RoomHttpError(413, "game server entry exceeds the size limit");
    }
    if (!response.body) {
      throw new RoomHttpError(502, "game server entry response has no body");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_SERVER_SOURCE_BYTES) {
        await reader.cancel();
        throw new RoomHttpError(
          413,
          "game server entry exceeds the size limit",
        );
      }
      chunks.push(value);
    }
    if (totalBytes === 0) {
      throw new RoomHttpError(400, "game server entry is empty");
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: false,
      }).decode(bytes);
    } catch {
      throw new RoomHttpError(400, "game server entry must be valid UTF-8");
    }
  } catch (error) {
    if (error instanceof RoomHttpError) throw error;
    if (controller.signal.aborted) {
      throw new RoomHttpError(504, "game server entry request timed out");
    }
    throw new RoomHttpError(
      502,
      `could not read game server entry: ${errorMessage(error)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeManifestUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RoomHttpError(400, "manifestUrl must be an absolute URL");
  }
  const isLocalHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new RoomHttpError(
      400,
      "manifestUrl must use HTTPS (or localhost HTTP during development)",
    );
  }
  if (url.username || url.password)
    throw new RoomHttpError(400, "manifestUrl must not include credentials");
  return url.toString();
}

function validatePlayerLimit(value: unknown, label: string): number {
  if (!isPlayerLimit(value))
    throw new RoomHttpError(
      400,
      `${label} must be an integer from 1 to ${MAX_PLAYERS}`,
    );
  return value;
}

function isPlayerLimit(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_PLAYERS
  );
}

function validateActionId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new RoomHttpError(400, "requestId must be a 1-128 character string");
  }
  return value;
}

function latencyAckId(input: Record<string, unknown>): string | undefined {
  if (!("ackId" in input)) return undefined;
  if (
    typeof input.ackId !== "string" ||
    input.ackId.length === 0 ||
    input.ackId.length > MAX_LATENCY_ACK_ID_LENGTH
  ) {
    throw new RoomHttpError(
      400,
      `ackId must be a 1-${MAX_LATENCY_ACK_ID_LENGTH} character string`,
    );
  }
  return input.ackId;
}

function randomAvatarToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function roomAvatarPath(roomId: string, token: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}/avatars/${token}`;
}

async function proxyAvatar(
  source: string,
  request: Request,
): Promise<Response> {
  const destination = request.headers.get("Sec-Fetch-Dest");
  if (destination && destination !== "image") {
    throw new RoomHttpError(403, "room avatars may only be loaded as images");
  }
  const sourceUrl = new URL(source);
  if (
    sourceUrl.protocol !== "https:" ||
    (sourceUrl.hostname !== "pbs.twimg.com" &&
      sourceUrl.hostname !== "abs.twimg.com")
  ) {
    throw new RoomHttpError(502, "room avatar source is not allowed");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(sourceUrl, {
      headers: {
        Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif",
      },
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new RoomHttpError(
        502,
        `room avatar request failed (${response.status})`,
      );
    }
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (
      contentType !== "image/avif" &&
      contentType !== "image/gif" &&
      contentType !== "image/jpeg" &&
      contentType !== "image/png" &&
      contentType !== "image/webp"
    ) {
      throw new RoomHttpError(502, "room avatar has an unsupported type");
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_AVATAR_BYTES) {
      throw new RoomHttpError(502, "room avatar exceeds the size limit");
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_AVATAR_BYTES) {
      throw new RoomHttpError(502, "room avatar exceeds the size limit");
    }
    return new Response(bytes, {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Type": contentType,
        "Cross-Origin-Resource-Policy": "cross-origin",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof RoomHttpError) throw error;
    if (controller.signal.aborted) {
      throw new RoomHttpError(504, "room avatar request timed out");
    }
    throw new RoomHttpError(502, "could not load room avatar");
  } finally {
    clearTimeout(timeout);
  }
}

function secureRandomSeed(): string {
  const values = new Uint8Array(16);
  crypto.getRandomValues(values);
  return Array.from(values, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

async function parseRequestJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new RoomHttpError(400, "request body must be valid JSON");
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new RoomHttpError(400, "message must be valid JSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareTimers(left: RoomTimer, right: RoomTimer): number {
  return left.dueAt - right.dueAt || left.id.localeCompare(right.id);
}

function initialTimerBudget(now: number): TimerBudget {
  return {
    tokens: TIMER_BUDGET_CAPACITY,
    updatedAt: now,
    dayStart: utcDayStart(now),
    firedToday: 0,
  };
}

function consumeTimerBudget(
  stored: TimerBudget,
  now: number,
): TimerBudgetConsumption {
  const dayStart = utcDayStart(now);
  const firedToday = stored.dayStart === dayStart ? stored.firedToday : 0;
  const tokens = Math.min(
    TIMER_BUDGET_CAPACITY,
    stored.tokens +
      Math.max(0, now - stored.updatedAt) / TIMER_BUDGET_REFILL_MS,
  );
  if (firedToday >= MAX_TIMER_FIRES_PER_DAY) {
    return {
      allowed: false,
      budget: { tokens, updatedAt: now, dayStart, firedToday },
      nextAllowedAt: dayStart + DAY_MS,
    };
  }
  if (tokens < 1) {
    return {
      allowed: false,
      budget: { tokens, updatedAt: now, dayStart, firedToday },
      nextAllowedAt: now + Math.ceil((1 - tokens) * TIMER_BUDGET_REFILL_MS),
    };
  }
  return {
    allowed: true,
    budget: {
      tokens: tokens - 1,
      updatedAt: now,
      dayStart,
      firedToday: firedToday + 1,
    },
  };
}

function utcDayStart(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "internal room error";
}

async function hash(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
