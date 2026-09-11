import { useCallback, useEffect, useRef, useState } from "react";
import { JsonRpcErrorCode } from "@playweft/game-protocol";
import GamePermissionPrompt, {
  type GamePermissionPromptState,
} from "@/features/permissions/GamePermissionPrompt";
import { useI18n } from "@/app/i18n";
import { RpcFault } from "@/platform/json-rpc";
import {
  hasPermissionGrant,
  rememberPermissionGrant,
} from "@/features/permissions/permission-grants";

const PROMPT_TIMEOUT_MS = 30_000;

interface GameIdentity {
  gameName: string;
  gameOrigin: string | undefined;
  manifestId: string | undefined;
}

interface PendingRequest {
  manifestId: string;
  resolve(value: void): void;
  reject(reason: RpcFault): void;
  timeout: number;
}

/**
 * The user-consent half of Workers AI access. Invocation deliberately lives
 * elsewhere: this hook must not be used to imply that an arbitrary model or
 * Cloudflare account is available.
 */
export function useLanguageModelPermission(
  gameName: string,
  gameOrigin: string | undefined,
  manifestId: string | undefined,
) {
  const identityRef = useRef<GameIdentity>({
    gameName,
    gameOrigin,
    manifestId,
  });
  identityRef.current = { gameName, gameOrigin, manifestId };
  const pendingRef = useRef<PendingRequest | undefined>(undefined);
  const [prompt, setPrompt] = useState<GamePermissionPromptState>();

  const finish = useCallback(
    (outcome: "allowed" | RpcFault) => {
      const pending = pendingRef.current;
      if (!pending) return;
      pendingRef.current = undefined;
      window.clearTimeout(pending.timeout);
      setPrompt(undefined);
      if (outcome === "allowed") pending.resolve(undefined);
      else pending.reject(outcome);
    },
    [],
  );

  const requestPermission = useCallback((): Promise<void> => {
    if (pendingRef.current) {
      return Promise.reject(
        languageModelFault(
          "BUSY",
          "Another language-model permission request is pending",
          true,
        ),
      );
    }
    const identity = identityRef.current;
    if (!identity.manifestId || !identity.gameOrigin) {
      return Promise.reject(
        languageModelFault("NOT_ALLOWED", "The game identity is unavailable"),
      );
    }
    if (hasPermissionGrant(identity.manifestId, "languageModelV1")) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        finish(
          languageModelFault(
            "REQUEST_EXPIRED",
            "Language-model permission request expired",
            true,
          ),
        );
      }, PROMPT_TIMEOUT_MS);
      pendingRef.current = {
        manifestId: identity.manifestId!,
        resolve,
        reject,
        timeout,
      };
      setPrompt({
        gameName: identity.gameName,
        origin: identity.gameOrigin!,
      });
    });
  }, [finish]);

  const allow = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    rememberPermissionGrant(pending.manifestId, "languageModelV1");
    finish("allowed");
  }, [finish]);

  const deny = useCallback(() => {
    finish(languageModelFault("USER_DENIED", "Language-model access was denied"));
  }, [finish]);

  const cancelPending = useCallback(() => {
    finish(
      languageModelFault(
        "REQUEST_CANCELLED",
        "Language-model permission request was cancelled",
        true,
      ),
    );
  }, [finish]);

  useEffect(
    () => () => {
      const pending = pendingRef.current;
      if (!pending) return;
      window.clearTimeout(pending.timeout);
      pendingRef.current = undefined;
      pending.reject(
        languageModelFault(
          "REQUEST_CANCELLED",
          "Language-model permission request was cancelled",
          true,
        ),
      );
    },
    [],
  );

  return { requestPermission, cancelPending, prompt, allow, deny };
}

export function LanguageModelPermissionPrompt({
  prompt,
  onAllow,
  onDeny,
}: {
  prompt?: GamePermissionPromptState;
  onAllow(): void;
  onDeny(): void;
}) {
  const { t } = useI18n();
  return (
    <GamePermissionPrompt
      prompt={prompt}
      title={
        prompt ? t("languageModelRequest", { name: prompt.gameName }) : ""
      }
      remembered={t("languageModelGrantRemembered")}
      onAllow={onAllow}
      onDeny={onDeny}
    />
  );
}

function languageModelFault(
  code: string,
  message: string,
  retryable = false,
): RpcFault {
  return new RpcFault(JsonRpcErrorCode.PlatformError, message, {
    code,
    retryable,
  });
}
