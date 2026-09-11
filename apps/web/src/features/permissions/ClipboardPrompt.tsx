import { useCallback, useEffect, useRef, useState } from "react";
import { JsonRpcErrorCode } from "@playweft/game-protocol";
import { RpcFault } from "@/platform/json-rpc";
import { useI18n } from "@/app/i18n";
import {
  hasPermissionGrant,
  rememberPermissionGrant,
} from "@/features/permissions/permission-grants";

const MAX_CLIPBOARD_BYTES = 64 * 1024;
const PROMPT_TIMEOUT_MS = 30_000;
const NOTICE_DURATION_MS = 1_800;
const MIN_READ_INTERVAL_MS = 1_000;

interface PromptState {
  gameName: string;
  origin: string;
  reading: boolean;
}

interface PendingRead {
  identity: ResolvedGameIdentity;
  resolve(value: string): void;
  reject(reason: RpcFault): void;
  timeout: number;
}

interface GameIdentity {
  gameName: string;
  manifestId: string | undefined;
  gameOrigin: string | undefined;
}

interface ResolvedGameIdentity extends GameIdentity {
  manifestId: string;
  gameOrigin: string;
}

export function useClipboardRead(
  gameName: string,
  manifestId: string | undefined,
  gameOrigin: string | undefined,
) {
  const { t } = useI18n();
  const identityRef = useRef<GameIdentity>({
    gameName,
    manifestId,
    gameOrigin,
  });
  identityRef.current = { gameName, manifestId, gameOrigin };
  const translatorRef = useRef(t);
  translatorRef.current = t;
  const pendingRef = useRef<PendingRead | undefined>(undefined);
  const noticeTimerRef = useRef<number | undefined>(undefined);
  const lastReadAtRef = useRef(0);
  const [prompt, setPrompt] = useState<PromptState>();
  const [notice, setNotice] = useState<string>();

  const clearNotice = useCallback(() => {
    window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = undefined;
    setNotice(undefined);
  }, []);

  const showNotice = useCallback((message: string) => {
    window.clearTimeout(noticeTimerRef.current);
    setNotice(message);
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = undefined;
      setNotice(undefined);
    }, NOTICE_DURATION_MS);
  }, []);

  const finish = useCallback(
    (outcome: { text: string } | { error: RpcFault }) => {
      const pending = pendingRef.current;
      if (!pending) return;
      pendingRef.current = undefined;
      window.clearTimeout(pending.timeout);
      setPrompt(undefined);
      if ("text" in outcome) pending.resolve(outcome.text);
      else pending.reject(outcome.error);
    },
    [],
  );

  const readClipboard = useCallback(async () => {
    const identity = pendingRef.current?.identity;
    if (!identity) return;
    showNotice(
      translatorRef.current("clipboardReadNotice", {
        name: identity.gameName,
      }),
    );
    setPrompt((current) => (current ? { ...current, reading: true } : current));
    try {
      if (!navigator.clipboard?.readText) {
        throw clipboardFault(
          "NOT_SUPPORTED",
          "Clipboard reading is not supported by this browser",
        );
      }
      const text = await navigator.clipboard.readText();
      if (new TextEncoder().encode(text).byteLength > MAX_CLIPBOARD_BYTES) {
        throw clipboardFault(
          "TOO_LARGE",
          `Clipboard text exceeds the ${MAX_CLIPBOARD_BYTES}-byte limit`,
        );
      }
      rememberPermissionGrant(identity.manifestId, "clipboardRead");
      finish({ text });
    } catch (reason) {
      clearNotice();
      finish({
        error:
          reason instanceof RpcFault
            ? reason
            : clipboardFault(
                reason instanceof DOMException &&
                  reason.name === "NotAllowedError"
                  ? "NOT_ALLOWED"
                  : "READ_FAILED",
                reason instanceof Error
                  ? reason.message
                  : "Could not read the clipboard",
                true,
              ),
      });
    }
  }, [clearNotice, finish, showNotice]);

  const requestReadText = useCallback(
    (): Promise<string> => {
      if (pendingRef.current) {
        return Promise.reject(
          clipboardFault("BUSY", "Another clipboard request is pending", true),
        );
      }
      const retryAfterMs =
        MIN_READ_INTERVAL_MS - (Date.now() - lastReadAtRef.current);
      if (retryAfterMs > 0) {
        return Promise.reject(
          new RpcFault(
            JsonRpcErrorCode.PlatformError,
            "Clipboard reads are rate limited",
            {
              code: "RATE_LIMITED",
              retryable: true,
              retryAfterMs,
            },
          ),
        );
      }
      lastReadAtRef.current = Date.now();
      const identity = identityRef.current;
      if (!identity.manifestId || !identity.gameOrigin) {
        return Promise.reject(
          clipboardFault("NOT_ALLOWED", "The game identity is unavailable"),
        );
      }
      const requestIdentity: ResolvedGameIdentity = {
        gameName: identity.gameName,
        manifestId: identity.manifestId,
        gameOrigin: identity.gameOrigin,
      };

      return new Promise<string>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          finish({
            error: clipboardFault(
              "REQUEST_EXPIRED",
              "Clipboard request expired",
              true,
            ),
          });
        }, PROMPT_TIMEOUT_MS);
        pendingRef.current = {
          identity: requestIdentity,
          resolve,
          reject,
          timeout,
        };
        if (
          hasPermissionGrant(requestIdentity.manifestId, "clipboardRead")
        ) {
          void readClipboard();
          return;
        }
        setPrompt({
          gameName: requestIdentity.gameName,
          origin: requestIdentity.gameOrigin,
          reading: false,
        });
      });
    },
    [finish, readClipboard],
  );

  const deny = useCallback(() => {
    finish({
      error: clipboardFault("USER_DENIED", "Clipboard access was denied"),
    });
  }, [finish]);

  const cancelPending = useCallback(() => {
    finish({
      error: clipboardFault(
        "REQUEST_CANCELLED",
        "Clipboard request was cancelled",
        true,
      ),
    });
  }, [finish]);

  useEffect(
    () => () => {
      window.clearTimeout(noticeTimerRef.current);
      const pending = pendingRef.current;
      if (!pending) return;
      window.clearTimeout(pending.timeout);
      pending.reject(
        clipboardFault(
          "REQUEST_CANCELLED",
          "Clipboard request was cancelled",
          true,
        ),
      );
      pendingRef.current = undefined;
    },
    [],
  );

  return {
    requestReadText,
    cancelPending,
    prompt,
    notice,
    allow: readClipboard,
    deny,
    clearNotice,
  };
}

export function ClipboardPrompt({
  prompt,
  notice,
  onAllow,
  onDeny,
  onDismissNotice,
}: {
  prompt?: PromptState;
  notice?: string;
  onAllow(): void;
  onDeny(): void;
  onDismissNotice(): void;
}) {
  const { t } = useI18n();
  if (!prompt && !notice) return null;

  if (!prompt) {
    return (
      <div className="clipboard-notice" role="status" aria-live="polite">
        <span>{notice}</span>
        <button
          type="button"
          onClick={onDismissNotice}
          aria-label={t("dismissClipboardNotice")}
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <section
      className="permission-prompt"
      role="alertdialog"
      aria-labelledby="clipboard-prompt-title"
    >
      <div>
        <strong id="clipboard-prompt-title">
          {t("clipboardReadRequest", { name: prompt.gameName })}
        </strong>
        <span>{prompt.origin}</span>
        <small>{t("clipboardGrantRemembered")}</small>
      </div>
      <div className="permission-prompt-actions">
        <button
          type="button"
          autoFocus
          disabled={prompt.reading}
          onClick={onDeny}
        >
          {t("deny")}
        </button>
        <button
          className="primary"
          type="button"
          disabled={prompt.reading}
          onClick={onAllow}
        >
          {prompt.reading ? t("readingClipboard") : t("allowOnce")}
        </button>
      </div>
    </section>
  );
}

function clipboardFault(
  code: string,
  message: string,
  retryable = false,
): RpcFault {
  return new RpcFault(JsonRpcErrorCode.PlatformError, message, {
    code,
    retryable,
  });
}
