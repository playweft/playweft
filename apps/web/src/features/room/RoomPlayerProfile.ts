import { useCallback, useRef } from "react";
import {
  JsonRpcErrorCode,
  type JsonValue,
  type RoomPresence,
  type UserProfileField,
} from "@playweft/game-protocol";
import { RpcFault } from "@/platform/json-rpc";
import { resolveRoomAvatarUrl } from "@/platform/platform-api";

export function useRoomPlayerProfileAccess(room: RoomPresence | undefined) {
  const roomRef = useRef(room);
  roomRef.current = room;

  const requestProfile = useCallback(
    (
      playerId: string,
      fields: UserProfileField[],
      roomOverride?: RoomPresence,
    ): Promise<Record<string, JsonValue>> => {
      const presence = roomOverride ?? roomRef.current;
      const member = presence
        ? [...presence.players, ...presence.spectators].find(
            (candidate) => candidate.id === playerId,
          )
        : undefined;
      if (!member) {
        return Promise.reject(
          profileFault("PLAYER_NOT_FOUND", "The room player was not found"),
        );
      }
      const profile: Record<string, JsonValue> = {};
      if (fields.includes("name") && member.name) profile.name = member.name;
      if (fields.includes("avatar") && member.avatarUrl) {
        const src = resolveRoomAvatarUrl(member.avatarUrl);
        if (!src) {
          return Promise.reject(
            profileFault(
              "AVATAR_UNAVAILABLE",
              "The room avatar URL is invalid",
            ),
          );
        }
        profile.avatar = { src };
      }
      return Promise.resolve(profile);
    },
    [],
  );

  return { requestProfile };
}

function profileFault(code: string, message: string): RpcFault {
  return new RpcFault(JsonRpcErrorCode.PlatformError, message, {
    code,
    retryable: false,
  });
}
