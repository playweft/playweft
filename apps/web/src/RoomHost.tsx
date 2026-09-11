import { useEffect, useRef, useState } from "react";
import {
  Armchair,
  Check,
  Crown,
  DoorClosed,
  Eye,
  MoreHorizontal,
  Share2,
  UserRound,
} from "lucide-react";
import {
  JsonRpcErrorCode,
  isJson,
  type JsonValue,
  type UserProfileField,
} from "@playweft/game-protocol";
import {
  connectRoom,
  changeRoomGame,
  createGuestSession,
  dissolveRoom,
  getPlatformSession,
  getRoomLaunch,
  initializeRoom,
  joinRoom,
  kickPlayer,
  leaveRoom,
  setPlayerReady,
  setRoomProfileAvatarSharing,
  setRoomSeat,
  sendAction,
  startRoom,
  transferRoomHost,
  returnRoomToLobby,
  PlatformApiError,
  type RoomActionResult,
  type RoomJoin,
  type RoomPresence,
  type RoomSnapshot,
} from "./platform-api";
import ErrorToast from "./ErrorToast";
import Dialog from "./Dialog";
import GameInfoPanel from "./GameInfoPanel";
import GameFrame, { attachGameBridge } from "./GameFrame";
import GameWindowDialog, {
  PLATFORM_WINDOW_CAPABILITIES,
  useGameWindowDialogs,
} from "./GameWindowDialog";
import GameViewport from "./GameViewport";
import GameHelpDialog from "./GameHelpDialog";
import InviteDialog from "./InviteDialog";
import Menu from "./Menu";
import PlayerProfileMenu from "./PlayerProfileMenu";
import RoomIdCopy from "./RoomIdCopy";
import ChangeGameDialog from "./ChangeGameDialog";
import { ClipboardPrompt, useClipboardRead } from "./ClipboardPrompt";
import { useRoomPlayerProfileAccess } from "./RoomPlayerProfile";
import {
  UserProfilePrompt,
  userProfileFieldsFromRpcParams,
  useUserProfileAccess,
} from "./UserProfilePrompt";
import { isFavoriteGame, toggleFavoriteGame } from "./favorite-games";
import {
  PLAYWEFT_BRIDGE_VERSION,
  RpcFault,
  postRpcNotification,
  rpcPlatformFault,
} from "./json-rpc";
import {
  loadGameManifest,
  manifestUrlFromInput,
  type DiscoveredGame,
  type LoadedGame,
} from "./game-manifest";
import { localizeGameDescription, localizeGameName, useI18n } from "./i18n";
import {
  prepareGameOrientation,
  releaseGameFullscreen,
  shouldShowWeChatLandscapeGuidance,
  useGameViewport,
} from "./use-game-viewport";

const MAX_RECONNECT_ATTEMPTS = 5;
const HEARTBEAT_IDLE_MS = 20_000;
const LATENCY_SAMPLE_INTERVAL_MS = 3_000;
const LATENCY_PROBE_TIMEOUT_MS = 10_000;

type PlatformLatencyAck = { type: "platform.ack"; ackId: string };

interface RoomHostProps {
  identityReady: boolean;
  nickname: string;
  roomId: string;
  onBack(): void;
  onGameDiscovered(game: DiscoveredGame): void;
  onNicknameChange(value: string): void;
}

type RoomEntryFailure = "not-found" | "unavailable";

export default function RoomHost({
  identityReady,
  nickname,
  roomId,
  onBack,
  onGameDiscovered,
  onNicknameChange,
}: RoomHostProps) {
  const { locale, t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  const iframe = useRef<HTMLIFrameElement>(null);
  const bridgePort = useRef<MessagePort | undefined>(undefined);
  const latestSnapshotRef = useRef<RoomSnapshot | undefined>(undefined);
  const roomProfileSnapshot = useRef<
    Map<string, { name?: string; avatarUrl?: string }> | undefined
  >(undefined);
  const phaseRef = useRef<"lobby" | "playing">("lobby");
  const nicknameRef = useRef(nickname);
  const selfIdRef = useRef<string | undefined>(undefined);
  const setHeartbeatRequiredRef = useRef<
    ((required: boolean) => void) | undefined
  >(undefined);
  const syncedNickname = useRef<string | undefined>(undefined);
  nicknameRef.current = nickname;
  const [manifestUrl, setManifestUrl] = useState<string>();
  const [gameUrl, setGameUrl] = useState<string>();
  const [loadedGame, setLoadedGame] = useState<LoadedGame>();
  const [gameRevision, setGameRevision] = useState(0);
  const [game, setGame] = useState<DiscoveredGame>();
  const [gameIconHref, setGameIconHref] = useState<string>();
  const [lobby, setLobby] = useState<RoomPresence>();
  const presenceRevisionRef = useRef(-1);
  const [selfId, setSelfId] = useState<string>();
  selfIdRef.current = selfId;
  const [copied, setCopied] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startUnavailableHint, setStartUnavailableHint] = useState<string>();
  const [startUnavailableHintClosing, setStartUnavailableHintClosing] =
    useState(false);
  const startUnavailableHintTimer = useRef<number | undefined>(undefined);
  const [error, setError] = useState<string>();
  const [entryFailure, setEntryFailure] = useState<RoomEntryFailure>();
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const [gameInfoOpen, setGameInfoOpen] = useState(false);
  const [isFavorite, setIsFavorite] = useState(false);
  const [playerMenuId, setPlayerMenuId] = useState<string>();
  const [playerMenuClosing, setPlayerMenuClosing] = useState(false);
  const [spectatorMenuOpen, setSpectatorMenuOpen] = useState(false);
  const [spectatorMenuAnchor, setSpectatorMenuAnchor] =
    useState<HTMLButtonElement>();
  const [lobbyMenuOpen, setLobbyMenuOpen] = useState(false);
  const [lobbyMenuAnchor, setLobbyMenuAnchor] = useState<HTMLButtonElement>();
  const [gameHelpHref, setGameHelpHref] = useState<string>();
  const [gameHelpOpen, setGameHelpOpen] = useState(false);
  const [changeGameOpen, setChangeGameOpen] = useState(false);
  const [dissolveDialogOpen, setDissolveDialogOpen] = useState(false);
  const gameName = game ? localizeGameName(game, locale) : t("gameRoom");
  const gameDescription = game
    ? localizeGameDescription(game, locale)
    : undefined;
  const gameOrigin = gameUrl ? new URL(gameUrl).origin : undefined;
  const clipboard = useClipboardRead(gameName, game?.manifestId, gameOrigin);
  const roomPlayerProfiles = useRoomPlayerProfileAccess(lobby);
  const userProfile = useUserProfileAccess(
    gameName,
    gameOrigin,
    game?.manifestId,
    nickname,
  );
  const windowDialogs = useGameWindowDialogs(gameName, gameOrigin);
  useEffect(() => {
    if (game) setIsFavorite(isFavoriteGame(game));
  }, [game]);

  const phase = lobby?.phase ?? "lobby";
  phaseRef.current = phase;
  // The manifest opts this room into Playweft's lobby UI. The embedded game
  // itself remains independent: it may later opt into bridge capabilities,
  // but does not need to do so for the room to exist.
  const showPlatformRoom = phase === "lobby";
  const showGameFrame = phase === "playing";
  const weChatLandscapeGuidance = shouldShowWeChatLandscapeGuidance(
    loadedGame?.game.orientation,
  );
  const gameViewport = useGameViewport(
    showGameFrame || weChatLandscapeGuidance,
    loadedGame?.game,
  );
  const isOwner = Boolean(selfId && lobby?.ownerId === selfId);
  const selfPlayer = lobby?.players.find((player) => player.id === selfId);
  const isSpectating = Boolean(selfId && lobby && !selfPlayer);
  const spectatorCount = lobby?.spectators.length ?? 0;
  const playerCapacity = lobby?.maxPlayers ?? 0;
  const playerGridColumns = desktopPlayerGridColumns(playerCapacity);
  const mobilePlayerGridColumns = mobilePlayerGridColumnsFor(playerCapacity);
  const playerGridDensity = playerGridDensityFor(playerCapacity);
  const playerGridClassName = [
    "player-grid",
    `player-grid-cols-${playerGridColumns}`,
    `player-grid-mobile-cols-${mobilePlayerGridColumns}`,
    `player-grid-${playerGridDensity}`,
  ].join(" ");

  const applyPresence = (next: RoomPresence): void => {
    if (next.revision < presenceRevisionRef.current) return;
    presenceRevisionRef.current = next.revision;
    const currentSelfId = selfIdRef.current;
    if (currentSelfId) {
      setHeartbeatRequiredRef.current?.(
        next.players.some((player) => player.id === currentSelfId),
      );
    }
    setLobby(next);
  };
  const applyRoomMembership = (membership: RoomJoin): void => {
    selfIdRef.current = membership.selfId;
    applyMembership(membership, applyPresence, setSelfId);
  };

  // The room phase is the single source of truth for the iframe lifecycle.
  // This handles both the local host transition and presence updates caused
  // by another client: playing mounts a fresh frame, lobby removes it.
  useEffect(() => {
    if (phase === "playing") {
      return;
    }
    latestSnapshotRef.current = undefined;
    bridgePort.current?.close();
    bridgePort.current = undefined;
  }, [phase]);

  useEffect(() => {
    if (!lobby) {
      roomProfileSnapshot.current = undefined;
      return;
    }
    const nextSnapshot = new Map(
      [...lobby.players, ...lobby.spectators].map((member) => [
        member.id,
        {
          ...(member.name ? { name: member.name } : {}),
          ...(member.avatarUrl ? { avatarUrl: member.avatarUrl } : {}),
        },
      ]),
    );
    const previousSnapshot = roomProfileSnapshot.current;
    roomProfileSnapshot.current = nextSnapshot;
    if (!previousSnapshot) return;

    const playerIds = new Set([
      ...previousSnapshot.keys(),
      ...nextSnapshot.keys(),
    ]);
    for (const playerId of playerIds) {
      const previous = previousSnapshot.get(playerId);
      const next = nextSnapshot.get(playerId);
      const fields: UserProfileField[] = [];
      if (!previous || !next || previous.name !== next.name) {
        fields.push("name");
      }
      if (!previous || !next || previous.avatarUrl !== next.avatarUrl) {
        fields.push("avatar");
      }
      if (fields.length > 0) {
        postRpcNotification(bridgePort.current, "room.players.profileChanged", {
          playerId,
          fields,
        });
      }
    }
  }, [lobby]);
  const firstOpenSeat = lobby
    ? Array.from({ length: lobby.maxPlayers }, (_, index) => index + 1).find(
        (seat) => !lobby.players.some((player) => player.seat === seat),
      )
    : undefined;
  const canStart = Boolean(
    lobby &&
    lobby.players.length >= lobby.minPlayers &&
    lobby.players.every(
      (player) => player.id === lobby.ownerId || player.ready,
    ),
  );
  const missingPlayerCount = lobby
    ? Math.max(0, lobby.minPlayers - lobby.players.length)
    : 0;
  const startUnavailableReason = starting
    ? t("startInProgress")
    : missingPlayerCount > 0
      ? t("needMorePlayers", {
          count: missingPlayerCount,
          suffix: locale === "en" && missingPlayerCount !== 1 ? "s" : "",
        })
      : !canStart
        ? t("waitingForPlayersReady")
        : undefined;

  useEffect(() => {
    document.title = `${gameName} | Playweft`;
    return () => {
      document.title = "Playweft";
    };
  }, [gameName]);

  useEffect(
    () => () => window.clearTimeout(startUnavailableHintTimer.current),
    [],
  );

  useEffect(() => {
    if (!identityReady) return;
    let cancelled = false;
    void (async () => {
      try {
        setError(undefined);
        await createGuestSession(nicknameRef.current);
        const launch = await getRoomLaunch(roomId);
        if (cancelled) return;
        setManifestUrl(launch.manifestUrl);
      } catch (reason) {
        if (!cancelled) {
          setEntryFailure(entryFailureFrom(reason));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [identityReady, roomId]);

  useEffect(() => {
    if (
      !selfId ||
      phaseRef.current !== "lobby" ||
      syncedNickname.current === nickname
    )
      return;
    let cancelled = false;
    void (async () => {
      try {
        await createGuestSession(nickname);
        const membership = await joinRoom(roomId);
        if (cancelled) return;
        syncedNickname.current = nickname;
        applyRoomMembership(membership);
      } catch (reason) {
        if (!cancelled) {
          setError(message(reason, tRef.current("unexpectedError")));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nickname, roomId, selfId]);

  useEffect(() => {
    if (!manifestUrl) return;
    let cancelled = false;
    setGameUrl(undefined);
    setLoadedGame(undefined);
    void loadGameManifest(manifestUrl)
      .then((loaded) => {
        if (cancelled) return;
        if (!loaded.room) {
          throw new Error("The game Manifest does not declare room mode");
        }
        setGame(loaded.game);
        setGameIconHref(loaded.game.icon);
        setGameHelpHref(loaded.game.helpUrl);
        onGameDiscovered(loaded.game);
        setLoadedGame(loaded);
        setGameUrl(loaded.game.url);
      })
      .catch((reason) => {
        if (!cancelled) {
          setEntryFailure(entryFailureFrom(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [manifestUrl, onGameDiscovered]);

  useEffect(() => {
    if (!gameUrl || !loadedGame?.room || gameViewport.deferGameLoad) return;
    const roomConfiguration = loadedGame.room;
    let socket: WebSocket | undefined;
    let heartbeatTimer: number | undefined;
    let reconnectTimer: number | undefined;
    let connectionErrorSuppressTimer: number | undefined;
    let reconnectAttempts = 0;
    let suppressConnectionError = false;
    let closed = false;
    let joined = false;
    let liveRoom = false;
    let joinedPlayerId: string | undefined;
    let heartbeatRequired = false;
    const capabilities = [
      ...new Set([
        ...PLATFORM_WINDOW_CAPABILITIES,
        "user.getProfile",
        "navigator.clipboard.readText",
        "room.players.getProfile",
      ]),
    ];
    let lastPublishedMatchId: string | undefined;
    let lastPublishedVersion = -1;
    let nextLatencySampleAt = 0;
    let latestLatencyRttMs: number | undefined;
    let latencyProbe:
      | {
          ackId: string;
          sentAt: number;
          timeout: number;
        }
      | undefined;
    const liveActionRequests = new Map<
      string,
      {
        resolve(value: JsonValue): void;
        reject(reason: RpcFault): void;
      }
    >();
    const currentGameOrigin = new URL(gameUrl).origin;
    const clearLatencyProbe = () => {
      if (!latencyProbe) return;
      window.clearTimeout(latencyProbe.timeout);
      latencyProbe = undefined;
    };
    const latencyAckForNextMessage = (): string | undefined => {
      const now = performance.now();
      if (latencyProbe || now < nextLatencySampleAt) return undefined;
      const ackId = crypto.randomUUID();
      const probe = {
        ackId,
        sentAt: now,
        timeout: window.setTimeout(() => {
          if (latencyProbe?.ackId === ackId) latencyProbe = undefined;
        }, LATENCY_PROBE_TIMEOUT_MS),
      };
      latencyProbe = probe;
      return ackId;
    };
    const sendRealtimeMessage = (
      target: WebSocket,
      message: Record<string, JsonValue>,
    ) => {
      const ackId = latencyAckForNextMessage();
      try {
        target.send(JSON.stringify(ackId ? { ...message, ackId } : message));
      } catch (error) {
        if (latencyProbe?.ackId === ackId) clearLatencyProbe();
        throw error;
      }
    };
    const publishLatency = (rttMs: number) => {
      latestLatencyRttMs = rttMs;
      postRpcNotification(bridgePort.current, "platform.latency", { rttMs });
    };
    const clearHeartbeat = () => {
      window.clearTimeout(heartbeatTimer);
      heartbeatTimer = undefined;
    };
    const scheduleHeartbeat = () => {
      clearHeartbeat();
      if (!heartbeatRequired || closed) return;
      heartbeatTimer = window.setTimeout(() => {
        heartbeatTimer = undefined;
        if (socket?.readyState === WebSocket.OPEN)
          sendRealtimeMessage(socket, { type: "heartbeat" });
        scheduleHeartbeat();
      }, HEARTBEAT_IDLE_MS);
    };
    const noteClientActivity = () => {
      if (heartbeatRequired) scheduleHeartbeat();
    };
    const setHeartbeatRequired = (required: boolean) => {
      if (heartbeatRequired === required) return;
      heartbeatRequired = required;
      if (!required) {
        clearHeartbeat();
        return;
      }
      if (socket?.readyState === WebSocket.OPEN) {
        sendRealtimeMessage(socket, { type: "heartbeat" });
      }
      scheduleHeartbeat();
    };
    setHeartbeatRequiredRef.current = setHeartbeatRequired;
    const sendSnapshot = (snapshot: RoomSnapshot) => {
      postRpcNotification(bridgePort.current, "game.state", {
        phase: "playing",
        state: snapshot.state,
        events: snapshot.events ?? [],
        matchId: snapshot.matchId,
        version: snapshot.version,
        serverTime: snapshot.serverTime,
      });
    };

    const publish = (snapshot: RoomSnapshot) => {
      if (snapshot.matchId !== lastPublishedMatchId) {
        lastPublishedMatchId = snapshot.matchId;
        lastPublishedVersion = -1;
      }
      if (snapshot.version <= lastPublishedVersion) return;
      lastPublishedVersion = snapshot.version;
      latestSnapshotRef.current = snapshot;
      sendSnapshot(snapshot);
    };

    const reportBridgeError = (code: string, error: string) => {
      postRpcNotification(bridgePort.current, "platform.error", {
        error: { code, message: error, retryable: false },
      });
    };

    const rejectLiveActions = (code: string, error: string) => {
      for (const pending of liveActionRequests.values()) {
        pending.reject(rpcPlatformFault(code, error, true));
      }
      liveActionRequests.clear();
    };

    const suppressNextConnectionError = () => {
      suppressConnectionError = true;
      window.clearTimeout(connectionErrorSuppressTimer);
      connectionErrorSuppressTimer = window.setTimeout(() => {
        suppressConnectionError = false;
      }, 5_000);
    };

    const connect = () => {
      window.clearTimeout(reconnectTimer);
      clearHeartbeat();
      clearLatencyProbe();
      nextLatencySampleAt = 0;
      rejectLiveActions(
        "REALTIME_CONNECTION_INTERRUPTED",
        tRef.current("liveConnectionNotReady"),
      );
      socket?.close();
      const nextSocket = connectRoom(roomId);
      let receivedServerSignal = false;
      socket = nextSocket;
      nextSocket.onopen = () => {
        // The first message gives every connected game a latency sample.
        // Subsequent heartbeats are only needed while this player can become
        // (or remain) the room host.
        sendRealtimeMessage(nextSocket, { type: "heartbeat" });
        scheduleHeartbeat();
      };
      nextSocket.onmessage = (event) => {
        const payload = JSON.parse(event.data as string) as
          | RoomSnapshot
          | RoomPresence
          | RoomActionResult
          | PlatformLatencyAck
          | { type: "game_changed"; manifestUrl: string }
          | { type: "room_dissolved"; error: string }
          | { type: "error"; error: string; requestId?: string };
        if (payload.type === "room_dissolved") {
          closed = true;
          socket?.close();
          onBack();
          return;
        }
        if (payload.type === "platform.ack") {
          if (payload.ackId !== latencyProbe?.ackId) return;
          const rttMs = Math.round(performance.now() - latencyProbe.sentAt);
          clearLatencyProbe();
          nextLatencySampleAt = performance.now() + LATENCY_SAMPLE_INTERVAL_MS;
          publishLatency(rttMs);
          return;
        }
        if (payload.type === "action-result") {
          const pending = liveActionRequests.get(payload.requestId);
          if (pending) {
            liveActionRequests.delete(payload.requestId);
            pending.resolve(actionResultForRpc(payload));
          }
          return;
        }
        if (payload.type === "error") {
          if (payload.requestId) {
            const pending = liveActionRequests.get(payload.requestId);
            if (pending) {
              liveActionRequests.delete(payload.requestId);
              pending.reject(
                rpcPlatformFault("ACTION_REJECTED", payload.error),
              );
            }
            return;
          }
          setError(payload.error);
          reportBridgeError("ROOM_ERROR", payload.error);
          return;
        }
        receivedServerSignal = true;
        reconnectAttempts = 0;
        setError(undefined);
        if (payload.type === "game_changed") {
          setLobby(undefined);
          setGame(undefined);
          setGameHelpHref(undefined);
          setGameHelpOpen(false);
          setManifestUrl(payload.manifestUrl);
          setGameRevision((revision) => revision + 1);
        } else if (payload.type === "room.presence") {
          if (payload.phase === "lobby" && phaseRef.current === "playing")
            latestSnapshotRef.current = undefined;
          applyPresence(payload);
        } else {
          publish(payload);
        }
      };
      nextSocket.onerror = () => {
        if (suppressConnectionError) {
          suppressConnectionError = false;
          window.clearTimeout(connectionErrorSuppressTimer);
          return;
        }
        setError(tRef.current("liveConnectionFailed"));
        reportBridgeError(
          "REALTIME_CONNECTION_FAILED",
          tRef.current("liveConnectionFailed"),
        );
      };
      nextSocket.onclose = (event) => {
        clearHeartbeat();
        if (closed || socket !== nextSocket) return;
        rejectLiveActions(
          "REALTIME_CONNECTION_INTERRUPTED",
          tRef.current("liveConnectionNotReady"),
        );
        if (event.code === 4004) {
          closed = true;
          onBack();
          return;
        }
        if (receivedServerSignal) reconnectAttempts = 0;
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
          const error = tRef.current("liveConnectionNotRestored");
          setError(error);
          reportBridgeError("REALTIME_CONNECTION_FAILED", error);
          return;
        }
        reconnectAttempts += 1;
        if (!closed) {
          reconnectTimer = window.setTimeout(connect, 2_000);
        }
      };
    };

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible" || !joined) return;
      suppressNextConnectionError();
      setError(undefined);
      reconnectAttempts = 0;
      connect();
    };

    // A room manifest is sufficient to run the platform room. Bridge support
    // is deliberately optional: a game may use its own networking, or ask for
    // this context later through `game.initialize`.
    const roomReady = (async () => {
      const roomInitialization = roomConfiguration;
      liveRoom = roomInitialization.liveRoom === true;
      await initializeRoom(roomId, roomInitialization);
      const membership = await joinRoom(roomId);
      if (closed) {
        throw rpcPlatformFault(
          "ROOM_CLOSED",
          "The room host was closed before initialization completed",
          true,
        );
      }
      applyRoomMembership(membership);
      syncedNickname.current = nicknameRef.current;
      joined = true;
      joinedPlayerId = membership.selfId;
      // Room membership owns the avatar shown in the outer player list. Keep
      // that sync independent from the game iframe, which is intentionally
      // not mounted while the room is waiting to start.
      void getPlatformSession()
        .then((session) =>
          setRoomProfileAvatarSharing(
            roomId,
            session.provider === "x" && Boolean(session.avatarUrl),
          ),
        )
        .then(applyPresence)
        .catch(() => undefined);
      connect();
      return membership;
    })();
    void roomReady.catch((reason) => {
      if (closed) return;
      setEntryFailure(entryFailureFrom(reason));
    });

    const detachBridge = attachGameBridge({
      frame: iframe,
      origin: currentGameOrigin,
      canConnect: () => phaseRef.current === "playing",
      onBeforeConnect() {
        clipboard.cancelPending();
        userProfile.cancelPending();
        windowDialogs.cancelPending();
        rejectLiveActions("BRIDGE_REPLACED", "The game bridge was replaced");
      },
      onPortChange(port) {
        bridgePort.current = port;
        if (port && latestLatencyRttMs !== undefined) {
          postRpcNotification(port, "platform.latency", {
            rttMs: latestLatencyRttMs,
          });
        }
      },
      handlers: {
        "game.initialize": {
          async handle() {
            try {
              await roomReady;
              if (closed || !joinedPlayerId) {
                throw rpcPlatformFault(
                  "BRIDGE_CLOSED",
                  "The game bridge was closed",
                  true,
                );
              }
              const snapshot = latestSnapshotRef.current;
              if (snapshot) {
                window.setTimeout(() => {
                  if (!closed && latestSnapshotRef.current === snapshot)
                    sendSnapshot(snapshot);
                }, 0);
              }
              return {
                mode: "room",
                protocolVersion: PLAYWEFT_BRIDGE_VERSION,
                capabilities,
                playerId: joinedPlayerId,
                player: {
                  id: joinedPlayerId,
                  ...(nicknameRef.current ? { name: nicknameRef.current } : {}),
                },
              };
            } catch (reason) {
              const error = message(reason, tRef.current("unexpectedError"));
              reportBridgeError("INITIALIZATION_REJECTED", error);
              if (reason instanceof RpcFault) throw reason;
              throw rpcPlatformFault("INITIALIZATION_REJECTED", error);
            }
          },
        },
        "room.action": {
          async handle(params, requestId) {
            if (!requestId) {
              throw new RpcFault(
                JsonRpcErrorCode.InvalidRequest,
                "room.action requires a JSON-RPC id",
              );
            }
            const action = actionFromRpcParams(params);
            if (!joined || phaseRef.current === "lobby") {
              throw rpcPlatformFault(
                "GAME_NOT_STARTED",
                tRef.current("gameNotStarted"),
              );
            }
            if (liveRoom) {
              if (!socket || socket.readyState !== WebSocket.OPEN) {
                throw rpcPlatformFault(
                  "REALTIME_CONNECTION_NOT_READY",
                  tRef.current("liveConnectionNotReady"),
                  true,
                );
              }
              if (liveActionRequests.has(requestId)) {
                throw rpcPlatformFault(
                  "DUPLICATE_REQUEST",
                  "A request with this JSON-RPC id is already pending",
                );
              }
              const result = new Promise<JsonValue>((resolve, reject) => {
                liveActionRequests.set(requestId, { resolve, reject });
              });
              noteClientActivity();
              sendRealtimeMessage(socket, {
                type: "action",
                requestId,
                action,
              });
              return result;
            }
            try {
              noteClientActivity();
              const response = await sendAction(roomId, requestId, action);
              if (response.update) publish(response.update);
              return actionResultForRpc(response.result);
            } catch (reason) {
              throw rpcPlatformFault(
                "ACTION_REJECTED",
                message(reason, tRef.current("unexpectedError")),
              );
            }
          },
        },
        "navigator.clipboard.readText": {
          async handle() {
            return clipboard.requestReadText();
          },
        },
        "room.players.getProfile": {
          async handle(params) {
            const request = roomPlayerProfileRequestFromRpcParams(params);
            if (!request) {
              throw new RpcFault(
                JsonRpcErrorCode.InvalidParams,
                "room.players.getProfile expects { playerId, fields: ['name' | 'avatar', ...] }",
              );
            }
            if (
              request.fields.includes("avatar") &&
              request.playerId === joinedPlayerId
            ) {
              const ownProfile = await userProfile.requestProfile(
                request.fields,
              );
              let nextPresence: RoomPresence;
              try {
                nextPresence = await setRoomProfileAvatarSharing(
                  roomId,
                  ownProfile.avatar !== undefined,
                );
              } catch (reason) {
                throw rpcPlatformFault(
                  "PROFILE_SHARE_FAILED",
                  message(reason, tRef.current("unexpectedError")),
                );
              }
              applyPresence(nextPresence);
              return roomPlayerProfiles.requestProfile(
                request.playerId,
                request.fields,
                nextPresence,
              );
            }
            return roomPlayerProfiles.requestProfile(
              request.playerId,
              request.fields,
            );
          },
        },
        "user.getProfile": {
          async handle(params) {
            const fields = userProfileFieldsFromRpcParams(params);
            if (!fields) {
              throw new RpcFault(
                JsonRpcErrorCode.InvalidParams,
                "user.getProfile expects { fields: ['name' | 'avatar', ...] }",
              );
            }
            const profile = await userProfile.requestProfile(fields);
            if (fields.includes("avatar")) {
              try {
                const nextLobby = await setRoomProfileAvatarSharing(
                  roomId,
                  profile.avatar !== undefined,
                );
                applyPresence(nextLobby);
              } catch (reason) {
                throw rpcPlatformFault(
                  "PROFILE_SHARE_FAILED",
                  message(reason, tRef.current("unexpectedError")),
                );
              }
            }
            return profile;
          },
        },
        "window.alert": {
          handle: windowDialogs.requestAlert,
        },
        "window.confirm": {
          handle: windowDialogs.requestConfirm,
        },
      },
    });

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      closed = true;
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(connectionErrorSuppressTimer);
      clearHeartbeat();
      clearLatencyProbe();
      socket?.close();
      rejectLiveActions("BRIDGE_CLOSED", "The game bridge was closed");
      clipboard.cancelPending();
      userProfile.cancelPending();
      windowDialogs.cancelPending();
      detachBridge();
      if (setHeartbeatRequiredRef.current === setHeartbeatRequired) {
        setHeartbeatRequiredRef.current = undefined;
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [
    gameUrl,
    gameViewport.deferGameLoad,
    loadedGame,
    onGameDiscovered,
    roomId,
    clipboard.cancelPending,
    clipboard.requestReadText,
    roomPlayerProfiles.requestProfile,
    userProfile.cancelPending,
    userProfile.requestProfile,
    windowDialogs.cancelPending,
    windowDialogs.requestAlert,
    windowDialogs.requestConfirm,
  ]);

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setError(t("inviteCopyFailed"));
    }
  };

  const start = async () => {
    const orientationAttempt = prepareGameOrientation(
      loadedGame?.game.orientation,
    );
    let started = false;
    setStarting(true);
    try {
      setError(undefined);
      const startedRoom = await startRoom(roomId);
      const snapshot = startedRoom.snapshot;
      latestSnapshotRef.current = snapshot;
      applyPresence(startedRoom.presence);
      postRpcNotification(bridgePort.current, "game.state", {
        phase: "playing",
        state: snapshot.state,
        events: snapshot.events ?? [],
        matchId: snapshot.matchId,
        version: snapshot.version,
        serverTime: snapshot.serverTime,
      });
      started = true;
    } catch (reason) {
      setError(message(reason, t("unexpectedError")));
    } finally {
      setStarting(false);
      if (!started) {
        void orientationAttempt.then(() => releaseGameFullscreen());
      }
    }
  };

  const kick = async (playerId: string) => {
    try {
      const nextLobby = await kickPlayer(roomId, playerId);
      applyPresence(nextLobby);
    } catch (reason) {
      setError(message(reason, t("unexpectedError")));
    }
  };

  const transferHost = async (playerId: string) => {
    try {
      setError(undefined);
      applyPresence(await transferRoomHost(roomId, playerId));
    } catch (reason) {
      setError(message(reason, t("unexpectedError")));
    }
  };

  const returnToRoom = async () => {
    try {
      setError(undefined);
      const nextLobby = await returnRoomToLobby(roomId);
      latestSnapshotRef.current = undefined;
      applyPresence(nextLobby);
      setGameInfoOpen(false);
    } catch (reason) {
      setError(message(reason, t("unexpectedError")));
    }
  };

  const changeGame = async (url: string) => {
    try {
      setError(undefined);
      setChangeGameOpen(false);
      const next = await loadGameManifest(manifestUrlFromInput(url));
      if (!next.manifest.modes.room) {
        throw new Error("The game Manifest does not declare room mode");
      }
      await changeRoomGame(roomId, next.game.manifestUrl);
    } catch (reason) {
      setError(message(reason, t("unexpectedError")));
    }
  };

  const dissolve = async () => {
    try {
      setError(undefined);
      await dissolveRoom(roomId);
      onBack();
    } catch (reason) {
      setError(message(reason, t("unexpectedError")));
    }
  };

  const chooseSeat = async (seat: number | null) => {
    try {
      setError(undefined);
      applyPresence(await setRoomSeat(roomId, seat));
    } catch (reason) {
      setError(message(reason, t("unexpectedError")));
    }
  };

  const setReady = async () => {
    if (!selfPlayer) return;
    try {
      setError(undefined);
      applyPresence(await setPlayerReady(roomId, !selfPlayer.ready));
    } catch (reason) {
      setError(message(reason, t("unexpectedError")));
    }
  };

  const showStartUnavailableHint = () => {
    if (!startUnavailableReason) return;
    setStartUnavailableHint(startUnavailableReason);
    setStartUnavailableHintClosing(false);
    window.clearTimeout(startUnavailableHintTimer.current);
    startUnavailableHintTimer.current = window.setTimeout(
      () => setStartUnavailableHintClosing(true),
      2_500,
    );
  };

  const joinFirstOpenSeat = async () => {
    if (firstOpenSeat === undefined) return;
    await chooseSeat(firstOpenSeat);
  };

  const requestBack = () => {
    if (selfId) setLeaveDialogOpen(true);
    else onBack();
  };

  const leave = async () => {
    try {
      setError(undefined);
      await leaveRoom(roomId);
      onBack();
    } catch (reason) {
      setError(message(reason, t("unexpectedError")));
    }
  };

  const closePlayerMenu = (after?: () => void) => {
    if (!playerMenuId || playerMenuClosing) return;
    setPlayerMenuClosing(true);
    window.setTimeout(() => {
      setPlayerMenuId(undefined);
      setPlayerMenuClosing(false);
      after?.();
    }, 140);
  };

  const togglePlayerMenu = (playerId: string) => {
    if (playerMenuClosing) return;
    if (playerMenuId === playerId) {
      closePlayerMenu();
      return;
    }
    setPlayerMenuClosing(false);
    setPlayerMenuId(playerId);
  };

  if (entryFailure) {
    return <RoomEntryFailureState failure={entryFailure} onBack={onBack} />;
  }

  if (gameViewport.deferGameLoad) {
    return (
      <GameViewport
        infoExpanded={false}
        onOpenInfo={() => undefined}
        orientationAction={gameViewport.orientationAction}
        onEnterPreferredOrientation={() =>
          void gameViewport.enterPreferredOrientation()
        }
        onEnableLandscapeCompatibility={
          gameViewport.showLandscapeCompatibility
            ? gameViewport.enableLandscapeCompatibility
            : undefined
        }
        landscapeCompatibilityRotation={
          gameViewport.landscapeCompatibilityRotation
        }
        showOptions={false}
      >
        {null}
      </GameViewport>
    );
  }

  if (!lobby || !selfId) {
    return <RoomEntryLoadingState />;
  }

  return (
    <div className={`room-shell ${showGameFrame ? "room-playing" : ""}`}>
      {showPlatformRoom && (
        <header className="topbar room-topbar">
          <button
            className="brand room-brand"
            onClick={requestBack}
            aria-label={t("backToPlayweftHome")}
          >
            <img className="brand-mark" src="/favicon.svg" alt="" />
            <span className="room-brand-name">playweft</span>
          </button>
          <span className="room-mobile-game-name" title={gameName}>
            {gameName}
          </span>
          <PlayerProfileMenu
            nickname={nickname}
            onNicknameChange={onNicknameChange}
          />
        </header>
      )}
      <main className="room-host">
        {showPlatformRoom && (
          <>
            <div className="room-id">
              <RoomIdCopy
                roomId={roomId}
                onCopyError={() => setError(t("roomNumberCopyFailed"))}
              />
              <div className="room-id-controls">
                <button
                  className="room-id-control"
                  type="button"
                  aria-label={t("spectatorCount", {
                    count: spectatorCount,
                    suffix: locale === "en" && spectatorCount !== 1 ? "s" : "",
                  })}
                  aria-haspopup="dialog"
                  aria-expanded={spectatorMenuOpen}
                  title={t("spectators")}
                  onClick={(event) => {
                    setSpectatorMenuAnchor(event.currentTarget);
                    setSpectatorMenuOpen(true);
                  }}
                >
                  <Eye aria-hidden="true" />
                  {spectatorCount > 0 && (
                    <span className="room-id-control-badge" aria-hidden="true">
                      {spectatorCount > 99 ? "99+" : spectatorCount}
                    </span>
                  )}
                </button>
                <button
                  className="room-id-control"
                  type="button"
                  aria-label={t("shareRoom")}
                  aria-haspopup="dialog"
                  aria-expanded={inviteDialogOpen}
                  title={t("shareRoom")}
                  onClick={() => setInviteDialogOpen(true)}
                >
                  <Share2 aria-hidden="true" />
                </button>
                <button
                  className="room-id-control"
                  type="button"
                  aria-label={t("roomOptions")}
                  aria-expanded={lobbyMenuOpen}
                  onClick={(event) => {
                    setLobbyMenuAnchor(event.currentTarget);
                    setLobbyMenuOpen(true);
                  }}
                >
                  <MoreHorizontal aria-hidden="true" />
                </button>
              </div>
            </div>
            <header className="room-hero">
              <div className="room-hero-heading">
                {gameIconHref && (
                  <img
                    className="room-hero-icon"
                    src={gameIconHref}
                    alt=""
                    referrerPolicy="no-referrer"
                  />
                )}
                <h1>{gameName}</h1>
              </div>
            </header>
            <section className="lobby-panel" aria-live="polite">
              <ol className={playerGridClassName}>
                {Array.from({ length: playerCapacity }, (_, index) => {
                  const seat = index + 1;
                  const player = lobby?.players.find(
                    (candidate) => candidate.seat === seat,
                  );
                  if (!player)
                    return (
                      <li
                        key={`seat-${seat}`}
                        className="player-card player-card-empty"
                      >
                        <button
                          className="player-card-action"
                          type="button"
                          onClick={() => void chooseSeat(seat)}
                          aria-label={
                            isSpectating
                              ? t("joinSeat", { seat })
                              : t("moveToSeat", { seat })
                          }
                        />
                        <span className="player-avatar player-avatar-seat">
                          <Armchair aria-hidden="true" />
                        </span>
                        <span className="player-card-copy">
                          <strong className="player-name">
                            {t("sitHere")}
                          </strong>
                        </span>
                      </li>
                    );
                  const isSelf = player.id === selfId;
                  const isHost = player.id === lobby?.ownerId;
                  const playerName = player.name || t("player", { seat });
                  return (
                    <li
                      key={player.id}
                      className={`player-card player-card-occupied ${isSelf ? "player-card-self" : "player-card-other"} ${playerMenuId === player.id ? "player-card-menu-open" : ""}`}
                    >
                      <div className="player-avatar-wrap">
                        <span
                          className={`player-avatar avatar-${(seat - 1) % 4} ${isSelf ? "player-avatar-self" : ""}`}
                          title={isSelf ? t("you") : undefined}
                        >
                          {player.avatarUrl ? (
                            <img
                              src={player.avatarUrl}
                              alt=""
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <>P{seat}</>
                          )}
                          {!isHost && (
                            <span
                              className={`player-ready-marker ${player.ready ? "player-ready-marker-ready" : "player-ready-marker-pending"}`}
                              title={player.ready ? t("ready") : t("notReady")}
                              aria-label={
                                player.ready ? t("ready") : t("notReady")
                              }
                            >
                              {player.ready && <Check aria-hidden="true" />}
                            </span>
                          )}
                        </span>
                        {isOwner && !isSelf && (
                          <>
                            {playerMenuId === player.id && (
                              <button
                                className={`player-menu-backdrop ${playerMenuClosing ? "player-menu-backdrop-closing" : ""}`}
                                type="button"
                                aria-label={t("closePlayerMenu")}
                                onClick={() => closePlayerMenu()}
                              />
                            )}
                            <button
                              className="player-menu-toggle"
                              type="button"
                              aria-label={t("playerOptions", {
                                name: playerName,
                              })}
                              aria-expanded={playerMenuId === player.id}
                              onClick={() => togglePlayerMenu(player.id)}
                            >
                              <MoreHorizontal aria-hidden="true" />
                            </button>
                            {playerMenuId === player.id && (
                              <div
                                className={`player-menu ${playerMenuClosing ? "player-menu-closing" : ""}`}
                                role="menu"
                              >
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() =>
                                    closePlayerMenu(
                                      () => void transferHost(player.id),
                                    )
                                  }
                                >
                                  {t("makeHost")}
                                </button>
                                <button
                                  className="player-menu-remove"
                                  type="button"
                                  role="menuitem"
                                  onClick={() =>
                                    closePlayerMenu(() => void kick(player.id))
                                  }
                                >
                                  {t("remove")}
                                </button>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                      <span className="player-card-copy">
                        <strong className="player-name" title={player.name}>
                          {playerName}
                          {isHost && (
                            <span
                              className="host-crown"
                              title={t("host")}
                              aria-label={t("host")}
                            >
                              <Crown aria-hidden="true" />
                            </span>
                          )}
                        </strong>
                      </span>
                    </li>
                  );
                })}
              </ol>
            </section>
            <div className="room-actions">
              {isOwner && (
                <button
                  className="primary start-game"
                  aria-disabled={startUnavailableReason ? true : undefined}
                  aria-describedby={
                    startUnavailableHint ? "start-unavailable-hint" : undefined
                  }
                  onClick={() => {
                    if (startUnavailableReason) {
                      showStartUnavailableHint();
                      return;
                    }
                    void start();
                  }}
                >
                  {starting ? t("starting") : t("startGame")}
                  {startUnavailableHint && (
                    <span
                      className={`start-game-tooltip ${startUnavailableHintClosing ? "start-game-tooltip-exiting" : ""}`}
                      id="start-unavailable-hint"
                      role="tooltip"
                      onAnimationEnd={() => {
                        if (!startUnavailableHintClosing) return;
                        setStartUnavailableHint(undefined);
                        setStartUnavailableHintClosing(false);
                      }}
                    >
                      {startUnavailableHint}
                    </span>
                  )}
                </button>
              )}
              {!isOwner && selfPlayer && (
                <button
                  className={
                    selfPlayer.ready ? "cancel-ready" : "primary start-game"
                  }
                  onClick={() => void setReady()}
                >
                  {selfPlayer.ready ? t("cancelReady") : t("ready")}
                </button>
              )}
              {!isOwner && isSpectating && (
                <button
                  className="primary start-game"
                  disabled={firstOpenSeat === undefined}
                  onClick={() => void joinFirstOpenSeat()}
                >
                  {t("joinRoom")}
                </button>
              )}
              <button onClick={() => void copyInvite()}>
                {copied ? t("inviteLinkCopied") : t("copyInviteLink")}
              </button>
            </div>
          </>
        )}
        <GameViewport
          infoExpanded={gameInfoOpen}
          onOpenInfo={() => setGameInfoOpen(true)}
          orientationAction={gameViewport.orientationAction}
          showOptions={phase === "playing" && !gameViewport.deferGameLoad}
          onEnterPreferredOrientation={() =>
            void gameViewport.enterPreferredOrientation()
          }
          onEnableLandscapeCompatibility={
            gameViewport.showLandscapeCompatibility
              ? gameViewport.enableLandscapeCompatibility
              : undefined
          }
          landscapeCompatibilityRotation={
            gameViewport.landscapeCompatibilityRotation
          }
        >
          {phase === "playing" && gameUrl && !gameViewport.deferGameLoad && (
            <GameFrame
              key={gameRevision}
              ref={iframe}
              title={gameName}
              src={gameUrl}
            />
          )}
        </GameViewport>
      </main>
      <ClipboardPrompt
        prompt={clipboard.prompt}
        notice={clipboard.notice}
        onAllow={() => void clipboard.allow()}
        onDeny={clipboard.deny}
        onDismissNotice={clipboard.clearNotice}
      />
      <UserProfilePrompt
        prompt={userProfile.prompt}
        onAllow={userProfile.allow}
        onDeny={userProfile.deny}
      />
      {windowDialogs.dialog && (
        <GameWindowDialog
          dialog={windowDialogs.dialog}
          onConfirm={windowDialogs.confirm}
          onDismiss={windowDialogs.dismiss}
        />
      )}
      {error && (
        <ErrorToast message={error} onDismiss={() => setError(undefined)} />
      )}
      {inviteDialogOpen && (
        <InviteDialog
          roomId={roomId}
          url={window.location.href}
          onRoomIdCopyError={() => setError(t("roomNumberCopyFailed"))}
          onClose={() => setInviteDialogOpen(false)}
        />
      )}
      {leaveDialogOpen && (
        <Dialog
          title={t("leaveRoom")}
          onDismiss={() => setLeaveDialogOpen(false)}
          actions={[
            { label: t("cancel") },
            {
              label: t("leave"),
              variant: "danger",
              onSelect: () => void leave(),
            },
          ]}
        >
          <p className="leave-dialog-copy">{t("needRoomLinkToReturn")}</p>
        </Dialog>
      )}
      {dissolveDialogOpen && (
        <Dialog
          title={t("dissolveRoom")}
          onDismiss={() => setDissolveDialogOpen(false)}
          actions={[
            { label: t("cancel") },
            {
              label: t("dissolveRoomAction"),
              variant: "danger",
              onSelect: () => void dissolve(),
            },
          ]}
        >
          <p className="leave-dialog-copy">{t("dissolveRoomDescription")}</p>
        </Dialog>
      )}
      {gameHelpOpen && gameHelpHref && (
        <GameHelpDialog
          name={gameName}
          url={gameHelpHref}
          onClose={() => setGameHelpOpen(false)}
        />
      )}
      {changeGameOpen && (
        <ChangeGameDialog
          onClose={() => setChangeGameOpen(false)}
          onSubmit={(url) => void changeGame(url)}
        />
      )}
      {phase === "lobby" && lobbyMenuOpen && lobbyMenuAnchor && (
        <Menu
          ariaLabel={t("roomOptions")}
          anchor={lobbyMenuAnchor}
          className="lobby-menu"
          onClose={() => setLobbyMenuOpen(false)}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setLobbyMenuOpen(false);
              setGameInfoOpen(true);
            }}
          >
            {t("gameInfo")}
          </button>
          {gameHelpHref && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setLobbyMenuOpen(false);
                setGameHelpOpen(true);
              }}
            >
              {t("gameHelp")}
            </button>
          )}
          {isOwner && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setLobbyMenuOpen(false);
                setChangeGameOpen(true);
              }}
            >
              {t("changeGame")}
            </button>
          )}
          {isOwner ? (
            <button
              className="menu-danger"
              type="button"
              role="menuitem"
              onClick={() => {
                setLobbyMenuOpen(false);
                setDissolveDialogOpen(true);
              }}
            >
              {t("dissolveRoomAction")}
            </button>
          ) : (
            <button
              className="menu-danger"
              type="button"
              role="menuitem"
              onClick={() => {
                setLobbyMenuOpen(false);
                requestBack();
              }}
            >
              {t("leaveRoomAction")}
            </button>
          )}
        </Menu>
      )}
      {phase === "lobby" && spectatorMenuOpen && spectatorMenuAnchor && (
        <Menu
          ariaLabel={t("spectators")}
          anchor={spectatorMenuAnchor}
          className="spectator-menu"
          role="dialog"
          onClose={() => setSpectatorMenuOpen(false)}
        >
          {(closeMenu) => (
            <>
              {selfPlayer && !isOwner && (
                <>
                  <button
                    className="spectator-menu-action"
                    type="button"
                    onClick={() => closeMenu(() => void chooseSeat(null))}
                  >
                    <Eye aria-hidden="true" />
                    <span>{t("switchToSpectating")}</span>
                  </button>
                  <div className="spectator-menu-divider" role="separator" />
                </>
              )}
              <div className="spectator-menu-heading">{t("spectators")}</div>
              {spectatorCount > 0 ? (
                <ul className="spectator-menu-list">
                  {lobby?.spectators.map((spectator, index) => (
                    <li key={spectator.id}>
                      <span className="spectator-menu-avatar">
                        {spectator.avatarUrl ? (
                          <img
                            src={spectator.avatarUrl}
                            alt=""
                            loading="lazy"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <UserRound aria-hidden="true" />
                        )}
                      </span>
                      <span className="spectator-menu-name">
                        {spectator.name ||
                          t("spectatorFallback", { number: index + 1 })}
                      </span>
                      {spectator.id === selfId && <small>{t("you")}</small>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="spectator-menu-empty">{t("noSpectators")}</p>
              )}
            </>
          )}
        </Menu>
      )}
      {gameInfoOpen && gameUrl && game && (
        <GameInfoPanel
          description={gameDescription}
          exitAction={
            phase === "playing" && isOwner
              ? {
                  label: t("returnToRoom"),
                  onSelect: () => void returnToRoom(),
                }
              : undefined
          }
          icon={gameIconHref}
          isFavorite={isFavorite}
          manifestUrl={game.manifestUrl}
          name={gameName}
          url={game.url}
          onClose={() => setGameInfoOpen(false)}
          onEnterFullscreen={
            gameViewport.showFullscreenAction
              ? () => void gameViewport.enterPreferredOrientation()
              : undefined
          }
          onEnableLandscapeCompatibility={
            gameViewport.showLandscapeCompatibility
              ? gameViewport.enableLandscapeCompatibility
              : undefined
          }
          landscapeCompatibilityRotation={
            gameViewport.landscapeCompatibilityRotation
          }
          onShowHelp={gameHelpHref ? () => setGameHelpOpen(true) : undefined}
          onRefresh={
            phase === "playing"
              ? () => {
                  bridgePort.current?.close();
                  bridgePort.current = undefined;
                  setGameRevision((revision) => revision + 1);
                }
              : undefined
          }
          onToggleFavorite={() => setIsFavorite(toggleFavoriteGame(game))}
        />
      )}
    </div>
  );
}

function applyMembership(
  membership: RoomJoin,
  setPresence: (presence: RoomPresence) => void,
  setSelfId: (id: string) => void,
): void {
  const { selfId, ...presence } = membership;
  setSelfId(selfId);
  setPresence(presence);
}

function message(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

function entryFailureFrom(reason: unknown): RoomEntryFailure {
  return reason instanceof PlatformApiError && reason.status === 404
    ? "not-found"
    : "unavailable";
}

function RoomEntryLoadingState() {
  const { t } = useI18n();
  return (
    <main className="room-entry-state">
      <div
        className="room-entry-state-content"
        role="status"
        aria-label={t("loadingGame")}
      >
        <span className="loading-spinner" aria-hidden="true" />
      </div>
    </main>
  );
}

function RoomEntryFailureState({
  failure,
  onBack,
}: {
  failure: RoomEntryFailure;
  onBack(): void;
}) {
  const { t } = useI18n();
  return (
    <main className="room-entry-state">
      <div className="room-entry-state-content">
        <span className="room-entry-state-icon" aria-hidden="true">
          <DoorClosed />
        </span>
        <h1>{t(failure === "not-found" ? "roomNotFound" : "roomUnavailable")}</h1>
        <button className="primary" type="button" onClick={onBack}>
          {t("backHome")}
        </button>
      </div>
    </main>
  );
}

function desktopPlayerGridColumns(capacity: number): 2 | 3 | 4 {
  if (capacity <= 2) return 2;
  if (capacity === 3) return 3;
  if (capacity === 4) return 4;
  if (capacity <= 6 || capacity === 9) return 3;
  return 4;
}

function mobilePlayerGridColumnsFor(capacity: number): 1 | 2 | 3 | 4 {
  if (capacity <= 4) return 1;
  if (capacity <= 8) return 2;
  if (capacity <= 12) return 3;
  return 4;
}

function playerGridDensityFor(capacity: number): "full" | "compact" | "dense" {
  if (capacity <= 4) return "full";
  if (capacity <= 12) return "compact";
  return "dense";
}

function actionFromRpcParams(params: JsonValue | undefined): JsonValue {
  if (
    params === null ||
    typeof params !== "object" ||
    Array.isArray(params) ||
    !("action" in params) ||
    !isJson(params.action)
  ) {
    throw new RpcFault(
      JsonRpcErrorCode.InvalidParams,
      "room.action params must contain a JSON-compatible action",
      { code: "INVALID_ACTION_PARAMS", retryable: false },
    );
  }
  return params.action;
}

function roomPlayerProfileRequestFromRpcParams(
  params: JsonValue | undefined,
): { playerId: string; fields: UserProfileField[] } | undefined {
  if (
    params === null ||
    typeof params !== "object" ||
    Array.isArray(params) ||
    Object.keys(params).length !== 2 ||
    typeof params.playerId !== "string" ||
    params.playerId.length === 0 ||
    params.playerId.length > 64 ||
    !Array.isArray(params.fields) ||
    params.fields.length === 0 ||
    params.fields.length > 2 ||
    params.fields.some((field) => field !== "name" && field !== "avatar") ||
    new Set(params.fields).size !== params.fields.length
  ) {
    return undefined;
  }
  return {
    playerId: params.playerId,
    fields: params.fields as UserProfileField[],
  };
}

function actionResultForRpc(result: RoomActionResult): JsonValue {
  return result.accepted
    ? {
        accepted: true,
        matchId: result.matchId,
        version: result.version,
      }
    : {
        accepted: false,
        matchId: result.matchId,
        version: result.version,
        error: {
          code: result.error.code,
          message: result.error.message,
        },
      };
}
