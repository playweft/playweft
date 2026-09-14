import { rpcPlatformFault, type RpcHandlers } from "@/platform/json-rpc";

/** Each bridge connection owns its request IDs and cancellation controllers. */
export function cancellableLanguageModelHandlers(handlers: RpcHandlers) {
  let closed = false;
  const requests = new Map<string, AbortController>();
  const cancelRequests = () => {
    closed = true;
    for (const controller of requests.values()) controller.abort();
    requests.clear();
  };
  const promptHandler = handlers["languageModel.prompt"];
  const connectionHandlers: RpcHandlers = {
    ...handlers,
    "languageModel.cancel": {
      allowNotification: true,
      handle(params) {
        if (params && typeof params === "object" && !Array.isArray(params) &&
            typeof params.requestId === "string") {
          requests.get(params.requestId)?.abort();
        }
        return null;
      },
    },
    ...(promptHandler ? {
      "languageModel.prompt": {
        async handle(params, requestId) {
          if (!requestId) return null;
          if (closed) throw rpcPlatformFault("REQUEST_CANCELLED", "The bridge connection is closed");
          if (requests.has(requestId)) {
            throw rpcPlatformFault("INVALID_REQUEST_ID", "Request ID is already active");
          }
          const controller = new AbortController();
          requests.set(requestId, controller);
          try {
            const result = await promptHandler.handle(params, requestId, controller.signal);
            controller.signal.throwIfAborted();
            return result;
          } catch (error) {
            if (controller.signal.aborted) {
              throw rpcPlatformFault("REQUEST_CANCELLED", "Language-model request was cancelled");
            }
            throw error;
          } finally {
            requests.delete(requestId);
          }
        },
      },
    } : {}),
  };
  return { handlers: connectionHandlers, cancel: cancelRequests };
}
