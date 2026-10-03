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

const capabilities = [
  ...new Set([
    ...PLATFORM_WINDOW_CAPABILITIES,
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
}: {
  session?: RoomSession;
  state: RoomSessionState;
  frame: RefObject<HTMLIFrameElement | null>;
  gameName: string;
  nickname: string;
  deferred: boolean;
}) {
  const { t } = useI18n();
  const game = state.loadedGame?.game;
  const gameUrl = game?.url;
  const origin = gameUrl ? new URL(gameUrl).origin : undefined;
  const phase = state.presence?.phase;
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
    if (!session || !origin || phase !== "playing" || deferred) return;
    let closed = false;
    let port: MessagePort | undefined;
    let initialSnapshotTimer: number | undefined;
    let previous = session.getState();
    const assertBridgeOpen = () => {
      if (closed || session.getState().lifecycle === "ended")
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
        !closed && session.getState().presence?.phase === "playing",
      onBeforeConnect() {
        cancelPermissions();
        session.cancelActions(
          "BRIDGE_REPLACED",
          "The game bridge was replaced",
        );
      },
      onPortChange(next) {
        port = next;
        const rttMs = session.getState().latency;
        if (port && rttMs !== undefined)
          postRpcNotification(port, "platform.latency", { rttMs });
      },
      handlers: {
        "game.initialize": {
          async handle() {
            assertBridgeOpen();
            const state = session.getState();
            if (state.lifecycle !== "joined" || !state.selfId) {
              throw rpcPlatformFault(
                "INITIALIZATION_REJECTED",
                "The room is not ready",
              );
            }
            const snapshot = state.snapshot;
            if (snapshot) {
              window.clearTimeout(initialSnapshotTimer);
              initialSnapshotTimer = window.setTimeout(() => {
                if (!closed && session.getState().snapshot === snapshot)
                  sendSnapshot(snapshot);
              }, 0);
            }
            const name = latest.current.nickname;
            return {
              mode: "room",
              protocolVersion: PLAYWEFT_BRIDGE_VERSION,
              capabilities,
              playerId: state.selfId,
              player: { id: state.selfId, ...(name ? { name } : {}) },
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
            return session.action(requestId, actionFromRpcParams(params));
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
              request.playerId === session.getState().selfId
            ) {
              const ownProfile =
                await latest.current.userProfile.requestProfile(request.fields);
              assertBridgeOpen();
              let nextPresence: RoomPresence;
              try {
                nextPresence = await session.shareAvatar(
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
                await session.shareAvatar(profile.avatar !== undefined);
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
      session.cancelActions();
      detachBridge();
    };
    const unsubscribe = session.subscribe(() => {
      if (closed) return;
      const next = session.getState();
      if (
        next.lifecycle === "ended" ||
        next.presence?.phase !== "playing" ||
        next.loadedGame !== previous.loadedGame ||
        next.gameRevision !== previous.gameRevision
      ) {
        closeBridge();
        return;
      }
      if (next.snapshot && next.snapshot !== previous.snapshot)
        sendSnapshot(next.snapshot);
      if (next.latency !== undefined && next.latency !== previous.latency)
        postRpcNotification(port, "platform.latency", { rttMs: next.latency });
      publishProfileChanges(port, previous.presence, next.presence);
      previous = next;
    });
    const unsubscribeErrors = session.subscribeErrors((error) => {
      if (!closed)
        postRpcNotification(port, "platform.error", {
          error: { ...error, retryable: false },
        });
    });
    return () => {
      unsubscribe();
      unsubscribeErrors();
      closeBridge();
    };
  }, [session, frame, origin, phase, state.gameRevision, deferred]);

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
