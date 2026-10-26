import type { GameRoomManager } from "@/features/game/GameRoomManager";
import type { LoadedGame } from "@/features/game/game-manifest";
import { createRoomLobbyHandlers, roomCreateOptionsFromRpcParams, gameRoomState, ROOM_LOBBY_CAPABILITIES } from "./room-lobby-bridge";
import { gameLatency } from "./game-latency";
import { useEffect, useRef, type RefObject } from "react";
import {
  JsonRpcErrorCode,
  isJson,
  type JsonValue,
  type RoomPresence,
  type RoomSnapshot,
  type UserProfileField,
} from "@playweft/game-protocol";
import { useI18n } from "@/app/i18n";
import { attachGameBridge } from "@/features/game/GameFrame";
import {
  PLATFORM_WINDOW_CAPABILITIES,
  useGameWindowDialogs,
} from "@/features/game/GameWindowDialog";
import { useClipboardRead } from "@/features/permissions/ClipboardPrompt";
import { useLanguageModelPermission } from "@/features/permissions/LanguageModelPermission";
import {
  languageModelPromptFromRpcParams,
  requestLanguageModel,
} from "@/features/permissions/language-model";
import {
  userProfileFieldsFromRpcParams,
  useUserProfileAccess,
} from "@/features/permissions/UserProfilePrompt";
import {
  PLAYWEFT_BRIDGE_VERSION,
  RpcFault,
  postRpcNotification,
  rpcPlatformFault,
} from "@/platform/json-rpc";
import { useRoomPlayerProfileAccess } from "./RoomPlayerProfile";
import { RoomSession, type RoomSessionState } from "./RoomSession";
import { errorMessage } from "./room-errors";
import { createLocalStorageHandlers, LOCAL_STORAGE_CAPABILITIES } from "@/features/game/local-storage";

const capabilities = [
  ...new Set([
    ...PLATFORM_WINDOW_CAPABILITIES,
    ...LOCAL_STORAGE_CAPABILITIES,
    "user.getProfile",
    "navigator.clipboard.readText",
    "languageModel.prompt",
    "languageModel.cancel",
    "room.players.getProfile",
  ]),
];

export function useRoomGameBridge({
  session,
  state,
  frame,
  gameName,
  nickname,
  deferred,
  enabled = true,
  manager,
  loadedGame,
}: {
  session?: RoomSession;
  state: RoomSessionState;
  frame: RefObject<HTMLIFrameElement | null>;
  gameName: string;
  nickname: string;
  deferred: boolean;
  enabled?: boolean;
  manager?: GameRoomManager;
  loadedGame?: LoadedGame;
}) {
  const { t } = useI18n();
  const game = (loadedGame ?? state.loadedGame)?.game;
  const gameUrl = game?.url;
  const origin = gameUrl ? new URL(gameUrl).origin : undefined;
  const phase = state.presence?.phase;
  const customLobby = !!manager || !!state.loadedGame?.game.embeddedLobby || !!state.loadedGame?.manifest?.room || state.loadedGame?.manifest?.modes.room?.lobby === "game";
  const active = enabled && (customLobby || phase === "playing");
  const clipboard = useClipboardRead(gameName, game?.manifestId, origin);
  const roomPlayerProfiles = useRoomPlayerProfileAccess(state.presence);
  const userProfile = useUserProfileAccess(
    gameName,
    origin,
    game?.manifestId,
    nickname,
  );
  const languageModel = useLanguageModelPermission(
    gameName,
    origin,
    game?.manifestId,
  );
  const windowDialogs = useGameWindowDialogs(gameName, origin);
  const latest = useRef({
    clipboard,
    roomPlayerProfiles,
    userProfile,
    languageModel,
    windowDialogs,
    nickname,
    t,
  });
  latest.current = {
    clipboard,
    roomPlayerProfiles,
    userProfile,
    languageModel,
    windowDialogs,
    nickname,
    t,
  };

  useEffect(() => {
    if ((!session && !manager) || !origin || !active || deferred) return;
    const currentSession = () => {
      const current = manager ? manager.session : session;
      if (!current) throw rpcPlatformFault("ROOM_CLOSED", "The game is not in a room");
      return current;
    };
    const currentState = () => manager ? manager.getState() : session!.getState();
    let closed = false;
    let port: MessagePort | undefined;
    let initialSnapshotTimer: number | undefined;
    let previous = currentState();
    const assertBridgeOpen = () => {
      if (closed || (!manager && currentState().lifecycle === "ended"))
        throw rpcPlatformFault(
          "BRIDGE_CLOSED",
          "The game bridge was closed",
          true,
        );
    };
    const cancelPermissions = () => {
      latest.current.clipboard.cancelPending();
      latest.current.userProfile.cancelPending();
      latest.current.languageModel.cancelPending();
      latest.current.windowDialogs.cancelPending();
    };
    const sendSnapshot = (snapshot: RoomSnapshot) => {
      postRpcNotification(port, "game.state", {
        phase: "playing",
        state: snapshot.state,
        events: snapshot.events ?? [],
        matchId: snapshot.matchId,
        version: snapshot.version,
        serverTime: snapshot.serverTime,
      });
    };
    const detachBridge = attachGameBridge({
      frame,
      origin,
      canConnect: () =>
        !closed && (!!manager || (currentState().lifecycle === "joined" &&
        (customLobby || currentState().presence?.phase === "playing"))),
      onBeforeConnect() {
        cancelPermissions();
        (manager?.session ?? session)?.cancelActions(
          "BRIDGE_REPLACED",
          "The game bridge was replaced",
        );
      },
      onPortChange(next) {
        port = next;
        if (port)
          postRpcNotification(port, "platform.latency", {
            ...gameLatency(currentState()),
          });
      },
      handlers: {
        ...createLocalStorageHandlers(origin),
        ...(customLobby ? Object.fromEntries(ROOM_LOBBY_CAPABILITIES.map(method => [method, {
          handle(params: JsonValue | undefined) {
            return createRoomLobbyHandlers(currentSession(), assertBridgeOpen)[method]!.handle(params);
          },
        }])) : {}),
        ...(customLobby ? {
          "rooms.create": { handle(params: JsonValue | undefined) {
            assertBridgeOpen();
            const configuration = roomCreateOptionsFromRpcParams(params);
            return manager ? manager.create(configuration) : gameRoomState(currentSession());
          } },
          "rooms.join": { handle(params: JsonValue | undefined) {
            assertBridgeOpen();
            if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).length !== 1 || typeof params.roomId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(params.roomId))
              throw new RpcFault(JsonRpcErrorCode.InvalidParams, "Expected { roomId }");
            if (manager) return manager.join(params.roomId);
            if (params.roomId !== currentSession().roomId) throw rpcPlatformFault("ROOM_ALREADY_JOINED", "Leave the current room first");
            return gameRoomState(currentSession());
          } },
        } : {}),
        "game.initialize": {
          async handle() {
            assertBridgeOpen();
            const state = currentState();
            if (!manager && (state.lifecycle !== "joined" || !state.selfId)) {
              throw rpcPlatformFault(
                "INITIALIZATION_REJECTED",
                "The room is not ready",
              );
            }
            const snapshot = state.snapshot;
            if (snapshot) {
              window.clearTimeout(initialSnapshotTimer);
              initialSnapshotTimer = window.setTimeout(() => {
                if (!closed && currentState().snapshot === snapshot)
                  sendSnapshot(snapshot);
              }, 0);
            }
            const name = latest.current.nickname;
            return {
              mode: state.lifecycle === "joined" ? "room" : "solo",
              protocolVersion: PLAYWEFT_BRIDGE_VERSION,
              capabilities: customLobby ? [...capabilities, ...ROOM_LOBBY_CAPABILITIES, ...((manager || (loadedGame ?? state.loadedGame)?.room) ? ["rooms.create", "rooms.join"] : [])] : capabilities,
              ...(customLobby ? { phase: state.presence?.phase ?? "solo", room: state.lifecycle === "joined" ? gameRoomState(currentSession()) : null } : {}),
              ...(state.selfId ? { playerId: state.selfId } : {}),
              player: { ...(state.selfId ? { id: state.selfId } : {}), ...(name ? { name } : {}) },
            };
          },
        },
        "room.action": {
          async handle(params, requestId) {
            assertBridgeOpen();
            if (!requestId)
              throw new RpcFault(
                JsonRpcErrorCode.InvalidRequest,
                "room.action requires a JSON-RPC id",
              );
            return currentSession().action(requestId, actionFromRpcParams(params));
          },
        },
        "navigator.clipboard.readText": {
          async handle() {
            assertBridgeOpen();
            return latest.current.clipboard.requestReadText();
          },
        },
        "room.players.getProfile": {
          async handle(params) {
            assertBridgeOpen();
            const request = roomPlayerProfileRequestFromRpcParams(params);
            if (!request) {
              throw new RpcFault(
                JsonRpcErrorCode.InvalidParams,
                "room.players.getProfile expects { playerId, fields: ['name' | 'avatar', ...] }",
              );
            }
            if (
              request.fields.includes("avatar") &&
              request.playerId === currentState().selfId
            ) {
              const ownProfile =
                await latest.current.userProfile.requestProfile(request.fields);
              assertBridgeOpen();
              let nextPresence: RoomPresence;
              try {
                nextPresence = await currentSession().shareAvatar(
                  ownProfile.avatar !== undefined,
                );
              } catch (reason) {
                throw rpcPlatformFault(
                  "PROFILE_SHARE_FAILED",
                  errorMessage(reason, latest.current.t("unexpectedError")),
                );
              }
              return latest.current.roomPlayerProfiles.requestProfile(
                request.playerId,
                request.fields,
                nextPresence,
              );
            }
            return latest.current.roomPlayerProfiles.requestProfile(
              request.playerId,
              request.fields,
            );
          },
        },
        "user.getProfile": {
          async handle(params) {
            assertBridgeOpen();
            const fields = userProfileFieldsFromRpcParams(params);
            if (!fields) {
              throw new RpcFault(
                JsonRpcErrorCode.InvalidParams,
                "user.getProfile expects { fields: ['name' | 'avatar', ...] }",
              );
            }
            const profile =
              await latest.current.userProfile.requestProfile(fields);
            assertBridgeOpen();
            if (fields.includes("avatar")) {
              try {
                await currentSession().shareAvatar(profile.avatar !== undefined);
              } catch (reason) {
                throw rpcPlatformFault(
                  "PROFILE_SHARE_FAILED",
                  errorMessage(reason, latest.current.t("unexpectedError")),
                );
              }
            }
            return profile;
          },
        },
        "languageModel.prompt": {
          async handle(params, _requestId, signal) {
            assertBridgeOpen();
            const prompt = languageModelPromptFromRpcParams(params);
            if (!prompt) {
              throw new RpcFault(
                JsonRpcErrorCode.InvalidParams,
                "languageModel.prompt expects { input, options?: { maxOutputTokens? } }",
              );
            }
            await latest.current.languageModel.requestPermission(signal);
            signal?.throwIfAborted();
            assertBridgeOpen();
            return requestLanguageModel(prompt, signal);
          },
        },
        "window.alert": {
          handle: (params) => latest.current.windowDialogs.requestAlert(params),
        },
        "window.confirm": {
          handle: (params) =>
            latest.current.windowDialogs.requestConfirm(params),
        },
      },
    });
    const closeBridge = () => {
      if (closed) return;
      closed = true;
      window.clearTimeout(initialSnapshotTimer);
      cancelPermissions();
      (manager?.session ?? session)?.cancelActions();
      manager?.cancelPending();
      detachBridge();
    };
    const unsubscribe = (manager ?? session!).subscribe(() => {
      if (closed) return;
      const next = currentState();
      if (next.lifecycle === "ended" && customLobby) postRpcNotification(port, "room.closed", { reason: "room-ended" });
      if (
        (!manager && next.lifecycle === "ended") ||
        (!customLobby && next.presence?.phase !== "playing") ||
        (!manager && next.loadedGame !== previous.loadedGame) ||
        (!manager && next.gameRevision !== previous.gameRevision)
      ) {
        closeBridge();
        return;
      }
      if (customLobby && next.lifecycle === "joined" && next.presence && (next.presence !== previous.presence || next.selfId !== previous.selfId))
        postRpcNotification(port, "room.stateChanged", gameRoomState(currentSession()));
      if (customLobby && next.presence?.phase !== previous.presence?.phase) cancelPermissions();
      if (next.snapshot && next.snapshot !== previous.snapshot)
        sendSnapshot(next.snapshot);
      const latency = gameLatency(next);
      if (JSON.stringify(latency) !== JSON.stringify(gameLatency(previous)))
        postRpcNotification(port, "platform.latency", { ...latency });
      publishProfileChanges(port, previous.presence, next.presence);
      previous = next;
    });
    const unsubscribeErrors = (manager ?? session!).subscribeErrors((error) => {
      if (!closed)
        postRpcNotification(port, "platform.error", {
          error: { ...error, retryable: false },
        });
    });
    return () => {
      unsubscribe();
      unsubscribeErrors?.();
      closeBridge();
    };
  }, [session, frame, origin, active, customLobby, state.gameRevision, deferred, manager, loadedGame]);

  return { clipboard, userProfile, languageModel, windowDialogs };
}

function publishProfileChanges(
  port: MessagePort | undefined,
  previous: RoomPresence | undefined,
  next: RoomPresence | undefined,
): void {
  if (!port || !previous || !next || previous === next) return;
  const before = new Map(
    [...previous.players, ...previous.spectators].map((p) => [p.id, p]),
  );
  const after = new Map(
    [...next.players, ...next.spectators].map((p) => [p.id, p]),
  );
  for (const playerId of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(playerId),
      b = after.get(playerId);
    const fields: UserProfileField[] = [];
    if (!a || !b || a.name !== b.name) fields.push("name");
    if (!a || !b || a.avatarUrl !== b.avatarUrl) fields.push("avatar");
    if (fields.length)
      postRpcNotification(port, "room.players.profileChanged", {
        playerId,
        fields,
      });
  }
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
