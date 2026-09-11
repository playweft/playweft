import { useCallback, useEffect, useRef, useState } from "react";
import { JsonRpcErrorCode, type JsonValue } from "@playweft/game-protocol";
import Dialog from "@/components/Dialog";
import { useI18n } from "@/app/i18n";
import { RpcFault, rpcPlatformFault } from "@/platform/json-rpc";

const MAX_DIALOG_MESSAGE_LENGTH = 2_000;

export const PLATFORM_WINDOW_CAPABILITIES = [
  "window.alert",
  "window.confirm",
] as const;

interface GameWindowDialogState {
  kind: "alert" | "confirm";
  gameName: string;
  message: string;
  origin: string;
}

interface PendingDialog {
  kind: GameWindowDialogState["kind"];
  resolve(value: boolean | null): void;
  reject(reason: RpcFault): void;
}

export function useGameWindowDialogs(
  gameName: string,
  gameOrigin: string | undefined,
) {
  const identityRef = useRef({ gameName, gameOrigin });
  identityRef.current = { gameName, gameOrigin };
  const pendingRef = useRef<PendingDialog | undefined>(undefined);
  const [dialog, setDialog] = useState<GameWindowDialogState>();

  const finish = useCallback((value: boolean | null) => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = undefined;
    setDialog(undefined);
    pending.resolve(value);
  }, []);

  const request = useCallback(
    (kind: GameWindowDialogState["kind"], params: JsonValue | undefined) => {
      if (pendingRef.current) {
        return Promise.reject(
          rpcPlatformFault(
            "BUSY",
            "Another platform window dialog is already open",
            true,
          ),
        );
      }
      const message = dialogMessageFromParams(params, `window.${kind}`);
      const { gameName: currentName, gameOrigin: currentOrigin } =
        identityRef.current;
      if (!currentOrigin) {
        return Promise.reject(
          rpcPlatformFault("NOT_ALLOWED", "The game origin is unavailable"),
        );
      }
      return new Promise<boolean | null>((resolve, reject) => {
        pendingRef.current = { kind, resolve, reject };
        setDialog({
          kind,
          gameName: currentName,
          message,
          origin: new URL(currentOrigin).host,
        });
      });
    },
    [],
  );

  const requestAlert = useCallback(
    async (params: JsonValue | undefined): Promise<null> => {
      await request("alert", params);
      return null;
    },
    [request],
  );

  const requestConfirm = useCallback(
    async (params: JsonValue | undefined): Promise<boolean> =>
      (await request("confirm", params)) === true,
    [request],
  );

  const dismiss = useCallback(() => {
    finish(pendingRef.current?.kind === "confirm" ? false : null);
  }, [finish]);

  const confirm = useCallback(() => finish(true), [finish]);

  const cancelPending = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = undefined;
    setDialog(undefined);
    pending.reject(
      rpcPlatformFault(
        "REQUEST_CANCELLED",
        "The platform window dialog was cancelled",
        true,
      ),
    );
  }, []);

  useEffect(
    () => () => {
      const pending = pendingRef.current;
      if (!pending) return;
      pendingRef.current = undefined;
      pending.reject(
        rpcPlatformFault(
          "REQUEST_CANCELLED",
          "The platform window dialog was cancelled",
          true,
        ),
      );
    },
    [],
  );

  return {
    dialog,
    requestAlert,
    requestConfirm,
    dismiss,
    confirm,
    cancelPending,
  };
}

export default function GameWindowDialog({
  dialog,
  onConfirm,
  onDismiss,
}: {
  dialog: GameWindowDialogState;
  onConfirm(): void;
  onDismiss(): void;
}) {
  const { t } = useI18n();
  const dismissAfterClose = () => queueMicrotask(onDismiss);
  return (
    <Dialog
      title={dialog.gameName}
      onDismiss={dismissAfterClose}
      actions={[
        ...(dialog.kind === "confirm"
          ? [{ label: t("cancel") }]
          : []),
        {
          label: t("ok"),
          variant: "primary" as const,
          ...(dialog.kind === "confirm" ? { onSelect: onConfirm } : {}),
        },
      ]}
    >
      <div className="game-window-dialog-content">
        <p className="game-window-dialog-message">{dialog.message}</p>
        <small>{t("gameDialogSource", { origin: dialog.origin })}</small>
      </div>
    </Dialog>
  );
}

function dialogMessageFromParams(
  params: JsonValue | undefined,
  method: string,
): string {
  if (params === undefined) return "";
  if (
    params === null ||
    typeof params !== "object" ||
    Array.isArray(params) ||
    Object.keys(params).some((key) => key !== "message") ||
    (params.message !== undefined && typeof params.message !== "string")
  ) {
    throw new RpcFault(
      JsonRpcErrorCode.InvalidParams,
      `${method} params must be an object containing an optional string message`,
      { code: "INVALID_DIALOG_PARAMS", retryable: false },
    );
  }
  const message = params.message ?? "";
  if (message.length > MAX_DIALOG_MESSAGE_LENGTH) {
    throw new RpcFault(
      JsonRpcErrorCode.InvalidParams,
      `${method} message exceeds the ${MAX_DIALOG_MESSAGE_LENGTH}-character limit`,
      { code: "DIALOG_MESSAGE_TOO_LONG", retryable: false },
    );
  }
  return message;
}
