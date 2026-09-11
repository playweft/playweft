import {
  JSON_RPC_VERSION,
  PLAYWEFT_BRIDGE_VERSION,
  JsonRpcErrorCode,
  isJson,
  type JsonRpcErrorObject,
  type JsonRpcFailure,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcSuccess,
  type JsonValue,
} from "@playweft/game-protocol";

export { PLAYWEFT_BRIDGE_VERSION };

export interface RpcHandler {
  allowNotification?: boolean;
  handle(params: JsonValue | undefined, requestId?: string): JsonValue | Promise<JsonValue>;
}

export type RpcHandlers = Record<string, RpcHandler>;

export class RpcFault extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
    readonly data?: JsonValue,
  ) {
    super(message);
    this.name = "RpcFault";
  }
}

export async function dispatchRpcMessage(
  port: MessagePort,
  value: unknown,
  handlers: RpcHandlers,
): Promise<void> {
  if (!isRpcCall(value)) {
    postRpcError(port, null, {
      code: JsonRpcErrorCode.InvalidRequest,
      message: "Invalid JSON-RPC 2.0 request",
    });
    return;
  }

  const hasId = Object.prototype.hasOwnProperty.call(value, "id");
  const requestId = hasId
    ? (value as JsonRpcRequest | { id: unknown }).id
    : undefined;
  if (
    hasId &&
    (typeof requestId !== "string" ||
      requestId.length === 0 ||
      requestId.length > 128)
  ) {
    postRpcError(port, null, {
      code: JsonRpcErrorCode.InvalidRequest,
      message: "JSON-RPC id must be a 1-128 character string",
    });
    return;
  }
  const normalizedRequestId =
    typeof requestId === "string" ? requestId : undefined;

  const handler = handlers[value.method];
  if (!handler) {
    if (normalizedRequestId) {
      postRpcError(port, normalizedRequestId, {
        code: JsonRpcErrorCode.MethodNotFound,
        message: `Method not found: ${value.method}`,
      });
    }
    return;
  }
  if (normalizedRequestId === undefined && !handler.allowNotification) return;

  try {
    const result = await handler.handle(value.params, normalizedRequestId);
    if (!normalizedRequestId) return;
    if (!isJson(result)) {
      throw new RpcFault(
        JsonRpcErrorCode.InternalError,
        "RPC method returned a non-JSON result",
        { code: "INVALID_RPC_RESULT", retryable: false },
      );
    }
    postRpcResult(port, normalizedRequestId, result);
  } catch (reason) {
    if (!normalizedRequestId) return;
    const error =
      reason instanceof RpcFault
        ? {
            code: reason.rpcCode,
            message: reason.message,
            ...(reason.data === undefined ? {} : { data: reason.data }),
          }
        : {
            code: JsonRpcErrorCode.InternalError,
            message: reason instanceof Error ? reason.message : "Internal error",
            data: { code: "INTERNAL_ERROR", retryable: false },
          };
    postRpcError(port, normalizedRequestId, error);
  }
}

export function postRpcNotification(
  port: MessagePort | undefined,
  method: string,
  params?: JsonValue,
): void {
  if (!port) return;
  const message: JsonRpcNotification = {
    jsonrpc: JSON_RPC_VERSION,
    method,
    ...(params === undefined ? {} : { params }),
  };
  try {
    port.postMessage(message);
  } catch {
    // The iframe may navigate while an asynchronous operation is completing.
  }
}

export function postRpcResult(
  port: MessagePort,
  id: string | null,
  result: JsonValue,
): void {
  const message: JsonRpcSuccess = {
    jsonrpc: JSON_RPC_VERSION,
    id,
    result,
  };
  try {
    port.postMessage(message);
  } catch {
    // The iframe may navigate while an asynchronous operation is completing.
  }
}

export function postRpcError(
  port: MessagePort,
  id: string | null,
  error: JsonRpcErrorObject,
): void {
  const message: JsonRpcFailure = {
    jsonrpc: JSON_RPC_VERSION,
    id,
    error,
  };
  try {
    port.postMessage(message);
  } catch {
    // The iframe may navigate while an asynchronous operation is completing.
  }
}

export function rpcPlatformFault(
  code: string,
  message: string,
  retryable = false,
): RpcFault {
  return new RpcFault(JsonRpcErrorCode.PlatformError, message, {
    code,
    retryable,
  });
}

function isRpcCall(value: unknown): value is JsonRpcRequest | JsonRpcNotification {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    return false;
  const input = value as Record<string, unknown>;
  if (
    input.jsonrpc !== JSON_RPC_VERSION ||
    typeof input.method !== "string" ||
    input.method.length === 0 ||
    input.method.length > 128
  )
    return false;
  return input.params === undefined || isJson(input.params);
}
