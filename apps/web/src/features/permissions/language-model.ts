import { JsonRpcErrorCode, type JsonValue } from "@playweft/game-protocol";
import {
  PlatformApiError,
  promptLanguageModel,
  type LanguageModelMessage,
  type LanguageModelPromptRequest,
} from "@/platform/platform-api";
import { RpcFault } from "@/platform/json-rpc";

const MAX_MESSAGES = 16;
const MAX_INPUT_CHARS = 16_000;
const MAX_OUTPUT_TOKENS = 4_096;
let queuedLanguageModelRequest = Promise.resolve();

export function languageModelPromptFromRpcParams(
  params: JsonValue | undefined,
): LanguageModelPromptRequest | undefined {
  if (!isRecord(params) || !("input" in params)) {
    return undefined;
  }
  const input = languageModelInput(params.input);
  if (input === undefined) return undefined;

  if (params.options !== undefined && !isRecord(params.options)) {
    return undefined;
  }
  const maxOutputTokens = params.options?.maxOutputTokens;
  if (
    maxOutputTokens !== undefined &&
    (typeof maxOutputTokens !== "number" ||
      !Number.isInteger(maxOutputTokens) ||
      maxOutputTokens < 1 ||
      maxOutputTokens > MAX_OUTPUT_TOKENS)
  ) {
    return undefined;
  }
  return {
    input,
    ...(maxOutputTokens === undefined
      ? {}
      : { options: { maxOutputTokens } }),
  };
}

export async function requestLanguageModel(
  prompt: LanguageModelPromptRequest,
  signal?: AbortSignal,
): Promise<string> {
  try {
    return (await enqueueLanguageModelRequest(() => promptLanguageModel(prompt, signal), signal))
      .content;
  } catch (reason) {
    if (signal?.aborted) throw reason;
    if (!(reason instanceof PlatformApiError)) {
      throw new RpcFault(
        JsonRpcErrorCode.PlatformError,
        "Language-model request failed",
        { code: "LANGUAGE_MODEL_FAILED", retryable: true },
      );
    }
    const code =
      reason.status === 401
        ? "CLOUDFLARE_CONNECTION_REQUIRED"
        : reason.status === 409
          ? "LANGUAGE_MODEL_UNAVAILABLE"
          : reason.status === 429
          ? "RATE_LIMITED"
            : "LANGUAGE_MODEL_FAILED";
    throw new RpcFault(JsonRpcErrorCode.PlatformError, reason.message, {
      code,
      retryable:
        reason.retryable ??
        (reason.status === 429 || reason.status >= 500),
      ...(reason.requestId ? { requestId: reason.requestId } : {}),
    });
  }
}

export function enqueueLanguageModelRequest<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const run = () => {
    signal?.throwIfAborted();
    return request();
  };
  const next = queuedLanguageModelRequest.then(run, run);
  // Keep the queue alive after a rejected model request, while returning the
  // original result to its caller.
  queuedLanguageModelRequest = next.then(
    () => undefined,
    () => undefined,
  );
  if (!signal) return next;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    next.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function languageModelInput(
  input: unknown,
): string | LanguageModelMessage[] | undefined {
  if (typeof input === "string") {
    return input.length > 0 && input.length <= MAX_INPUT_CHARS
      ? input
      : undefined;
  }
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_MESSAGES) {
    return undefined;
  }
  const messages: LanguageModelMessage[] = [];
  let inputChars = 0;
  for (const message of input) {
    if (
      !isRecord(message) ||
      (message.role !== "system" &&
        message.role !== "user" &&
        message.role !== "assistant") ||
      typeof message.content !== "string" ||
      message.content.length === 0
    ) {
      return undefined;
    }
    inputChars += message.content.length;
    if (inputChars > MAX_INPUT_CHARS) return undefined;
    messages.push({ role: message.role, content: message.content });
  }
  return messages;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
