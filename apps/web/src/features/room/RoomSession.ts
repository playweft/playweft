import type {
  JsonValue,
  RoomPresence,
  RoomSnapshot,
} from "@playweft/game-protocol";
import type * as PlatformApi from "@/platform/platform-api";
import type { DiscoveredGame, LoadedGame } from "@/features/game/game-manifest";
import { rpcPlatformFault } from "@/platform/json-rpc";
import {
  RoomConnection,
  type RoomConnectionState,
  type RoomMessage,
} from "./RoomConnection";
import {
  entryFailureFrom,
  errorMessage,
  isRoomNotFound,
  isRoomMemberNotFound,
  type RoomEntryFailure,
} from "./room-errors";
import { LocalHostRoom, type PeerTransport } from "./peer/LocalHostRoom";

export interface RoomSessionState {
  peerTransport?: PeerTransport;
  peerLatency?: number;
  lifecycle: "entering" | "joined" | "failed" | "ended";
  connection: RoomConnectionState;
  loadedGame?: LoadedGame;
  presence?: RoomPresence;
  selfId?: string;
  snapshot?: RoomSnapshot;
  latency?: number;
  error?: string;
  entryFailure?: RoomEntryFailure;
  gameRevision: number;
}

export const initialRoomState: RoomSessionState = {
  lifecycle: "entering",
  connection: "idle",
  gameRevision: 0,
};

export type RoomServices = Pick<
  typeof PlatformApi,
  | "createGuestSession"
  | "getRoomLaunch"
  | "getRoomMembership"
  | "setRoomConnectionMode"
  | "getRoomLocalRuntime"
  | "initializeRoom"
  | "joinRoom"
  | "getPlatformSession"
  | "setRoomProfileAvatarSharing"
  | "connectRoom"
  | "startRoom"
  | "leaveRoom"
  | "dissolveRoom"
  | "setRoomSeat"
  | "setPlayerReady"
  | "kickPlayer"
  | "transferRoomHost"
  | "returnRoomToLobby"
  | "changeRoomGame"
  | "sendAction"
> & {
  loadGameManifest(url: string): Promise<LoadedGame>;
  manifestUrlFromInput(url: string): string;
};

export type RoomMessageKey =
  | "unexpectedError"
  | "liveConnectionNotReady"
  | "liveConnectionFailed"
  | "liveConnectionNotRestored"
  | "gameNotStarted";

interface SessionOptions {
  nickname(): string;
  message(key: RoomMessageKey): string;
  onGameDiscovered(game: DiscoveredGame): void;
  onEnd(): void;
}

export interface RoomSessionError {
  code: string;
  message: string;
}

/** Room lifetime is independent of iframe mounts, permissions and React renders. */
export class RoomSession {
  private state: RoomSessionState = { ...initialRoomState };
  private listeners = new Set<() => void>();
  private errorListeners = new Set<(error: RoomSessionError) => void>();
  private connection: RoomConnection;
  private generation = 0;
  private roundGeneration = 0;
  private activationGeneration = -1;
  private entryStarted = false;
  private stopped = false;
  private syncedNickname?: string;
  private nicknameRevision = 0;
  private checkingRoomGeneration?: number;
  private hostInstanceId = crypto.randomUUID();
  private localRoom?: LocalHostRoom;
  private localMatchId?: string;
  private pendingActions = new Map<
    string,
    { resolve(value: JsonValue): void; reject(reason: unknown): void }
  >();

  constructor(
    readonly roomId: string,
    private readonly api: RoomServices,
    private readonly options: SessionOptions,
  ) {
    this.connection = new RoomConnection({
      createSocket: () => api.connectRoom(roomId, this.hostInstanceId),
      onMessage: (message) => this.receive(message),
      onState: (connection) => {
        this.patch({
          connection,
          ...(connection !== "connected" ? { latency: undefined } : {}),
          ...(connection === "connected" ? { error: undefined } : {}),
        });
        this.localRoom?.setRelayAvailable(connection === "connected");
        if (connection === "reconnecting" || connection === "failed")
          void this.verifyRoomMembership();
      },
      onInterrupted: () =>
        this.cancelActions(
          "REALTIME_CONNECTION_INTERRUPTED",
          options.message("liveConnectionNotReady"),
        ),
      onError: (failed) =>
        this.reportError(
          "REALTIME_CONNECTION_FAILED",
          options.message(
            failed ? "liveConnectionNotRestored" : "liveConnectionFailed",
          ),
        ),
      onLatency: (latency) => this.patch({ latency }),
      onClosed: () => this.end(),
      onResume: () => {
        this.patch({ error: undefined });
        void this.verifyRoomMembership();
      },
    });
  }

  getState = (): RoomSessionState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  subscribeErrors(listener: (error: RoomSessionError) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  async enter(): Promise<void> {
    if (this.entryStarted || this.stopped) return;
    this.entryStarted = true;
    const generation = this.generation;
    const nickname = this.options.nickname();
    try {
      await this.api.createGuestSession(nickname);
      if (!this.isCurrent(generation)) return;
      this.syncedNickname = nickname;
      const launch = await this.api.getRoomLaunch(this.roomId);
      if (!this.isCurrent(generation)) return;
      await this.loadGame(launch.manifestUrl);
    } catch (reason) {
      if (this.isCurrent(generation)) this.failEntry(reason);
    }
  }

  /** Called after any orientation gate allows loading this game's room. */
  async activate(): Promise<void> {
    const loaded = this.state.loadedGame;
    const generation = this.generation;
    if (
      this.stopped ||
      !loaded?.room ||
      this.activationGeneration === generation
    )
      return;
    this.activationGeneration = generation;
    try {
      await this.api.initializeRoom(this.roomId, loaded.room);
      if (!this.isCurrent(generation)) return;
      const membership = await this.api.joinRoom(this.roomId);
      if (!this.isCurrent(generation)) return;
      const { selfId, ...presence } = membership;
      this.patch({ selfId, lifecycle: "joined" });
      this.applyPresence(presence);
      this.connection.start();
      void this.syncAvatar(generation);
    } catch (reason) {
      if (this.isCurrent(generation)) this.failEntry(reason);
    }
  }

  async syncNickname(): Promise<void> {
    const nickname = this.options.nickname();
    if (
      this.stopped ||
      this.state.lifecycle !== "joined" ||
      this.state.presence?.phase !== "lobby" ||
      nickname === this.syncedNickname
    )
      return;
    const revision = ++this.nicknameRevision;
    const generation = this.generation;
    const current = () =>
      this.isCurrent(generation) && revision === this.nicknameRevision;
    try {
      await this.api.createGuestSession(nickname);
      if (!current()) return;
      const { selfId, ...presence } = await this.api.joinRoom(this.roomId);
      if (!current()) return;
      this.syncedNickname = nickname;
      this.patch({ selfId });
      this.applyPresence(presence);
    } catch (reason) {
      if (current() && !this.endIfRoomUnavailable(reason, generation))
        this.setError(
          errorMessage(reason, this.options.message("unexpectedError")),
        );
    }
  }

  async start(): Promise<boolean> {
    return this.perform(async () => {
      const result = await this.api.startRoom(
        this.roomId,
        this.state.presence?.connectionMode &&
          this.state.presence.connectionMode !== "platform"
          ? this.hostInstanceId
          : undefined,
      );
      return () => {
        this.applyPresence(result.presence);
        if (!this.state.presence?.localHost && result.snapshot)
          this.publish(result.snapshot);
      };
    });
  }
  setConnectionMode(
    mode: NonNullable<RoomPresence["connectionMode"]>,
  ): Promise<boolean> {
    return this.updatePresence(() =>
      this.api.setRoomConnectionMode(this.roomId, mode),
    );
  }
  chooseSeat(seat: number | null): Promise<boolean> {
    return this.updatePresence(() => this.api.setRoomSeat(this.roomId, seat));
  }
  setReady(): Promise<boolean> {
    const player = this.state.presence?.players.find(
      (player) => player.id === this.state.selfId,
    );
    return player
      ? this.updatePresence(() =>
          this.api.setPlayerReady(this.roomId, !player.ready),
        )
      : Promise.resolve(false);
  }
  kick(playerId: string): Promise<boolean> {
    return this.updatePresence(() =>
      this.api.kickPlayer(this.roomId, playerId),
    );
  }
  transferHost(playerId: string): Promise<boolean> {
    return this.updatePresence(() =>
      this.api.transferRoomHost(this.roomId, playerId),
    );
  }
  returnToRoom(): Promise<boolean> {
    return this.updatePresence(async () => {
      const matchId = this.state.presence?.localHost?.matchId;
      if (this.localRoom && !(await this.localRoom.canReturnToRoom()))
        throw new Error("The game does not allow returning to the room yet");
      this.assertActive();
      if (matchId && this.state.presence?.localHost?.matchId !== matchId)
        throw rpcPlatformFault("GAME_CHANGED", "The match was replaced");
      return this.api.returnRoomToLobby(this.roomId);
    });
  }
  changeGame(url: string): Promise<boolean> {
    return this.perform(async () => {
      const generation = this.generation;
      const next = await this.api.loadGameManifest(
        this.api.manifestUrlFromInput(url),
      );
      if (!this.isCurrent(generation)) return () => {};
      if (!next.room)
        throw new Error("The game Manifest does not declare room mode");
      await this.api.changeRoomGame(this.roomId, next.game.manifestUrl);
      // The server's game_changed event owns the transition for all players.
      return () => {};
    });
  }
  leave(): Promise<void> {
    return this.endVia(() => this.api.leaveRoom(this.roomId), true);
  }
  dissolve(): Promise<void> {
    return this.endVia(() => this.api.dissolveRoom(this.roomId));
  }

  refreshGame(): void {
    this.patch({ gameRevision: this.state.gameRevision + 1 });
  }
  setError(error?: string): void {
    this.patch({ error });
  }

  async shareAvatar(shared: boolean): Promise<RoomPresence> {
    const generation = this.generation;
    this.assertActive();
    const presence = await this.api
      .setRoomProfileAvatarSharing(this.roomId, shared)
      .catch((reason) => {
        this.endIfRoomUnavailable(reason, generation);
        throw reason;
      });
    if (!this.isCurrent(generation))
      throw rpcPlatformFault("ROOM_CLOSED", "The room session was replaced");
    this.applyPresence(presence);
    return presence;
  }

  async action(requestId: string, action: JsonValue): Promise<JsonValue> {
    this.assertActive();
    if (
      this.state.lifecycle !== "joined" ||
      this.state.presence?.phase !== "playing"
    ) {
      throw rpcPlatformFault(
        "GAME_NOT_STARTED",
        this.options.message("gameNotStarted"),
      );
    }
    this.connection.noteActivity();
    if (this.state.presence.localHost) {
      if (!this.localRoom)
        throw rpcPlatformFault(
          "LOCAL_HOST_UNAVAILABLE",
          "Local host is not ready",
        );
      try {
        return await this.localRoom.action(requestId, action);
      } catch (reason) {
        throw rpcPlatformFault(
          "LOCAL_HOST_UNAVAILABLE",
          errorMessage(reason, "Local host is unavailable"),
          true,
        );
      }
    }
    if (this.state.loadedGame?.room?.liveRoom) {
      if (this.state.connection !== "connected") {
        throw rpcPlatformFault(
          "REALTIME_CONNECTION_NOT_READY",
          this.options.message("liveConnectionNotReady"),
          true,
        );
      }
      if (this.pendingActions.has(requestId))
        throw rpcPlatformFault(
          "DUPLICATE_REQUEST",
          "A request with this JSON-RPC id is already pending",
        );
      return new Promise<JsonValue>((resolve, reject) => {
        this.pendingActions.set(requestId, { resolve, reject });
        try {
          this.connection.send({ type: "action", requestId, action });
        } catch {
          this.pendingActions.delete(requestId);
          reject(
            rpcPlatformFault(
              "REALTIME_CONNECTION_NOT_READY",
              this.options.message("liveConnectionNotReady"),
              true,
            ),
          );
        }
      });
    }
    const generation = this.generation;
    const roundGeneration = this.roundGeneration;
    try {
      const response = await this.api.sendAction(
        this.roomId,
        requestId,
        action,
      );
      if (
        !this.isCurrent(generation) ||
        roundGeneration !== this.roundGeneration
      )
        throw rpcPlatformFault("ROOM_CLOSED", "The room session was replaced");
      if (response.update) this.publish(response.update);
      return actionResultForRpc(response.result);
    } catch (reason) {
      if (roundGeneration === this.roundGeneration)
        this.endIfRoomUnavailable(reason, generation);
      throw rpcPlatformFault(
        "ACTION_REJECTED",
        errorMessage(reason, this.options.message("unexpectedError")),
      );
    }
  }

  cancelActions(
    code = "BRIDGE_CLOSED",
    message = "The game bridge was closed",
  ): void {
    for (const pending of this.pendingActions.values())
      pending.reject(rpcPlatformFault(code, message, true));
    this.pendingActions.clear();
  }

  dispose(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation += 1;
    this.connection.dispose();
    this.disposeLocalRoom();
    this.cancelActions("ROOM_CLOSED", "The room session was closed");
    this.state = {
      ...this.state,
      lifecycle: "ended",
      connection: "closed",
      snapshot: undefined,
      presence: undefined,
      selfId: undefined,
    };
    this.listeners.forEach((listener) => listener());
    this.listeners.clear();
    this.errorListeners.clear();
  }

  private end(): void {
    if (this.stopped) return;
    this.dispose();
    this.options.onEnd();
  }

  private endIfRoomUnavailable(
    reason: unknown,
    generation: number,
    missingMember = false,
  ): boolean {
    if (
      this.isCurrent(generation) &&
      (isRoomNotFound(reason) ||
        (missingMember && isRoomMemberNotFound(reason)))
    ) {
      this.end();
      return true;
    }
    return false;
  }

  private async verifyRoomMembership(): Promise<void> {
    const generation = this.generation;
    if (
      this.stopped ||
      this.state.lifecycle !== "joined" ||
      this.checkingRoomGeneration === generation
    )
      return;
    this.checkingRoomGeneration = generation;
    try {
      await this.api.getRoomMembership(this.roomId);
    } catch (reason) {
      this.endIfRoomUnavailable(reason, generation, true);
      // Transport, authentication and unrelated errors leave recovery active.
    } finally {
      if (this.checkingRoomGeneration === generation)
        this.checkingRoomGeneration = undefined;
    }
  }

  private async endVia(
    request: () => Promise<unknown>,
    leaving = false,
  ): Promise<void> {
    if (this.stopped) return;
    this.setError(undefined);
    try {
      await request();
      this.end();
    } catch (reason) {
      if (isRoomNotFound(reason) || (leaving && isRoomMemberNotFound(reason)))
        this.end();
      else if (!this.stopped)
        this.setError(
          errorMessage(reason, this.options.message("unexpectedError")),
        );
    }
  }

  private async loadGame(manifestUrl: string): Promise<void> {
    const generation = ++this.generation;
    this.cancelActions("GAME_CHANGED", "The room game was changed");
    this.disposeLocalRoom();
    this.connection.setHeartbeatRequired(false);
    this.patch({
      lifecycle: "entering",
      loadedGame: undefined,
      presence: undefined,
      selfId: undefined,
      snapshot: undefined,
      latency: undefined,
      entryFailure: undefined,
      gameRevision: this.state.gameRevision + 1,
    });
    try {
      const loadedGame = await this.api.loadGameManifest(manifestUrl);
      if (!this.isCurrent(generation)) return;
      if (!loadedGame.room)
        throw new Error("The game Manifest does not declare room mode");
      this.patch({ loadedGame });
      this.options.onGameDiscovered(loadedGame.game);
    } catch (reason) {
      if (this.isCurrent(generation)) this.failEntry(reason);
    }
  }

  private receive(message: RoomMessage): void {
    if (this.stopped) return;
    if (message.type === "peer") {
      this.localRoom?.receive(message);
      return;
    }
    if (message.type === "game_changed") {
      void this.loadGame(message.manifestUrl);
    } else if (message.type === "room.presence") this.applyPresence(message);
    else if (message.type === "snapshot" || message.type === "state") {
      if (!this.state.presence?.localHost) this.publish(message);
    } else if (message.type === "action-result") {
      const pending = this.pendingActions.get(message.requestId);
      this.pendingActions.delete(message.requestId);
      pending?.resolve(actionResultForRpc(message));
    } else if (message.type === "error") {
      if (message.requestId) {
        const pending = this.pendingActions.get(message.requestId);
        this.pendingActions.delete(message.requestId);
        pending?.reject(rpcPlatformFault("ACTION_REJECTED", message.error));
      } else this.reportError("ROOM_ERROR", message.error);
    }
  }

  private applyPresence(presence: RoomPresence): void {
    if (this.stopped) return;
    if (presence.revision >= (this.state.presence?.revision ?? -1)) {
      const returnedToLobby =
        presence.phase === "lobby" && this.state.presence?.phase === "playing";
      if (returnedToLobby) this.roundGeneration += 1;
      this.patch({
        presence,
        ...(presence.phase === "lobby"
          ? {
              snapshot: undefined,
              gameRevision: this.state.gameRevision + (returnedToLobby ? 1 : 0),
            }
          : {}),
      });
      this.syncLocalRoom(presence);
    }
    this.connection.setHeartbeatRequired(
      Boolean(
        (this.state.selfId &&
          this.state.presence?.ownerId === this.state.selfId) ||
        (this.state.selfId &&
          this.state.presence?.localHost?.id === this.state.selfId) ||
        this.state.presence?.players.some(
          (player) => player.id === this.state.selfId,
        ),
      ),
    );
  }

  private publish(snapshot: RoomSnapshot): void {
    const previous = this.state.snapshot;
    if (
      this.stopped ||
      this.state.presence?.phase !== "playing" ||
      (snapshot.matchId === previous?.matchId &&
        snapshot.version <= previous.version)
    )
      return;
    this.patch({ snapshot });
  }

  private disposeLocalRoom(): void {
    this.localRoom?.dispose();
    this.localRoom = undefined;
    this.localMatchId = undefined;
    this.patch({ peerTransport: undefined, peerLatency: undefined });
  }

  private syncLocalRoom(presence: RoomPresence): void {
    if (
      !presence.localHost ||
      presence.phase !== "playing" ||
      !this.state.selfId
    ) {
      if (this.localRoom) this.disposeLocalRoom();
      return;
    }
    if (this.localMatchId === presence.localHost.matchId) {
      this.localRoom?.setPresence(presence);
      return;
    }
    this.disposeLocalRoom();
    const generation = this.generation;
    const matchId = presence.localHost.matchId;
    this.localMatchId = matchId;
    this.localRoom = new LocalHostRoom({
      selfId: this.state.selfId,
      instanceId: this.hostInstanceId,
      presence,
      relayAvailable: this.state.connection === "connected",
      sendRelay: (targetId, kind, body) =>
        this.connection.send({ type: "peer", targetId, matchId, kind, body }),
      loadHost: async () => {
        const [boot, { createLuaRuntime }] = await Promise.all([
          this.api.getRoomLocalRuntime(this.roomId, this.hostInstanceId),
          import("./peer/lua-runtime"),
        ]);
        if (!this.isCurrent(generation) || this.localMatchId !== matchId)
          throw rpcPlatformFault("GAME_CHANGED", "The match was replaced");
        return { boot, runtime: await createLuaRuntime(boot.script) };
      },
      onError: (error) => {
        if (this.isCurrent(generation) && this.localMatchId === matchId)
          this.setError(error.message);
      },
      onSnapshot: (snapshot) => {
        if (this.isCurrent(generation) && this.localMatchId === matchId)
          this.publish(snapshot);
      },
      onTransport: (peerTransport) => {
        if (this.isCurrent(generation) && this.localMatchId === matchId)
          this.patch({
            peerTransport,
            ...(this.state.peerTransport !== peerTransport
              ? { peerLatency: undefined }
              : {}),
          });
      },
      onLatency: (peerLatency) => {
        if (this.isCurrent(generation) && this.localMatchId === matchId)
          this.patch({ peerLatency });
      },
    });
  }

  private async syncAvatar(generation: number): Promise<void> {
    try {
      const session = await this.api.getPlatformSession();
      if (!this.isCurrent(generation)) return;
      const presence = await this.api.setRoomProfileAvatarSharing(
        this.roomId,
        session.provider === "x" && Boolean(session.avatarUrl),
      );
      if (this.isCurrent(generation)) this.applyPresence(presence);
    } catch (reason) {
      this.endIfRoomUnavailable(reason, generation);
      /* Avatar sync must not block room entry. */
    }
  }

  private updatePresence(
    request: () => Promise<RoomPresence>,
  ): Promise<boolean> {
    return this.perform(async () => {
      const presence = await request();
      return () => this.applyPresence(presence);
    });
  }

  private async perform(request: () => Promise<() => void>): Promise<boolean> {
    if (this.stopped || this.state.lifecycle !== "joined") return false;
    const generation = this.generation;
    const roundGeneration = this.roundGeneration;
    this.setError(undefined);
    try {
      const apply = await request();
      if (
        !this.isCurrent(generation) ||
        roundGeneration !== this.roundGeneration
      )
        return false;
      apply();
      return true;
    } catch (reason) {
      if (
        this.isCurrent(generation) &&
        roundGeneration === this.roundGeneration &&
        !this.endIfRoomUnavailable(reason, generation)
      )
        this.setError(
          errorMessage(reason, this.options.message("unexpectedError")),
        );
      return false;
    }
  }

  private failEntry(reason: unknown): void {
    this.patch({ lifecycle: "failed", entryFailure: entryFailureFrom(reason) });
  }
  private reportError(code: string, message: string): void {
    if (this.stopped) return;
    this.setError(message);
    this.errorListeners.forEach((listener) => listener({ code, message }));
  }
  private assertActive(): void {
    if (this.stopped)
      throw rpcPlatformFault("ROOM_CLOSED", "The room session was closed");
  }
  private isCurrent(generation: number): boolean {
    return !this.stopped && generation === this.generation;
  }
  private patch(patch: Partial<RoomSessionState>): void {
    if (this.stopped) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}

function actionResultForRpc(result: PlatformApi.RoomActionResult): JsonValue {
  return result.accepted
    ? { accepted: true, matchId: result.matchId, version: result.version }
    : {
        accepted: false,
        matchId: result.matchId,
        version: result.version,
        error: { code: result.error.code, message: result.error.message },
      };
}
