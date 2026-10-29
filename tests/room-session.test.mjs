import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { webcrypto } from 'node:crypto';

const root = fileURLToPath(new URL("../", import.meta.url));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

// Compile the actual client modules with an isolated browser clock and sockets.
// No wall-clock delays or network requests are needed for lifetime tests.
function browser() {
  let now = 0,
    timerId = 0,
    uuid = 0;
  const timers = new Map(),
    listeners = new Set(),
    sockets = [];
  const document = {
    visibilityState: "visible",
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  class Socket {
    static OPEN = 1;
    readyState = 0;
    sent = [];
    closeCount = 0;
    sendError = false;
    send(message) {
      if (this.sendError) throw new Error("send failed");
      this.sent.push(JSON.parse(message));
    }
    open() {
      this.readyState = 1;
      this.onopen?.({});
    }
    message(message) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }
    close(code = 1006) {
      this.readyState = 3;
      this.closeCount++;
      this.onclose?.({ code });
    }
    error() {
      this.onerror?.({});
    }
  }
  const window = {
    location: { origin: "https://playweft.example" },
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  const globals = {
    window,
    document,
    WebSocket: Socket,
    performance: { now: () => now },
    crypto: { randomUUID: () => `request-${++uuid}` },
    Error,
    URL,
    Response,
    Request,
    Headers,
    TextEncoder,
    AbortController,
    DOMException,
  };
  const cache = new Map();
  function moduleAt(path, mocks = {}) {
    const absolute = resolve(root, path);
    if (cache.has(absolute)) return cache.get(absolute);
    const module = { exports: {} };
    cache.set(absolute, module.exports);
    const source = readFileSync(absolute, "utf8").replaceAll(
      "import.meta.env",
      "({})",
    );
    const { outputText } = ts.transpileModule(source, {
      fileName: absolute,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
      },
    });
    vm.runInNewContext(
      outputText,
      {
        ...globals,
        module,
        exports: module.exports,
        require(name) {
          if (name in mocks) return mocks[name];
          let target;
          if (name === "@playweft/game-protocol")
            target = resolve(root, "packages/game-protocol/src/index.ts");
          else if (name === "@playweft/runtime-core")
            target = resolve(root, "packages/runtime-core/src/index.ts");
          else if (name.startsWith("@/"))
            target = resolve(root, "apps/web/src", `${name.slice(2)}.ts`);
          else if (name.startsWith("."))
            target = resolve(dirname(absolute), `${name}.ts`);
          else throw new Error(`Unexpected test import: ${name}`);
          return moduleAt(target, mocks);
        },
      },
      { filename: absolute },
    );
    return module.exports;
  }
  return {
    moduleAt,
    globals,
    timers,
    listeners,
    sockets,
    socket() {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
    resume() {
      for (const listener of [...listeners]) listener();
    },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...timers]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        timers.delete(id);
        timer.callback();
      }
      now = until;
    },
  };
}
const presence = (revision = 1, phase = "lobby", extra = {}) => ({
  type: "room.presence",
  revision,
  phase,
  ownerId: "self",
  minPlayers: 1,
  maxPlayers: 2,
  players: [{ id: "self", seat: 1, name: "Player" }],
  spectators: [],
  ...extra,
});
const snapshot = (version = 1, matchId = "match") => ({
  type: "snapshot",
  matchId,
  version,
  serverTime: 1000,
  state: { version },
  events: [],
  scriptHash: "hash",
});
const loadedGame = (id = "game", liveRoom = true) => ({
  game: {
    url: `https://${id}.example/`,
    manifestUrl: `https://${id}.example/playweft.json`,
    manifestId: id,
    name: id,
  },
  manifest: { modes: { room: {} } },
  room: {
    gameId: id,
    gameVersion: "1",
    runtime: "lua",
    serverUrl: `https://${id}.example/server.lua`,
    minPlayers: 1,
    maxPlayers: 2,
    liveRoom,
  },
});
function fixture(overrides = {}, { liveRoom = true, phase = "lobby" } = {}) {
  const b = browser();
  const { PlatformApiError } = b.moduleAt(
    "apps/web/src/platform/platform-api.ts",
  );
  const { RoomSession } = b.moduleAt(
    "apps/web/src/features/room/RoomSession.ts",
  );
  const counts = { initialize: 0, join: 0, ended: 0 },
    discovered = [];
  let nickname = "Player";
  const api = {
    createGuestSession: async () => {},
    getRoomLaunch: async () => ({
      manifestUrl: "https://game.example/playweft.json",
    }),
    getRoomMembership: async () => ({ selfId: "self" }),
    loadGameManifest: async () => loadedGame("game", liveRoom),
    manifestUrlFromInput: (url) => url,
    initializeRoom: async () => {
      counts.initialize++;
      return presence(1, phase);
    },
    joinRoom: async () => {
      counts.join++;
      return { ...presence(1, phase), selfId: "self" };
    },
    getPlatformSession: async () => ({ provider: "guest" }),
    setRoomProfileAvatarSharing: async () => presence(1, phase),
    connectRoom: () => b.socket(),
    startRoom: async () => ({
      presence: presence(2, "playing"),
      snapshot: snapshot(),
    }),
    leaveRoom: async () => ({ left: true }),
    dissolveRoom: async () => ({ dissolved: true }),
    setRoomSeat: async () => presence(2),
    setPlayerReady: async () => presence(2),
    kickPlayer: async () => presence(2),
    transferRoomHost: async () => presence(2),
    returnRoomToLobby: async () => presence(3),
    changeRoomGame: async () => ({}),
    sendAction: async () => ({
      result: { accepted: true, matchId: "match", version: 2 },
      update: snapshot(2),
    }),
    ...overrides,
  };
  const session = new RoomSession("room", api, {
    nickname: () => nickname,
    message: (key) => key,
    onGameDiscovered: (game) => discovered.push(game),
    onEnd: () => counts.ended++,
  });
  return {
    ...b,
    api,
    session,
    counts,
    discovered,
    PlatformApiError,
    nickname: (value) => {
      nickname = value;
    },
    async join() {
      await session.enter();
      await session.activate();
      await flush();
      const socket = b.sockets.at(-1);
      socket.open();
      socket.message(presence(2, phase));
      return socket;
    },
  };
}

test("entry waits for activation; frame refresh and repeated activation do not rejoin or reconnect", async () => {
  const f = fixture();
  await f.session.enter();
  assert.equal(f.session.getState().lifecycle, "entering");
  assert.equal(f.sockets.length, 0);
  await f.session.activate();
  assert.equal(f.session.getState().lifecycle, "joined");
  f.session.refreshGame();
  await f.session.activate();
  assert.equal(f.counts.initialize, 1);
  assert.equal(f.counts.join, 1);
  assert.equal(f.sockets.length, 1);
  f.session.dispose();
});

for (const action of ["leave", "dissolve"]) {
  test(`${action}: success and missing-room responses end once and stop all connection work`, async () => {
    for (const kind of ["success", "typed", "legacy"]) {
      const f = fixture();
      const socket = await f.join();
      if (kind !== "success")
        f.api[action === "leave" ? "leaveRoom" : "dissolveRoom"] = async () => {
          throw new f.PlatformApiError(
            kind === "typed" ? "房间已过期" : "room does not exist",
            404,
            undefined,
            undefined,
            kind === "typed" ? "ROOM_NOT_FOUND" : undefined,
          );
        };
      socket.close(); // A scheduled reconnect must be cancelled by ending the room.
      await f.session[action]();
      await f.session[action]();
      assert.equal(f.session.getState().lifecycle, "ended");
      assert.equal(f.counts.ended, 1);
      assert.equal(f.timers.size, 0);
      assert.equal(f.listeners.size, 0);
      f.resume();
      f.advance(60_000);
      assert.equal(f.sockets.length, 1);
    }
  });
  test(`${action}: network, permission and unrelated player errors retain the room`, async () => {
    const f = fixture();
    await f.join();
    for (const error of [
      new Error("offline"),
      new f.PlatformApiError("forbidden", 403),
      ...(action === "dissolve" ? [new f.PlatformApiError("player is not in this room", 404)] : []),
      new f.PlatformApiError(
        "room does not exist",
        404,
        undefined,
        undefined,
        "PLAYER_NOT_FOUND",
      ),
    ]) {
      f.api[action === "leave" ? "leaveRoom" : "dissolveRoom"] = async () => {
        throw error;
      };
      await f.session[action]();
      assert.equal(f.session.getState().lifecycle, "joined");
      assert.equal(f.session.getState().error, error.message);
      assert.equal(f.counts.ended, 0);
    }
    f.session.dispose();
  });
}

test("leaving after removal ends once for typed and legacy missing-member responses without reconnecting", async () => {
  for (const typed of [true, false]) {
    const f = fixture();
    const socket = await f.join();
    f.api.leaveRoom = async () => {
      throw new f.PlatformApiError(
        typed ? "你已不在房间中" : "player is not in this room",
        404, undefined, undefined, typed ? "ROOM_MEMBER_NOT_FOUND" : undefined,
      );
    };
    socket.close();
    await f.session.leave();
    await f.session.leave();
    assert.equal(f.session.getState().lifecycle, "ended");
    assert.equal(f.counts.ended, 1);
    assert.equal(f.timers.size, 0);
    assert.equal(f.listeners.size, 0);
    f.resume(); f.advance(60_000);
    assert.equal(f.sockets.length, 1);
  }
});

test("missing-member errors cannot turn dissolve or unrelated 404 failures into successful exits", async () => {
  const f = fixture(); await f.join();
  f.api.dissolveRoom = async () => {
    throw new f.PlatformApiError("你已不在房间中", 404, undefined, undefined, "ROOM_MEMBER_NOT_FOUND");
  };
  await f.session.dissolve();
  assert.equal(f.counts.ended, 0);
  f.api.leaveRoom = async () => { throw new f.PlatformApiError("unrelated resource missing", 404); };
  await f.session.leave();
  assert.equal(f.session.getState().lifecycle, "joined");
  assert.equal(f.counts.ended, 0); f.session.dispose();
});

test("server dissolution and removal close codes use the same end path", async () => {
  for (const signal of ["message", 4003, 4004]) {
    const f = fixture();
    const socket = await f.join();
    if (signal === "message")
      socket.message({ type: "room_dissolved", error: "ended" });
    else socket.close(signal);
    assert.equal(f.session.getState().lifecycle, "ended");
    assert.equal(f.counts.ended, 1);
    assert.equal(f.timers.size, 0);
    assert.equal(f.listeners.size, 0);
    f.resume();
    f.advance(60_000);
    assert.equal(f.sockets.length, 1);
  }
});

test("late initialization, join or launch results cannot continue after disposal", async () => {
  for (const operation of [
    "createGuestSession",
    "getRoomLaunch",
    "initializeRoom",
    "joinRoom",
  ]) {
    const gate = deferred(),
      f = fixture({ [operation]: () => gate.promise });
    let work;
    if (operation === "createGuestSession" || operation === "getRoomLaunch")
      work = f.session.enter();
    else {
      await f.session.enter();
      work = f.session.activate();
    }
    await flush();
    f.session.dispose();
    gate.resolve(
      operation === "getRoomLaunch"
        ? { manifestUrl: "https://game.example/playweft.json" }
        : operation === "joinRoom"
          ? { ...presence(), selfId: "self" }
          : undefined,
    );
    await work;
    assert.equal(f.session.getState().lifecycle, "ended");
    assert.equal(f.sockets.length, 0);
    assert.equal(f.counts.ended, 0, "unmount is not a navigation request");
  }
});

test("connection replacement ignores old events and preserves the new heartbeat", async () => {
  const f = fixture();
  const old = await f.join();
  const oldClose = old.onclose;
  f.resume();
  const current = f.sockets.at(-1);
  current.open();
  current.message(presence(3));
  const errorBefore = f.session.getState().error;
  old.error();
  old.message({ type: "room_dissolved", error: "late" });
  oldClose({ code: 4004 });
  assert.equal(f.session.getState().lifecycle, "joined");
  assert.equal(f.session.getState().error, errorBefore);
  const sent = current.sent.length;
  f.advance(20_000);
  assert.equal(
    current.sent.length,
    sent + 1,
    "old close cannot clear the active heartbeat",
  );
  assert.equal(f.sockets.length, 2);
  f.session.dispose();
});

test("connection retries are bounded and resume restarts recovery", async () => {
  const f = fixture();
  const first = await f.join();
  first.close();
  for (let i = 0; i < 5; i++) {
    f.advance(2_000);
    f.sockets.at(-1).error();
    f.sockets.at(-1).close();
  }
  assert.equal(f.sockets.length, 6);
  assert.equal(f.session.getState().connection, "failed");
  assert.equal(f.session.getState().error, "liveConnectionNotRestored");
  f.advance(60_000);
  assert.equal(f.sockets.length, 6);
  f.resume();
  assert.equal(f.sockets.length, 7);
  assert.equal(f.session.getState().error, undefined);
  f.session.dispose();
});

test("live actions resolve by id, reject duplicates, and cancel on interruption and bridge replacement", async () => {
  const f = fixture({}, { phase: "playing" });
  const socket = await f.join();
  const result = f.session.action("one", { move: 1 });
  await assert.rejects(
    f.session.action("one", {}),
    (e) => e.data.code === "DUPLICATE_REQUEST",
  );
  socket.message({
    type: "action-result",
    requestId: "one",
    accepted: true,
    matchId: "match",
    version: 2,
  });
  assert.equal((await result).version, 2);
  const interrupted = f.session.action("two", {});
  socket.close();
  await assert.rejects(
    interrupted,
    (e) => e.data.code === "REALTIME_CONNECTION_INTERRUPTED",
  );
  await assert.rejects(
    f.session.action("offline", {}),
    (e) => e.data.code === "REALTIME_CONNECTION_NOT_READY",
  );
  f.advance(2_000);
  const next = f.sockets.at(-1);
  next.open();
  next.message(presence(3, "playing"));
  const replaced = f.session.action("three", {});
  f.session.cancelActions("BRIDGE_REPLACED", "replaced");
  await assert.rejects(replaced, (e) => e.data.code === "BRIDGE_REPLACED");
  assert.equal(
    f.sockets.length,
    2,
    "bridge cancellation keeps the room connection",
  );
  f.session.dispose();
});

test("failed live sends do not leave a permanently pending request id", async () => {
  const f = fixture({}, { phase: "playing" });
  const socket = await f.join();
  socket.sendError = true;
  await assert.rejects(
    f.session.action("same", {}),
    (e) => e.data.code === "REALTIME_CONNECTION_NOT_READY",
  );
  socket.sendError = false;
  const result = f.session.action("same", {});
  socket.message({
    type: "action-result",
    requestId: "same",
    accepted: false,
    matchId: "match",
    version: 1,
    error: { code: "INVALID_MOVE", message: "invalid" },
  });
  assert.equal((await result).error.code, "INVALID_MOVE");
  f.session.dispose();
});

test("live state broadcasts advance both viewers and are replayed after frame refresh", async () => {
  const viewers = [fixture({}, { phase: "playing" }), fixture({}, { phase: "playing" })];
  try {
    for (const [index, f] of viewers.entries()) {
      const socket = await f.join();
      socket.message(snapshot(1));
      socket.message({
        ...snapshot(2),
        type: "state",
        state: { currentPlayerId: "next", viewerId: `player-${index}` },
      });
      socket.message({ ...snapshot(1), type: "state" });
      assert.equal(f.session.getState().snapshot.version, 2);
      assert.equal(f.session.getState().snapshot.state.currentPlayerId, "next");
      assert.equal(f.session.getState().snapshot.state.viewerId, `player-${index}`);

      f.session.refreshGame();
      const hook = bridgeHarness(f);
      try {
        hook.render();
        const bridge = hook.attachments[0];
        bridge.connect();
        await bridge.options.handlers["game.initialize"].handle();
        f.advance(0);
        const replay = bridge.messages.find((m) => m.method === "game.state").params;
        assert.equal(replay.version, 2);
        assert.equal(replay.state.currentPlayerId, "next");
      } finally {
        hook.dispose();
      }
    }
  } finally {
    for (const f of viewers) f.session.dispose();
  }
});

test("snapshot ordering ignores stale versions; return to lobby clears state and rejects late HTTP snapshots", async () => {
  const gate = deferred(),
    f = fixture(
      { sendAction: () => gate.promise },
      { phase: "playing", liveRoom: false },
    );
  const socket = await f.join();
  socket.message(snapshot(3));
  socket.message(snapshot(2));
  assert.equal(f.session.getState().snapshot.version, 3);
  const result = f.session.action("http", {});
  socket.message(presence(5));
  socket.message(snapshot(4));
  assert.equal(f.session.getState().snapshot, undefined);
  socket.message(presence(6, "playing"));
  socket.message(snapshot(0, "new-match"));
  gate.resolve({
    update: snapshot(4),
    result: { accepted: true, version: 4, matchId: "match" },
  });
  await assert.rejects(result, (e) => e.data.code === "ACTION_REJECTED");
  assert.equal(f.session.getState().snapshot.matchId, "new-match");
  f.session.dispose();
});

test("switching games retains the socket and ignores previous game HTTP work", async () => {
  const gate = deferred(),
    f = fixture({ setRoomSeat: () => gate.promise });
  const socket = await f.join();
  const move = f.session.chooseSeat(2);
  f.api.loadGameManifest = async () => loadedGame("next");
  socket.message({
    type: "game_changed",
    manifestUrl: "https://next.example/playweft.json",
  });
  socket.message(presence(10));
  await flush();
  await f.session.activate();
  gate.resolve(presence(99));
  assert.equal(await move, false);
  assert.equal(f.session.getState().loadedGame.game.manifestId, "next");
  assert.equal(f.session.getState().presence.revision, 10);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.counts.initialize, 2);
  assert.equal(f.counts.join, 2);
  const before = socket.sent.length;
  f.advance(20_000);
  assert.equal(
    socket.sent.length,
    before + 1,
    "membership still enables heartbeats when join response is older",
  );
  f.session.dispose();
});

test("newer manifest and nickname results cannot be overwritten by stale work", async () => {
  const oldManifest = deferred(),
    oldNickname = deferred(),
    f = fixture();
  const socket = await f.join();
  f.api.loadGameManifest = (url) =>
    url.includes("old")
      ? oldManifest.promise
      : Promise.resolve(loadedGame("latest"));
  socket.message({
    type: "game_changed",
    manifestUrl: "https://old.example/playweft.json",
  });
  socket.message({
    type: "game_changed",
    manifestUrl: "https://latest.example/playweft.json",
  });
  await flush();
  await f.session.activate();
  oldManifest.resolve(loadedGame("old"));
  await flush();
  assert.equal(f.session.getState().loadedGame.game.manifestId, "latest");
  f.api.createGuestSession = (name) =>
    name === "old" ? oldNickname.promise : Promise.resolve();
  f.nickname("old");
  const old = f.session.syncNickname();
  f.nickname("latest");
  await f.session.syncNickname();
  const joined = f.counts.join;
  oldNickname.resolve();
  await old;
  assert.equal(f.counts.join, joined, "stale nickname request cannot rejoin");
  f.session.dispose();
});

test("latency probes are acknowledged and spectators receive no idle heartbeat", async () => {
  const f = fixture();
  const socket = await f.join();
  const probe = socket.sent[0].ackId;
  f.advance(40);
  socket.message({ type: "platform.ack", ackId: probe });
  assert.equal(f.session.getState().latency, 40);
  socket.message(
    presence(4, "lobby", { ownerId: "other", players: [], spectators: [{ id: "self" }] }),
  );
  const before = socket.sent.length;
  f.advance(60_000);
  assert.equal(socket.sent.length, before);
  f.session.dispose();
});

test("API transports typed room errors and does not classify unrelated 404 responses as room termination", async () => {
  const b = browser();
  b.globals.fetch = async () =>
    Response.json(
      { code: "ROOM_NOT_FOUND", error: "房间已过期" },
      { status: 404 },
    );
  const api = b.moduleAt("apps/web/src/platform/platform-api.ts");
  const errors = b.moduleAt("apps/web/src/features/room/room-errors.ts");
  await assert.rejects(
    api.leaveRoom("room"),
    (e) => e instanceof api.PlatformApiError && errors.isRoomNotFound(e),
  );
  assert.equal(
    errors.isRoomNotFound(
      new api.PlatformApiError("player is not in this room", 404),
    ),
    false,
  );
});

// React adapter harness: rerenders retain refs and only rerun effects whose
// dependencies change. Permission hooks intentionally return new callbacks.
function bridgeHarness(f) {
  let index = 0,
    callbacksVersion = 0;
  const slots = [],
    effects = [],
    attachments = [],
    cancellations = [];
  const ref = { current: {} };
  const react = {
    useRef(value) {
      const i = index++;
      return (slots[i] ??= { current: value });
    },
    useEffect(callback, dependencies) {
      const i = index++,
        previous = slots[i];
      if (
        !previous ||
        dependencies.some(
          (value, j) => !Object.is(value, previous.dependencies[j]),
        )
      ) {
        effects.push(() => {
          previous?.cleanup?.();
          slots[i] = { dependencies, cleanup: callback() };
        });
      }
    },
  };
  const permission = (name) => ({
    cancelPending: () => cancellations.push(name),
  });
  const mocks = {
    react,
    "@/app/i18n": { useI18n: () => ({ t: (key) => key }) },
    "@/features/game/GameFrame": {
      attachGameBridge(options) {
        const entry = { options, detached: 0, messages: [] };
        attachments.push(entry);
        entry.connect = () => {
          options.onBeforeConnect();
          options.onPortChange({
            postMessage: (message) => entry.messages.push(message),
          });
        };
        return () => {
          entry.detached++;
          options.onPortChange(undefined);
        };
      },
    },
    "@/features/game/GameWindowDialog": {
      PLATFORM_WINDOW_CAPABILITIES: ["window.alert", "window.confirm"],
      useGameWindowDialogs: () => ({
        ...permission("window"),
        requestAlert: async () => null,
        requestConfirm: async () => true,
      }),
    },
    "@/features/permissions/ClipboardPrompt": {
      useClipboardRead: () => {
        const version = callbacksVersion;
        return {
          ...permission("clipboard"),
          requestReadText: async () => `clipboard-${version}`,
        };
      },
    },
    "@/features/permissions/LanguageModelPermission": {
      useLanguageModelPermission: () => ({
        ...permission("languageModel"),
        requestPermission: async () => {},
      }),
    },
    "@/features/permissions/language-model": {
      languageModelPromptFromRpcParams: (params) => params,
      requestLanguageModel: async () => ({ content: "ok" }),
    },
    "@/features/permissions/UserProfilePrompt": {
      userProfileFieldsFromRpcParams: (params) => params?.fields,
      useUserProfileAccess: () => ({
        ...permission("profile"),
        requestProfile: async () => ({ name: "Player" }),
      }),
    },
    "./RoomPlayerProfile": {
      useRoomPlayerProfileAccess: () => ({
        requestProfile: async () => ({ name: "Player" }),
      }),
    },
  };
  const { useRoomGameBridge } = f.moduleAt(
    "apps/web/src/features/room/useRoomGameBridge.ts",
    mocks,
  );
  return {
    attachments,
    cancellations,
    render() {
      index = 0;
      callbacksVersion++;
      useRoomGameBridge({
        session: f.session,
        state: f.session.getState(),
        frame: ref,
        gameName: "Game",
        nickname: "Player",
        deferred: false,
      });
      effects.splice(0).forEach((callback) => callback());
    },
    dispose() {
      slots.forEach((slot) => slot.cleanup?.());
    },
  };
}

test("bridge callback changes and iframe refresh do not initialize, join or reconnect the room", async () => {
  const f = fixture({}, { phase: "playing" });
  await f.join();
  const hook = bridgeHarness(f);
  hook.render();
  const first = hook.attachments[0];
  first.connect();
  const methods = Object.keys(first.options.handlers).sort();
  assert.deepEqual(
    methods,
    [
      "game.initialize",
      "room.action",
      "navigator.clipboard.readText",
      "room.players.getProfile",
      "user.getProfile",
      "languageModel.prompt",
      "localStorage.getItem",
      "localStorage.setItem",
      "localStorage.removeItem",
      "localStorage.clear",
      "localStorage.key",
      "localStorage.length",
      "window.alert",
      "window.confirm",
    ].sort(),
  );
  assert.equal(
    await first.options.handlers["navigator.clipboard.readText"].handle(),
    "clipboard-1",
  );
  hook.render();
  assert.equal(hook.attachments.length, 1);
  assert.equal(
    await first.options.handlers["navigator.clipboard.readText"].handle(),
    "clipboard-2",
    "handler reads current permissions",
  );
  f.session.refreshGame();
  hook.render();
  hook.attachments[1].connect();
  assert.equal(first.detached, 1);
  assert.equal(f.counts.initialize, 1);
  assert.equal(f.counts.join, 1);
  assert.equal(f.sockets.length, 1);
  await assert.rejects(
    first.options.handlers["room.action"].handle({ action: {} }, "old"),
    (e) => e.data.code === "BRIDGE_CLOSED",
  );
  hook.dispose();
  f.session.dispose();
});

test("bridge initialization replays latest state; return to lobby cancels requests and clears frame communication", async () => {
  const f = fixture({}, { phase: "playing" });
  const socket = await f.join();
  socket.message(snapshot(3));
  const hook = bridgeHarness(f);
  hook.render();
  const bridge = hook.attachments[0];
  bridge.connect();
  const context = await bridge.options.handlers["game.initialize"].handle();
  assert.equal(context.playerId, "self");
  assert.equal(context.mode, "room");
  f.advance(0);
  assert.equal(
    bridge.messages.find((m) => m.method === "game.state").params.version,
    3,
  );
  const action = bridge.options.handlers["room.action"].handle(
    { action: {} },
    "pending",
  );
  socket.message(presence(4));
  await assert.rejects(action, (e) => e.data.code === "BRIDGE_CLOSED");
  assert.equal(bridge.detached, 1);
  assert.equal(hook.cancellations.includes("languageModel"), true);
  assert.equal(f.session.getState().snapshot, undefined);
  assert.equal(f.sockets.length, 1);
  socket.message(presence(5, "playing"));
  hook.render();
  assert.equal(hook.attachments.length, 2);
  hook.dispose();
  f.session.dispose();
});

test("backend marks missing rooms with a typed error while unrelated 404 errors stay distinct", async () => {
  const b = browser();
  const { GameRoom } = b.moduleAt("apps/worker/src/room.ts", {
    "cloudflare:workers": {
      DurableObject: class {
        constructor(ctx) {
          this.ctx = ctx;
        }
      },
    },
    "@playweft/runtime-lua": {},
    "@playweft/runtime-core": {},
    "./runtime-registry": {},
    "./index": {},
    "./session": {},
  });
  const room = new GameRoom({ storage: { get: async () => undefined } }, {});
  const response = await room.fetch(new Request("https://room.example/launch"));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: "room does not exist",
    code: "ROOM_NOT_FOUND",
  });
  const unknown = await room.fetch(new Request("https://room.example/unknown"));
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, undefined);
  const missingMembership = await room.fetch(new Request("https://room.example/membership", {
    headers: { "X-Playweft-Player-Id": "self" },
  }));
  assert.equal(missingMembership.status, 404);
  assert.equal((await missingMembership.json()).code, "ROOM_NOT_FOUND");
  room.launch = async () => ({});
  room.phase = async () => "lobby";
  room.members = async () => ({ host: { actorId: "host-actor" } });
  room.ownerPlayerId = async () => "host";
  const removed = await room.fetch(new Request("https://room.example/leave", {
    method: "POST", headers: { "X-Playweft-Player-Id": "removed" },
  }));
  assert.equal(removed.status, 404);
  assert.deepEqual(await removed.json(), {
    error: "player is not in this room", code: "ROOM_MEMBER_NOT_FOUND",
  });
  const missingMember = await room.fetch(new Request("https://room.example/membership", {
    headers: { "X-Playweft-Player-Id": "removed" },
  }));
  assert.equal(missingMember.status, 404);
  assert.equal((await missingMember.json()).code, "ROOM_MEMBER_NOT_FOUND");
  const member = await room.fetch(new Request("https://room.example/membership", {
    headers: { "X-Playweft-Player-Id": "host" },
  }));
  assert.equal(member.status, 200);
  assert.equal(member.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await member.json(), { selfId: "host-actor" });
  assert.equal((await room.fetch(new Request("https://room.example/membership"))).status, 401);
});

test("nickname changed during entry is synchronized after joining", async () => {
  const names = [],
    f = fixture({
      createGuestSession: async (name) => {
        names.push(name);
      },
    });
  await f.session.enter();
  f.nickname("New nickname");
  await f.session.activate();
  await f.session.syncNickname();
  await f.session.syncNickname();
  assert.deepEqual(names, ["Player", "New nickname"]);
  assert.equal(
    f.counts.join,
    2,
    "the nickname is updated once after initial membership",
  );
  f.session.dispose();
});

test("resume or failed socket recovery confirms a dissolved room over HTTP and ends without further retries", async () => {
  for (const trigger of ['resume', 'close']) {
    for (const typed of [true, false]) {
      const f = fixture(); const socket = await f.join();
      f.api.getRoomMembership = async () => {
        throw new f.PlatformApiError(typed ? '房间已解散' : 'room does not exist', 404,
          undefined, undefined, typed ? 'ROOM_NOT_FOUND' : undefined);
      };
      if (trigger === 'resume') f.resume(); else socket.close();
      await flush();
      assert.equal(f.session.getState().lifecycle, 'ended');
      assert.equal(f.counts.ended, 1);
      assert.equal(f.timers.size, 0); assert.equal(f.listeners.size, 0);
      const count = f.sockets.length; f.resume(); f.advance(60_000);
      assert.equal(f.sockets.length, count);
    }
  }
});

test("room checks retain sessions on network, authentication and unrelated 404 failures; later recovery can end", async () => {
  const f = fixture(); await f.join();
  for (const reason of [new Error('offline'), new f.PlatformApiError('unauthorized', 401),
    new f.PlatformApiError('forbidden', 403), new f.PlatformApiError('other resource missing', 404)]) {
    f.api.getRoomMembership = async () => { throw reason; };
    f.resume(); await flush();
    assert.equal(f.session.getState().lifecycle, 'joined'); assert.equal(f.counts.ended, 0);
  }
  f.api.getRoomMembership = async () => { throw new f.PlatformApiError('room does not exist', 404); };
  f.sockets.at(-1).close(); await flush();
  assert.equal(f.counts.ended, 1); assert.equal(f.timers.size, 0);
});

test("recovery checks coalesce without rejoining or initializing an existing room", async () => {
  const f = fixture(); const socket = await f.join(); const pending = deferred(); let checks = 0;
  f.api.getRoomMembership = () => { checks++; return pending.promise; };
  f.resume(); f.resume(); f.sockets.at(-1).close(); await flush();
  assert.equal(checks, 1);
  pending.resolve({selfId: 'self'}); await flush();
  assert.equal(f.session.getState().lifecycle, 'joined'); assert.equal(f.counts.ended, 0);
  assert.equal(f.counts.initialize, 1); assert.equal(f.counts.join, 1);
  f.advance(2_000); await flush();
  assert.equal(checks, 2); socket.message({type: 'room_dissolved', error: 'old'});
  assert.equal(f.counts.ended, 0); f.session.dispose();
});

test("late room-check errors cannot navigate after unmount or a game change", async () => {
  for (const transition of ['dispose', 'game-change']) {
    const f = fixture(); await f.join(); const pending = deferred();
    f.api.getRoomMembership = () => pending.promise;
    f.resume(); await flush();
    if (transition === 'dispose') f.session.dispose();
    else {
      f.sockets.at(-1).message({type: 'game_changed', manifestUrl: 'https://game.example/next/playweft.json'});
      await flush();
      await f.session.activate();
    }
    pending.reject(new f.PlatformApiError('room does not exist', 404)); await flush();
    assert.equal(f.counts.ended, 0);
    if (transition === 'game-change') assert.equal(f.session.getState().lifecycle, 'joined');
    f.session.dispose();
  }
});

test("recovery detects removal even if the room still exists and the kick close notification was missed", async () => {
  for (const trigger of ['resume', 'close']) {
    const f = fixture(); const socket = await f.join();
    f.api.getRoomMembership = async () => { throw new f.PlatformApiError('removed', 404, undefined, undefined, 'ROOM_MEMBER_NOT_FOUND'); };
    if (trigger === 'resume') f.resume(); else socket.close(1006);
    await flush();
    assert.equal(f.counts.ended, 1); assert.equal(f.session.getState().lifecycle, 'ended');
    assert.equal(f.timers.size, 0); assert.equal(f.listeners.size, 0);
    const count = f.sockets.length; f.resume(); f.advance(60_000);
    assert.equal(f.sockets.length, count);
  }
});

test("room operations consistently end on ROOM_NOT_FOUND without treating other errors as room termination", async () => {
  for (const [method, apiMethod, args] of [
    ['chooseSeat', 'setRoomSeat', [2]], ['setReady', 'setPlayerReady', []],
    ['start', 'startRoom', []], ['returnToRoom', 'returnRoomToLobby', []],
    ['changeGame', 'changeRoomGame', ['https://game.example/new/playweft.json']],
    ['kick', 'kickPlayer', ['other']], ['transferHost', 'transferRoomHost', ['other']],
    ['shareAvatar', 'setRoomProfileAvatarSharing', [true]],
    ['action', 'sendAction', ['request', {}]],
  ]) {
    for (const missing of [true, false]) {
      const f = fixture({}, {phase: method === 'action' ? 'playing' : 'lobby', liveRoom: method !== 'action'});
      await f.join(); await flush();
      f.api[apiMethod] = async () => { throw new f.PlatformApiError(missing ? 'room missing' : 'forbidden', missing ? 404 : 403,
        undefined, undefined, missing ? 'ROOM_NOT_FOUND' : undefined); };
      try { await f.session[method](...args); } catch { /* RPC methods propagate their operation error. */ }
      assert.equal(f.counts.ended, missing ? 1 : 0, `${method}: end classification`);
      if (missing) { assert.equal(f.timers.size, 0); assert.equal(f.listeners.size, 0); }
      else assert.equal(f.session.getState().lifecycle, 'joined');
      f.session.dispose();
    }
  }
});

test("stale ROOM_NOT_FOUND operation results cannot end a different game session", async () => {
  const f = fixture(); await f.join(); const pending = deferred();
  f.api.setRoomSeat = () => pending.promise;
  const operation = f.session.chooseSeat(2);
  f.sockets.at(-1).message({type: 'game_changed', manifestUrl: 'https://game.example/next/playweft.json'});
  await flush(); await f.session.activate();
  pending.reject(new f.PlatformApiError('room missing', 404, undefined, undefined, 'ROOM_NOT_FOUND'));
  await operation;
  assert.equal(f.counts.ended, 0); assert.equal(f.session.getState().lifecycle, 'joined'); f.session.dispose();
});

test('spectating hosts keep an idle heartbeat, while ordinary spectators remain idle', async () => {
  const f = fixture(); const socket = await f.join();
  socket.message(presence(4, 'lobby', {ownerId: 'self', players: [], spectators: [{id: 'self'}]}));
  const before = socket.sent.length; f.advance(20_000);
  assert.ok(socket.sent.length > before);
  socket.message(presence(5, 'lobby', {ownerId: 'other', players: [], spectators: [{id: 'self'}]}));
  const after = socket.sent.length; f.advance(60_000);
  assert.equal(socket.sent.length, after); f.session.dispose();
});

function spectatorHostBackend() {
  const b = browser();
  b.globals.structuredClone = structuredClone;
  b.globals.crypto.getRandomValues = data => { data.fill(1); return data; };
  const {GameRoom} = b.moduleAt('apps/worker/src/room.ts', {
    'cloudflare:workers': {DurableObject: class {constructor(ctx) {this.ctx = ctx;}}},
    '@playweft/runtime-lua': {}, './runtime-registry': {},
  });
  const stored = new Map([['roomMeta', {
    roomId: 'room', manifestUrl: 'https://game.example/playweft.json', phase: 'lobby', ownerPlayerId: 'host', presenceRevision: 0,
    config: {maxPlayers: 2, minPlayers: 2, runtime: 'lua', script: 'same-source', liveRoom: false, scriptHash: 'hash'},
    members: {host: {actorId: 'host', joinedAt: 0, seat: 1, ready: false},
      guest: {actorId: 'guest', joinedAt: 1, seat: 2, ready: true}, observer: {actorId: 'observer', joinedAt: 2, ready: false}},
  }]]);
  const room = new GameRoom({getWebSockets: () => [], storage: {
    get: async key => structuredClone(stored.get(key)), put: async (key, value) => stored.set(key, structuredClone(value)),
    delete: async key => stored.delete(key), deleteAlarm: async () => {}, deleteAll: async () => stored.clear(),
  }}, {});
  const seen = {};
  room.touch = async () => {}; room.scheduleAlarm = async () => {}; room.runDueTimers = async () => {};
  room.engine = async () => ({
    setup(context) {seen.setup = context; return {state: {players: context.players.map(p => p.id)}, events: []};},
    view(state, events, context) {seen.viewer = context.viewer; return {state, events};},
    returnToRoom(_state, context) {seen.returnActor = context.actor; return true;},
    playerLeft(state, context) {seen.leftActor = context.actor; return {state, events: []};},
  });
  return {room, stored, seen, async request(path, player = 'host', body) {
    return room.fetch(new Request(`https://room.example/${path}`, {
      method: 'POST', headers: {'X-Playweft-Player-Id': player, 'Content-Type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    }));
  }};
}

test('host can spectate, transfer to an observer, and leave without forcing the successor to take a seat', async () => {
  const f = spectatorHostBackend();
  let response = await f.request('seat', 'host', {seat: null}); assert.equal(response.status, 200);
  let lobby = await response.json(); assert.equal(lobby.ownerId, 'host'); assert.equal(lobby.players.length, 1);
  assert.ok(lobby.spectators.some(p => p.id === 'host'));
  response = await f.request('transfer-host', 'guest', {playerId: 'observer'}); assert.equal(response.status, 403);
  response = await f.request('transfer-host', 'host', {playerId: 'observer'}); assert.equal(response.status, 200);
  lobby = await response.json(); assert.equal(lobby.ownerId, 'observer'); assert.ok(lobby.spectators.some(p => p.id === 'observer'));
  assert.equal(f.stored.get('roomMeta').members.observer.seat, undefined);
  await f.request('seat', 'guest', {seat: null});
  response = await f.request('leave', 'observer'); assert.equal(response.status, 200);
  assert.equal(f.stored.get('roomMeta').ownerPlayerId, 'host');
  assert.equal(f.stored.get('roomMeta').members.host.seat, undefined);
});

test('spectating host does not count toward required players; starts as an observer and remains one after returning to lobby', async () => {
  const f = spectatorHostBackend(); await f.request('seat', 'host', {seat: null});
  assert.equal((await f.request('start')).status, 409);
  await f.request('seat', 'observer', {seat: 1});
  assert.equal((await f.request('start')).status, 409, 'all participating players must be ready');
  await f.request('ready', 'observer', {ready: true});
  const response = await f.request('start'); assert.equal(response.status, 200);
  assert.equal(f.seen.setup.match.ownerId, 'host');
  assert.deepEqual(Array.from(f.seen.setup.players, p => p.id), ['observer', 'guest']);
  assert.equal(f.seen.viewer.role, 'spectator'); assert.equal(f.seen.viewer.isOwner, true); assert.equal(f.seen.viewer.seat, undefined);
  assert.equal((await f.request('seat', 'host', {seat: 1})).status, 409, 'roster is locked during play');
  assert.equal((await f.request('return-to-room')).status, 200);
  assert.equal(f.seen.returnActor.role, 'spectator'); assert.equal(f.stored.get('roomMeta').members.host.seat, undefined);
});

test('offline ownership may pass to an online spectator without assigning them a seat', async () => {
  const f = spectatorHostBackend();
  const meta = f.stored.get('roomMeta'); meta.ownerLastSeenAt = Date.now() - 60_000;
  f.room.socketLastSeenByPlayer = () => new Map([['observer', Date.now()]]);
  await f.room.transferOfflineHost();
  assert.equal(f.stored.get('roomMeta').ownerPlayerId, 'observer');
  assert.equal(f.stored.get('roomMeta').members.observer.seat, undefined);
});

test('lobby exposes spectating to seated hosts and management actions for spectator targets', () => {
  const b = browser(); let index = 0;
  const states = [true, {}, false, undefined];
  const jsx = (type, props) => ({type, props});
  const {default: Lobby} = b.moduleAt('apps/web/src/features/room/RoomLobby.tsx', {
    react: {useState: () => [states[index++], () => {}]},
    'react/jsx-runtime': {jsx, jsxs: jsx},
    'lucide-react': {Crown: 'Crown', Eye: 'Eye', MoreHorizontal: 'MoreHorizontal', Share2: 'Share2', UserRound: 'UserRound'},
    '@/app/i18n': {useI18n: () => ({locale: 'en', t: key => key})},
    '@/components/Menu': {__esModule: true, default: 'Menu'},
    './RoomIdCopy': {__esModule: true, default: 'RoomIdCopy'},
    './RoomSeats': {__esModule: true, default: 'RoomSeats'},
  });
  function find(node, predicate) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {for (const child of node) {const result = find(child, predicate); if (result) return result;} return;}
    if (predicate(node)) return node;
    return find(node.props?.children, predicate);
  }
  let target;
  const controls = {isOwner: true, selfId: 'host', selfPlayer: {id: 'host'}, phase: 'lobby', spectatorCount: 1,
    lobby: {ownerId: 'host', spectators: [{id: 'observer', name: 'Observer'}]},
    chooseSeat: seat => {target = seat;}, transferHost: id => {target = id;}, kick: id => {target = id;}};
  const tree = Lobby({roomId: 'room', controls});
  const menu = find(tree, node => node.type === 'Menu');
  const content = menu.props.children(after => after?.());
  const spectate = find(content, node => node.type === 'button' && find(node, child => child.type === 'span' && child.props.children === 'switchToSpectating'));
  assert.ok(spectate); spectate.props.onClick(); assert.equal(target, null);
  const transfer = find(content, node => node.type === 'button' && node.props.children === 'makeHost');
  transfer.props.onClick(); assert.equal(target, 'observer');
});

test('local mode is owner-only, works for any Lua game, and never executes cloud setup/actions', async () => {
  const f = spectatorHostBackend();
  assert.equal((await f.request('connection-mode','guest',{mode:'local-host'})).status,403);
  assert.equal((await f.request('connection-mode','host',{mode:'invalid'})).status,400);
  assert.equal((await f.request('connection-mode','host',{mode:'local-host'})).status,200);
  f.room.engine=async()=>{throw new Error('Cloud execution must not run');};
  assert.equal((await f.request('start','host',{})).status,400);
  assert.equal(f.stored.get('roomMeta').phase,'lobby');
  const response=await f.request('start','host',{hostInstanceId:'pinned'});
  assert.equal(response.status,200);const result=await response.json();
  assert.equal(result.snapshot,undefined);assert.equal(result.presence.localHost.instanceId,'pinned');
  assert.equal(f.stored.get('gameState').state,null);assert.deepEqual(f.stored.get('gameState').timers,[]);
  assert.equal((await f.request('connection-mode','host',{mode:'platform'})).status,409);
  assert.equal((await f.request('actions','guest',{requestId:'act',action:{}})).status,409);
  const boot=player=>f.room.fetch(new Request('https://room.example/local-runtime?instanceId=pinned',{headers:{'X-Playweft-Player-Id':player}}));
  assert.equal((await boot('guest')).status,403);
  const hostBoot=await boot('host');assert.equal(hostBoot.status,200);
  const value=await hostBoot.json();assert.equal(value.script,'same-source');assert.equal(value.context.match.id,result.presence.localHost.matchId);
  assert.equal(value.context.match.ownerId,'host');assert.ok(value.context.match.randomSeed);
  const wrongInstance=await f.room.fetch(new Request('https://room.example/local-runtime?instanceId=other',{headers:{'X-Playweft-Player-Id':'host'}}));
  assert.equal(wrongInstance.status,403);
  assert.equal((await f.request('leave','guest')).status,200);
  assert.equal((await f.request('return-to-room')).status,200);assert.equal(f.stored.get('roomMeta').localHost,undefined);
});

test('peer relay authenticates sender, pins the host browser and rejects cross-peer traffic and old matches',async()=>{
  const f=spectatorHostBackend();
  await f.request('connection-mode','host',{mode:'local-host'});
  const {presence}=await (await f.request('start','host',{hostInstanceId:'pinned'})).json();
  const out=[],attachments=new Map();
  const socket=(playerId,instanceId)=>{const socket={send:message=>out.push({playerId,instanceId,...JSON.parse(message)})};attachments.set(socket,{playerId,actorId:playerId,instanceId});return socket;};
  const host=socket('host','pinned'),otherTab=socket('host','other'),guest=socket('guest','guest'),observer=socket('observer','observer');
  f.room.sockets=()=>[host,otherTab,guest,observer];f.room.socketAttachment=socket=>attachments.get(socket);f.room.noteSocketSeen=async()=>{};
  const input={type:'peer',matchId:presence.localHost.matchId,targetId:'host',kind:'data',fromId:'forged',body:{type:'hello'}};
  await f.room.forwardPeer(guest,attachments.get(guest),input);
  assert.equal(out.length,1);assert.equal(out[0].fromId,'guest');assert.equal(out[0].instanceId,'pinned');
  await assert.rejects(f.room.forwardPeer(guest,attachments.get(guest),{...input,targetId:'observer'}),/designated/);
  await assert.rejects(f.room.forwardPeer(guest,attachments.get(guest),{...input,matchId:'old'}),/invalid peer/);
  await assert.rejects(f.room.forwardPeer(otherTab,attachments.get(otherTab),{...input,targetId:'guest'}),/instance has changed/);
  await f.room.forwardPeer(host,attachments.get(host),{...input,targetId:'guest'});assert.equal(out.at(-1).fromId,'host');
});


test('game bridge reports RTT to the authority, resets on route changes, and replays the current reading',async()=>{
  const f=fixture({}, {phase:'playing'});await f.join();
  const hook=bridgeHarness(f);hook.render();const bridge=hook.attachments[0];bridge.connect();
  const readings=()=>bridge.messages.filter(message=>message.method==='platform.latency').map(message=>JSON.parse(JSON.stringify(message.params)));
  f.session.patch({latency:88});assert.deepEqual(readings().at(-1),{rttMs:88,transport:'platform',status:'ready'});
  const localHost={id:'authority',instanceId:'instance',matchId:'match',startedAt:0,players:[]};
  f.session.patch({presence:{...f.session.getState().presence,localHost},peerTransport:'webrtc',peerLatency:12});
  assert.deepEqual(readings().at(-1),{rttMs:12,transport:'webrtc',status:'ready'});
  const before=readings().length;f.session.patch({latency:120});assert.equal(readings().length,before,'control socket latency does not replace game RTT');
  f.session.patch({peerTransport:'relay',peerLatency:undefined});assert.deepEqual(readings().at(-1),{transport:'relay',status:'measuring'});
  f.session.patch({peerLatency:180});assert.deepEqual(readings().at(-1),{rttMs:180,transport:'relay',status:'ready'});
  bridge.connect();assert.deepEqual(readings().at(-1),{rttMs:180,transport:'relay',status:'ready'});
  f.session.patch({connection:'reconnecting'});assert.deepEqual(readings().at(-1),{transport:'relay',status:'unavailable'});
  f.session.patch({selfId:'authority',peerTransport:'host',peerLatency:250});assert.deepEqual(readings().at(-1),{rttMs:0,transport:'local',status:'ready'});
  f.session.patch({peerTransport:'paused'});assert.deepEqual(readings().at(-1),{transport:'local',status:'unavailable'});
  hook.dispose();f.session.dispose();
});

test('runtime room configuration is host-only, persists separately from the game contract, and resets readiness', async () => {
  const f=spectatorHostBackend();
  assert.equal((await f.request('configuration','guest',{maxPlayers:4})).status,403);
  assert.equal((await f.request('configuration','host',{maxPlayers:1})).status,400);
  let response=await f.request('configuration','host',{minPlayers:3,maxPlayers:4,lobby:'platform'});
  assert.equal(response.status,200);let value=await response.json();
  assert.equal(value.minPlayers,3);assert.equal(value.maxPlayers,4);assert.equal(value.lobby,'platform');
  assert.equal(f.stored.get('roomMeta').config.maxPlayers,2,'initialization contract stays stable for later joins');
  assert.equal(f.stored.get('roomMeta').members.guest.ready,false);
  const revision=value.revision;
  response=await f.request('configuration','host',{minPlayers:3,maxPlayers:4,lobby:'platform'});
  assert.equal((await response.json()).revision,revision,'no-op changes do not invalidate readiness');
  for (const invalid of [{rules:{}},{maxPlayers:33},{minPlayers:0},{maxPlayers:2.5},{lobby:'other'}])
    assert.equal((await f.request('configuration','host',invalid)).status,400);
  assert.equal((await f.request('configuration','host',{minPlayers:1,maxPlayers:1})).status,409,'cannot remove an occupied seat');
  const meta=f.stored.get('roomMeta');meta.phase='playing';f.stored.set('roomMeta',meta);
  assert.equal((await f.request('configuration','host',{maxPlayers:4})).status,409);
});

test('room creation records initial player limits and lobby choice before initialization',async()=>{
  const f=spectatorHostBackend();f.stored.clear();
  const response=await f.room.fetch(new Request('https://room.example/create',{method:'POST',
    headers:{'X-Playweft-Player-Id':'host','X-Playweft-Room-Id':'NEW','Content-Type':'application/json'},
    body:JSON.stringify({manifestUrl:'https://game.example/playweft.json',configuration:{minPlayers:3,maxPlayers:3,lobby:'platform'}})}));
  assert.equal(response.status,200);assert.deepEqual(f.stored.get('roomMeta').configuration,{minPlayers:3,maxPlayers:3,lobby:'platform'});
});
function embeddedManagerFixture(overrides={}) {
  const loaded=loadedGame();loaded.game.version='1.0.0';loaded.manifest.room={server:{runtime:'lua',entry:'./game.lua',persistence:'durable'}};
  const f=fixture({loadGameManifest:async()=>loaded,...overrides});
  const manifestModule=f.moduleAt('apps/web/src/features/game/game-manifest.ts', {'@/app/i18n':{}, '@/app/app-load-policy':{}});
  const {GameRoomManager}=f.moduleAt('apps/web/src/features/game/GameRoomManager.ts', {'./game-manifest': manifestModule});
  const entered=[],created=[],removed=[];
  f.api.createRoom=async(url,configuration,initialization)=>{created.push({url,configuration,initialization});return {roomId:'NEW',manifestUrl:url};};
  f.api.dissolveRoom=async id=>{removed.push(id);return {dissolved:true};};
  const manager=new GameRoomManager(loaded,{waitForIdentity:async()=> 'Player',nickname:()=> 'Player',message:key=>key,onRoomChange:id=>entered.push(id)},f.api);
  return {...f,manager,loaded,entered,created,removed};
}
test('running game creates and owns a single room, can leave and recreate, and validates joins before membership changes',async()=>{
  const f=embeddedManagerFixture();const first=f.manager.create({minPlayers:3,maxPlayers:4,lobby:'platform'});
  assert.equal(first,f.manager.create());const result=await first;assert.equal(result.roomId,'NEW');
  assert.equal(f.counts.join,1);assert.equal(f.created.length,1);assert.equal(f.created[0].configuration.lobby,'platform');
  assert.equal((await f.manager.create()).roomId,'NEW');assert.equal(f.created.length,1);
  await assert.rejects(f.manager.join('OTHER'),error=>error.data.code==='ROOM_ALREADY_JOINED');
  await f.manager.session.leave();assert.equal(f.manager.session,undefined);assert.deepEqual(f.entered,['NEW',undefined]);
  f.api.loadGameManifest=async()=>loadedGame('other');
  await assert.rejects(f.manager.join('OTHER'),error=>error.data.code==='ROOM_GAME_MISMATCH');assert.equal(f.counts.join,1);
  f.api.loadGameManifest=async()=>f.loaded;
  await f.manager.create();assert.equal(f.created.length,2);assert.equal(f.counts.join,2);
  f.manager.dispose();f.session.dispose();
});
test('closing a game while room creation is in flight cleans up the late room instead of entering it',async()=>{
  const gate=deferred(),started=deferred(),f=embeddedManagerFixture();
  f.api.createRoom=async()=>{started.resolve();return gate.promise;};
  const pending=f.manager.create();await started.promise;f.manager.dispose();
  gate.resolve({roomId:'LATE',manifestUrl:f.loaded.game.manifestUrl});
  await assert.rejects(pending,error=>error.data.code==='BRIDGE_CLOSED');
  assert.deepEqual(f.removed,['LATE']);assert.equal(f.counts.join,0);assert.deepEqual(f.entered,[]);f.session.dispose();
});
test('custom room lobby bridge persists across start and return and emits filtered room state',async()=>{
  const loaded=loadedGame();loaded.manifest.room={server:{runtime:'lua',entry:'./game.lua',persistence:'durable'}};
  const f=fixture({loadGameManifest:async()=>loaded});const socket=await f.join();const hook=bridgeHarness(f);hook.render();
  const bridge=hook.attachments[0];assert.ok(bridge);bridge.connect();
  const context=await bridge.options.handlers['game.initialize'].handle();assert.equal(context.phase,'lobby');
  assert.equal(context.room.players[0].name,undefined);assert.equal(context.room.players[0].avatarUrl,undefined);
  const revision=f.session.getState().gameRevision;
  socket.message(presence(3,'playing'));hook.render();socket.message(presence(4));hook.render();
  assert.equal(f.session.getState().gameRevision,revision);assert.equal(bridge.detached,0);assert.equal(hook.attachments.length,1);
  assert.equal(bridge.messages.filter(message=>message.method==='room.stateChanged').length,2);
  hook.dispose();f.session.dispose();
});

test('games with no Manifest server create with a runtime descriptor, and later joins use the saved contract',async()=>{
  const f=embeddedManagerFixture();const {room:oldRoom}=f.loaded;delete f.loaded.room;delete f.loaded.manifest.room;
  const initialization={...oldRoom,serverUrl:'https://game.example/chosen.lua',liveRoom:true};
  f.api.getRoomLaunch=async()=>({manifestUrl:f.loaded.game.manifestUrl,initialization});
  await f.manager.create({minPlayers:2,maxPlayers:4,server:{runtime:'lua',entry:'./chosen.lua',persistence:'live'}});
  assert.equal(f.created[0].initialization.serverUrl,initialization.serverUrl);
  assert.equal(f.created[0].initialization.liveRoom,true);assert.equal(f.created[0].configuration.server,undefined);
  assert.equal(f.manager.session.getState().loadedGame.room.serverUrl,initialization.serverUrl);
  await f.manager.session.leave();
  await f.manager.join('EXISTING');assert.equal(f.created.length,1);assert.equal(f.counts.join,2);
  f.manager.dispose();f.session.dispose();
});
test('missing or invalid creation servers cannot create a room or change an existing room server',async()=>{
  const f=embeddedManagerFixture();delete f.loaded.room;
  await assert.rejects(f.manager.create(),e=>e.data.code==='ROOM_SERVER_REQUIRED');assert.equal(f.created.length,0);
  await assert.rejects(f.manager.create({server:{runtime:'lua',entry:'https://foreign.example/game.lua',persistence:'durable'}}));
  assert.equal(f.created.length,0);f.manager.dispose();f.session.dispose();
});
function atomicRuntimeRoom() {
  const b=browser(),stored=new Map();let fetches=0,compiles=0,disposals=0,script='function setup() return {} end';
  Object.assign(b.globals,{setTimeout,clearTimeout,TextDecoder,crypto:webcrypto,
    fetch:async()=>{fetches++;return new Response(script,{headers:{'Content-Type':'text/plain'}});}});
  const {GameRoom}=b.moduleAt('apps/worker/src/room.ts',{
    'cloudflare:workers':{DurableObject:class {constructor(ctx){this.ctx=ctx;}}},
    './runtime-registry':{isRuntimeKind:value=>value==='lua',createRuntime:async(_runtime,source)=>{
      compiles++;if(source==='invalid')throw Error('invalid Lua');return {dispose(){disposals++;}};
    }},
  });
  const room=new GameRoom({getWebSockets:()=>[],storage:{
    get:async key=>structuredClone(stored.get(key)),put:async(key,value)=>stored.set(key,structuredClone(value)),
    delete:async key=>stored.delete(key),
  }},{});
  room.touch=async()=>{};room.scheduleAlarm=async()=>{};
  const initialization={gameId:'https://game.example/demo/',gameVersion:'1.0.0',serverUrl:'https://game.example/demo/game.lua',runtime:'lua',minPlayers:1,maxPlayers:32,liveRoom:false};
  const request=(path,body,method='POST')=>room.fetch(new Request('https://room.example/'+path,{method,
    headers:{'X-Playweft-Player-Id':'host','X-Playweft-Room-Id':'NEW','Content-Type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)})}));
  return {room,stored,initialization,request,script:value=>{script=value;},counts:()=>({fetches,compiles,disposals})};
}
test('creation compiles and locks the runtime; joining and re-initializing never fetch a changed source',async()=>{
  const f=atomicRuntimeRoom(),response=await f.request('create',{manifestUrl:'https://game.example/demo/playweft.json',
    initialization:f.initialization,configuration:{minPlayers:2,maxPlayers:4,lobby:'platform'}});
  assert.equal(response.status,200,await response.clone().text());
  assert.equal(f.stored.get('roomMeta').config.script,'function setup() return {} end');
  assert.equal(f.stored.get('roomMeta').config.scriptHash.length,64);
  const launch=await (await f.request('launch',undefined,'GET')).json();
  assert.deepEqual(launch.initialization,f.initialization);assert.equal(launch.initialization.script,undefined);
  f.script('changed');assert.equal((await f.request('initialize',launch.initialization,'PUT')).status,200);
  assert.equal((await f.request('join')).status,200);
  assert.equal((await f.request('initialize',{...launch.initialization,serverUrl:'https://game.example/another.lua'},'PUT')).status,409);
  assert.equal((await f.request('configuration',{server:{entry:'another.lua'}})).status,400);
  assert.deepEqual(f.counts(),{fetches:1,compiles:1,disposals:1});
});
test('bad server URLs, failed source fetches and invalid Lua leave no room metadata',async()=>{
  for(const kind of ['origin','script','empty']) {
    const f=atomicRuntimeRoom();let initialization=f.initialization;
    if(kind==='origin')initialization={...initialization,serverUrl:'https://foreign.example/script.lua'};
    if(kind==='script')f.script('invalid');if(kind==='empty')f.script('');
    const response=await f.request('create',{manifestUrl:'https://game.example/demo/playweft.json',initialization});
    assert.equal(response.ok,false);assert.equal(f.stored.has('roomMeta'),false);
    assert.equal((await f.request('launch',undefined,'GET')).status,404);
  }
});

test('lobby arrivals take a free seat or spectate when all seats are occupied', async () => {
  for (const full of [false, true]) {
    const f = spectatorHostBackend();
    if (!full) delete f.stored.get('roomMeta').members.guest;
    const response = await f.request('join', 'newcomer');
    assert.equal(response.status, 200);
    const joined = await response.json();
    assert.equal(joined.phase, 'lobby');
    assert.equal(joined.players.some(p => p.id === joined.selfId), !full);
    assert.equal(joined.spectators.some(p => p.id === joined.selfId), full);
    if (!full) assert.equal(joined.players.find(p => p.id === joined.selfId).seat, 2);
  }
});

test('arrivals during play spectate even with an empty seat and receive a spectator projection', async () => {
  const f = spectatorHostBackend();
  assert.equal((await f.request('start')).status, 200);
  const meta = f.stored.get('roomMeta');
  delete meta.members.guest;
  const response = await f.request('join', 'newcomer');
  assert.equal(response.status, 200);
  const joined = await response.json();
  assert.equal(joined.phase, 'playing');
  assert.ok(joined.spectators.some(p => p.id === joined.selfId));
  assert.equal(joined.players.length, 1);
  assert.equal(f.stored.get('roomMeta').members.newcomer.seat, undefined);
  assert.equal((await f.request('seat', 'newcomer', {seat: 2})).status, 409);
  const engine = await f.room.engine();
  engine.view = (_state, _events, context) => {
    f.seen.viewer = context.viewer;
    return {state: {watching: context.viewer.role === 'spectator'}, events: []};
  };
  f.room.engine = async () => engine;
  const state = await f.room.fetch(new Request('https://room.example/state', {
    headers: {'X-Playweft-Player-Id': 'newcomer'},
  }));
  assert.equal(state.status, 200);
  assert.deepEqual((await state.json()).state, {watching: true});
  assert.equal(f.seen.viewer.id, joined.selfId);
  assert.equal(f.seen.viewer.role, 'spectator');
  assert.equal(f.seen.viewer.isOwner, false);
  assert.equal(f.seen.viewer.seat, undefined);
});

test('existing players and spectators retain identity and seat when rejoining during play', async () => {
  const f = spectatorHostBackend();
  assert.equal((await f.request('start')).status, 200);
  for (const id of ['host', 'guest', 'observer']) {
    const before = structuredClone(f.stored.get('roomMeta').members[id]);
    const response = await f.request('join', id);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).selfId, before.actorId);
    assert.deepEqual(f.stored.get('roomMeta').members[id], before);
  }
});
