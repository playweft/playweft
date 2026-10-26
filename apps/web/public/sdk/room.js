/** Bind to the shared MessagePort; destroy this client before replacing the bridge. */
export function createRoomClient(port) {
  let destroyed = false, createPending, latestState;
  const pending = new Map(), stateListeners = new Set(), closedListeners = new Set();
  const closed = () => Object.assign(new Error("The game bridge was closed"), { code: "BRIDGE_CLOSED" });
  function updateState(state, notify) {
    if (!state || typeof state.roomId !== "string" || !Number.isInteger(state.revision)) return;
    if (latestState && latestState.roomId === state.roomId && latestState.revision > state.revision) return;
    latestState = state;
    if (notify) for (const listener of stateListeners) listener(state);
  }
  function receive({ data }) {
    if (data?.jsonrpc !== "2.0" || destroyed) return;
    if (data.method === "room.stateChanged") { updateState(data.params, true); return; }
    if (data.method === "room.closed") {
      for (const listener of closedListeners) listener(data.params);
      return;
    }
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) {
      request.reject(Object.assign(new Error(data.error.message), {
        code: data.error.data?.code, rpcCode: data.error.code,
        retryable: data.error.data?.retryable === true,
      }));
    } else if (request.method === "room.create" && !(typeof data.result?.roomId === "string" && data.result.roomId)) {
      request.reject(new Error("Invalid room.create result"));
    } else {
      updateState(data.result, false);
      request.resolve(data.result);
    }
  }
  function request(method, params) {
    if (destroyed) return Promise.reject(closed());
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      pending.set(id, { method, resolve, reject });
      try { port.postMessage({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }
  port.addEventListener("message", receive); port.start();
  return {
    create() {
      if (destroyed) return Promise.reject(closed());
      if (createPending) return createPending;
      createPending = request("room.create");
      createPending.then(() => { createPending = undefined; }, () => { createPending = undefined; });
      return createPending;
    },
    getState: () => request("room.getState"),
    setReady: ready => request("room.setReady", { ready }),
    setSeat: seat => request("room.setSeat", { seat }),
    start: () => request("room.start"),
    leave: () => request("room.leave"),
    onStateChanged(listener) {
      if (destroyed) return () => {};
      stateListeners.add(listener);
      if (latestState) listener(latestState);
      return () => stateListeners.delete(listener);
    },
    onClosed(listener) {
      if (destroyed) return () => {};
      closedListeners.add(listener);
      return () => closedListeners.delete(listener);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true; port.removeEventListener("message", receive);
      for (const request of pending.values()) request.reject(closed());
      pending.clear(); stateListeners.clear(); closedListeners.clear(); latestState = undefined;
    },
  };
}

/** Bind once per bridge. Expose the result as playweft.rooms. */
export function createRoomsClient(port, initialState = null) {
  let destroyed = false, current = null, opening;
  const pending = new Map();
  const fault = (code, message) => Object.assign(new Error(message), { code });
  const bridgeClosed = () => fault("BRIDGE_CLOSED", "The game bridge was closed");
  function rpc(method, params, room) {
    if (destroyed) return Promise.reject(bridgeClosed());
    if (room && (room !== current || room.closed)) return Promise.reject(fault("ROOM_CLOSED", "This room handle is closed"));
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID(); pending.set(id, { method, room, resolve, reject });
      try { port.postMessage({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }
  function immutable(value) {
    const copy = structuredClone(value);
    function freeze(object) { if (object && typeof object === "object") { Object.values(object).forEach(freeze); Object.freeze(object); } }
    freeze(copy); return copy;
  }
  class Room extends EventTarget {
    #state;
    #closed = false;
    constructor(state) { super(); this.#state = immutable(state); }
    get id() { return this.#state.roomId; }
    get state() { return this.#state; }
    get closed() { return this.#closed; }
    getConfiguration() { return { minPlayers: this.#state.minPlayers, maxPlayers: this.#state.maxPlayers, lobby: this.#state.lobby }; }
    async #mutate(method, params) { await rpc(method, params, this); }
    setConfiguration(configuration) { return this.#mutate("room.setConfiguration", configuration); }
    setReady(ready) { return this.#mutate("room.setReady", { ready }); }
    setSeat(seat) { return this.#mutate("room.setSeat", { seat }); }
    start() { return this.#mutate("room.start"); }
    async leave() {
      await rpc("room.leave", undefined, this);
      closeRoom(this);
    }
    update(state) {
      if (this.#closed || state.roomId !== this.id || state.revision <= this.#state.revision) return;
      this.#state = immutable(state); this.dispatchEvent(new Event("statechange"));
    }
    close() { if (!this.#closed) { this.#closed = true; this.dispatchEvent(new Event("close")); } }
  }
  function closeRoom(room) {
    if (!room || room.closed) return;
    if (current === room) current = null;
    for (const [id, request] of pending) {
      if (request.room === room && request.method !== "room.leave") {
        pending.delete(id); request.reject(fault("ROOM_CLOSED", "The room was closed"));
      }
    }
    room.close();
  }
  function acceptState(state) {
    if (!state || typeof state.roomId !== "string" || !Number.isInteger(state.revision)) throw fault("INVALID_ROOM_STATE", "Invalid room state");
    if (current && current.id !== state.roomId) closeRoom(current);
    if (!current) current = new Room(state); else current.update(state);
    return current;
  }
  function receive({ data }) {
    if (destroyed || data?.jsonrpc !== "2.0") return;
    if (data.method === "room.stateChanged") { acceptState(data.params); return; }
    if (data.method === "room.closed") {
      for (const [id, request] of pending) {
        if (request.method === "rooms.create" || request.method === "rooms.join") {
          pending.delete(id); request.reject(fault("ROOM_CLOSED", "The room was closed before entry completed"));
        }
      }
      closeRoom(current); return;
    }
    const request = pending.get(data.id); if (!request) return;
    pending.delete(data.id);
    if (data.error) { request.reject(Object.assign(new Error(data.error.message), { code: data.error.data?.code, rpcCode: data.error.code, retryable: data.error.data?.retryable === true })); return; }
    if (request.method !== "room.leave") {
      try { acceptState(data.result); } catch (error) { request.reject(error); return; }
    }
    request.resolve(data.result);
  }
  function open(target, params) {
    if (destroyed) return Promise.reject(bridgeClosed());
    if (current) return target === "create" || target === current.id ? Promise.resolve(current) :
      Promise.reject(fault("ROOM_ALREADY_JOINED", "Leave the current room before joining another room"));
    if (opening) return opening.target === target ? opening.promise :
      Promise.reject(fault("ROOM_OPERATION_PENDING", "Another room operation is in progress"));
    const promise = rpc(target === "create" ? "rooms.create" : "rooms.join", params).then(() => current);
    opening = { target, promise };
    void promise.then(() => { opening = undefined; }, () => { opening = undefined; });
    return promise;
  }
  port.addEventListener("message", receive); port.start();
  if (initialState) acceptState(initialState);
  return {
    get current() { return current; },
    create: (options = {}) => open("create", options),
    join: roomId => open(roomId, { roomId }),
    destroy() {
      if (destroyed) return; destroyed = true;
      port.removeEventListener("message", receive);
      for (const request of pending.values()) request.reject(bridgeClosed());
      pending.clear(); closeRoom(current);
    },
  };
}
