/** Async Storage-style API bound to an established Playweft bridge port. */
export function createLocalStorageClient(port, { timeoutMs = 10000 } = {}) {
  let destroyed = false,
    tail = Promise.resolve();
  const pending = new Map();
  const closed = () =>
    Object.assign(new Error("The game bridge was closed"), {
      code: "BRIDGE_CLOSED",
    });
  function receive({ data }) {
    if (data?.jsonrpc !== "2.0") return;
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);
    if (data.error)
      entry.reject(
        Object.assign(new Error(data.error.message), {
          name:
            data.error.data?.code === "STORAGE_QUOTA_EXCEEDED"
              ? "QuotaExceededError"
              : "Error",
          code: data.error.data?.code,
          rpcCode: data.error.code,
          retryable: data.error.data?.retryable === true,
        }),
      );
    else entry.resolve(data.result);
  }
  port.addEventListener("message", receive);
  port.start();
  function call(method, params) {
    const result = tail.then(
      () =>
        new Promise((resolve, reject) => {
          if (destroyed) return reject(closed());
          const id = crypto.randomUUID();
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(
              Object.assign(
                new Error(
                  "Storage request timed out; its commit status is unknown",
                ),
                { code: "STORAGE_TIMEOUT", retryable: true },
              ),
            );
          }, timeoutMs);
          pending.set(id, { resolve, reject, timer });
          try {
            port.postMessage({
              jsonrpc: "2.0",
              id,
              method,
              ...(params === undefined ? {} : { params }),
            });
          } catch (error) {
            clearTimeout(timer);
            pending.delete(id);
            reject(error);
          }
        }),
    );
    tail = result.catch(() => {});
    return result;
  }
  return {
    async getItem(key) {
      return call("localStorage.getItem", { key: String(key) });
    },
    async setItem(key, value) {
      await call("localStorage.setItem", {
        key: String(key),
        value: String(value),
      });
    },
    async removeItem(key) {
      await call("localStorage.removeItem", { key: String(key) });
    },
    async clear() {
      await call("localStorage.clear");
    },
    async key(index) {
      if (!Number.isSafeInteger(index) || index < 0)
        throw new TypeError(
          "Storage index must be a non-negative safe integer",
        );
      return call("localStorage.key", { index });
    },
    async length() {
      return call("localStorage.length");
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      port.removeEventListener("message", receive);
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(closed());
      }
      pending.clear();
    },
  };
}
