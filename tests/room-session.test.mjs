import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

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
  test(`${action}: network, permission and player-not-found errors retain the room`, async () => {
    const f = fixture();
    await f.join();
    for (const error of [
      new Error("offline"),
      new f.PlatformApiError("forbidden", 403),
      new f.PlatformApiError("player is not in this room", 404),
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

test("server dissolution or close code uses the same end path", async () => {
  for (const signal of ["message", "close"]) {
    const f = fixture();
    const socket = await f.join();
    if (signal === "message")
      socket.message({ type: "room_dissolved", error: "ended" });
    else socket.close(4004);
    assert.equal(f.session.getState().lifecycle, "ended");
    assert.equal(f.counts.ended, 1);
    assert.equal(f.timers.size, 0);
    assert.equal(f.listeners.size, 0);
    f.resume();
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
    presence(4, "lobby", { players: [], spectators: [{ id: "self" }] }),
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
