import { useCallback, useEffect, useRef, useState } from "react";
import {
  JsonRpcErrorCode,
  type JsonValue,
  type UserProfileField,
} from "@playweft/game-protocol";
import { RpcFault } from "./json-rpc";
import {
  getPlatformSession,
  issueProfileAvatar,
  resolveProfileAvatarUrl,
} from "./platform-api";
import { useI18n } from "./i18n";
import {
  hasPermissionGrant,
  rememberPermissionGrant,
} from "./permission-grants";
import GamePermissionPrompt, {
  type GamePermissionPromptState,
} from "./GamePermissionPrompt";

const PROMPT_TIMEOUT_MS = 30_000;

export type UserProfileResult = Record<string, JsonValue>;

type PromptState = GamePermissionPromptState;

interface PendingRequest {
  baseResult: UserProfileResult;
  manifestId: string;
  resolve(value: UserProfileResult): void;
  reject(reason: RpcFault): void;
  timeout: number;
}

interface ProfileIdentity {
  gameName: string;
  gameOrigin: string | undefined;
  manifestId: string | undefined;
  name: string;
}

export function useUserProfileAccess(
  gameName: string,
  gameOrigin: string | undefined,
  manifestId: string | undefined,
  name: string,
) {
  const identityRef = useRef<ProfileIdentity>({
    gameName,
    gameOrigin,
    manifestId,
    name,
  });
  identityRef.current = { gameName, gameOrigin, manifestId, name };
  const pendingRef = useRef<PendingRequest | undefined>(undefined);
  const generationRef = useRef(0);
  const busyRef = useRef(false);
  const [prompt, setPrompt] = useState<PromptState>();

  const finish = useCallback(
    (outcome: { value: UserProfileResult } | { error: RpcFault }) => {
      const pending = pendingRef.current;
      busyRef.current = false;
      if (!pending) return;
      pendingRef.current = undefined;
      window.clearTimeout(pending.timeout);
      setPrompt(undefined);
      if ("value" in outcome) pending.resolve(outcome.value);
      else pending.reject(outcome.error);
    },
    [],
  );

  const resolveAvatar = useCallback(async () => {
    const pending = pendingRef.current;
    if (!pending) return;
    try {
      const issued = await issueProfileAvatar(pending.manifestId);
      if (!issued.src) {
        finish({ value: pending.baseResult });
        return;
      }
      const src = resolveProfileAvatarUrl(issued.src);
      if (!src) {
        throw profileFault(
          "AVATAR_UNAVAILABLE",
          "The profile avatar URL is invalid",
        );
      }
      finish({
        value: { ...pending.baseResult, avatar: { src } },
      });
    } catch (reason) {
      finish({
        error:
          reason instanceof RpcFault
            ? reason
            : profileFault(
                "PROFILE_UNAVAILABLE",
                reason instanceof Error
                  ? reason.message
                  : "The user profile is unavailable",
                true,
              ),
      });
    }
  }, [finish]);

  const requestProfile = useCallback(
    async (fields: UserProfileField[]): Promise<UserProfileResult> => {
      const identity = identityRef.current;
      if (!identity.manifestId || !identity.gameOrigin) {
        throw profileFault("NOT_ALLOWED", "The game identity is unavailable");
      }
      const baseResult: UserProfileResult = {};
      const resolvedName = identity.name.trim();
      if (fields.includes("name") && resolvedName) {
        baseResult.name = resolvedName;
      }
      if (!fields.includes("avatar")) return baseResult;
      if (busyRef.current) {
        throw profileFault("BUSY", "Another profile request is pending", true);
      }
      busyRef.current = true;
      const generation = ++generationRef.current;
      try {
        const session = await getPlatformSession();
        if (generation !== generationRef.current) {
          throw profileFault(
            "REQUEST_CANCELLED",
            "User profile request was cancelled",
            true,
          );
        }
        if (session.provider !== "x" || !session.avatarUrl) {
          busyRef.current = false;
          return baseResult;
        }

        return new Promise<UserProfileResult>((resolve, reject) => {
          const timeout = window.setTimeout(() => {
            finish({
              error: profileFault(
                "REQUEST_EXPIRED",
                "User profile request expired",
                true,
              ),
            });
          }, PROMPT_TIMEOUT_MS);
          pendingRef.current = {
            baseResult,
            manifestId: identity.manifestId!,
            resolve,
            reject,
            timeout,
          };
          if (hasPermissionGrant(identity.manifestId!, "profileAvatar")) {
            void resolveAvatar();
            return;
          }
          setPrompt({
            gameName: identity.gameName,
            origin: identity.gameOrigin!,
          });
        });
      } catch (reason) {
        if (generation === generationRef.current) busyRef.current = false;
        throw reason instanceof RpcFault
          ? reason
          : profileFault(
              "PROFILE_UNAVAILABLE",
              "The platform account profile could not be checked",
              true,
            );
      }
    },
    [finish, resolveAvatar],
  );

  const allow = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    rememberPermissionGrant(pending.manifestId, "profileAvatar");
    void resolveAvatar();
  }, [resolveAvatar]);

  const deny = useCallback(() => {
    finish({
      error: profileFault("USER_DENIED", "User profile access was denied"),
    });
  }, [finish]);

  const cancelPending = useCallback(() => {
    generationRef.current += 1;
    busyRef.current = false;
    finish({
      error: profileFault(
        "REQUEST_CANCELLED",
        "User profile request was cancelled",
        true,
      ),
    });
  }, [finish]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      busyRef.current = false;
      const pending = pendingRef.current;
      if (!pending) return;
      window.clearTimeout(pending.timeout);
      pending.reject(
        profileFault(
          "REQUEST_CANCELLED",
          "User profile request was cancelled",
          true,
        ),
      );
      pendingRef.current = undefined;
    },
    [],
  );

  return { requestProfile, cancelPending, prompt, allow, deny };
}

export function UserProfilePrompt({
  prompt,
  onAllow,
  onDeny,
}: {
  prompt?: PromptState;
  onAllow(): void;
  onDeny(): void;
}) {
  const { t } = useI18n();
  return (
    <GamePermissionPrompt
      prompt={prompt}
      title={
        prompt ? t("userProfileAvatarRequest", { name: prompt.gameName }) : ""
      }
      remembered={t("userProfileGrantRemembered")}
      onAllow={onAllow}
      onDeny={onDeny}
    />
  );
}

export function userProfileFieldsFromRpcParams(
  params: unknown,
): UserProfileField[] | undefined {
  if (
    !isRecord(params) ||
    Object.keys(params).some((key) => key !== "fields")
  ) {
    return undefined;
  }
  if (
    !Array.isArray(params.fields) ||
    params.fields.length === 0 ||
    params.fields.length > 2 ||
    params.fields.some((field) => field !== "name" && field !== "avatar") ||
    new Set(params.fields).size !== params.fields.length
  ) {
    return undefined;
  }
  return params.fields as UserProfileField[];
}

function profileFault(
  code: string,
  message: string,
  retryable = false,
): RpcFault {
  return new RpcFault(JsonRpcErrorCode.PlatformError, message, {
    code,
    retryable,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
