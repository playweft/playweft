/** Bind to the MessagePort received in playweft:bridge. Destroy before replacing it. */
export function createLanguageModelClient(port) {
  const pending = new Map();
  let destroyed = false;
  const cancelled = () => new DOMException("Language-model request was cancelled", "AbortError");
  function cancel(id) {
    try {
      port.postMessage({ jsonrpc: "2.0", method: "languageModel.cancel", params: { requestId: id } });
    } catch { /* The bridge may already be closed. */ }
  }
  function receive({ data }) {
    if (data?.jsonrpc !== "2.0") return;
    const request = pending.get(data.id);
    if (!request) return;
    if (data.error) {
      const error = data.error.data?.code === "REQUEST_CANCELLED"
        ? cancelled()
        : Object.assign(new Error(data.error.message), {
            code: data.error.data?.code, rpcCode: data.error.code,
            retryable: data.error.data?.retryable === true,
          });
      request.finish(false, error);
    } else {
      request.finish(true, data.result);
    }
  }
  port.addEventListener("message", receive);
  port.start();
  return {
    prompt(input, { signal, ...options } = {}) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (destroyed) return Promise.reject(cancelled());
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const finish = (success, value) => {
          if (!pending.delete(id)) return;
          signal?.removeEventListener("abort", abort);
          if (success) resolve(value);
          else reject(value);
        };
        const abort = () => {
          finish(false, signal.reason);
          cancel(id);
        };
        pending.set(id, { finish });
        signal?.addEventListener("abort", abort, { once: true });
        try {
          port.postMessage({ jsonrpc: "2.0", id, method: "languageModel.prompt", params: { input, options } });
        } catch (error) {
          finish(false, error);
        }
      });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      port.removeEventListener("message", receive);
      for (const [id, request] of pending) {
        request.finish(false, cancelled());
        cancel(id);
      }
    },
  };
}
