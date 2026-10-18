/** Bind to the MessagePort received in playweft:bridge; destroy before replacing it. */
export function createRoomClient(port) {
  let pending, destroyed = false;
  const closed = () => Object.assign(new Error("The game bridge was closed"), { code: "BRIDGE_CLOSED" });
  function receive({ data }) {
    if (data?.jsonrpc !== "2.0" || !pending || data.id !== pending.id) return;
    const request = pending; pending = undefined;
    if (data.error) {
      request.reject(Object.assign(new Error(data.error.message), {
        code: data.error.data?.code, rpcCode: data.error.code,
        retryable: data.error.data?.retryable === true,
      }));
    } else if (typeof data.result?.roomId === "string" && data.result.roomId) {
      request.resolve(data.result);
    } else {
      request.reject(new Error("Invalid room.create result"));
    }
  }
  port.addEventListener("message", receive); port.start();
  return {
    create() {
      if (destroyed) return Promise.reject(closed());
      if (pending) return pending.promise;
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      const id = crypto.randomUUID();
      pending = { id, promise, resolve, reject };
      try { port.postMessage({ jsonrpc: "2.0", id, method: "room.create" }); }
      catch (error) { pending = undefined; reject(error); }
      return promise;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true; port.removeEventListener("message", receive);
      pending?.reject(closed()); pending = undefined;
    },
  };
}
