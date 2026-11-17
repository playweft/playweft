import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import {
  createRoomClient,
  createRoomsClient,
} from "../apps/web/public/sdk/room.js";
const root = new URL("../", import.meta.url).pathname;
const json = (value) => JSON.parse(JSON.stringify(value));
function modules(extra = {}, readAppLoadPolicy = () => "cache-disabled") {
  const cache = new Map();
  function load(path) {
    path = resolve(root, path);
    if (cache.has(path)) return cache.get(path);
    const module = { exports: {} };
    cache.set(path, module.exports);
    const { outputText } = ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    });
    vm.runInNewContext(outputText, {
      exports: module.exports,
      module,
      URL,
      Error,
      TypeError,
      Response,
      Headers,
      TextEncoder,
      AbortController,
      DOMException,
      window: {
        location: new URL("https://platform.example/"),
        setTimeout,
        clearTimeout,
      },
      ...extra,
      require(name) {
        if (name === "@/platform/platform-api") return {};
        if (name === "@/app/i18n") return { isGameTranslations: () => true };
        if (name === "@/app/app-load-policy") return { readAppLoadPolicy };
        if (name === "@playweft/game-protocol")
          return load("packages/game-protocol/src/index.ts");
        if (name.startsWith("@/"))
          return load(`apps/web/src/${name.slice(2)}.ts`);
        if (name.startsWith("."))
          return load(resolve(dirname(path), name + ".ts"));
        throw Error("Unexpected import " + name);
      },
    });
    return module.exports;
  }
  return load;
}
const manifest = {
  manifest_version: 1,
  id: "./",
  version: "1.0.0",
  protocol: { min: 1, max: 1 },
  start_url: "./",
  name: "Mode test",
  modes: {
    solo: {},
    room: {
      players: { min: 1, max: 2 },
      server: { runtime: "lua", entry: "./game.lua", persistence: "durable" },
    },
  },
};
test("Manifest accepts auto/solo/choose preferences and requires solo capability for solo preference", () => {
  const { parseGameManifest } = modules()(
    "packages/game-protocol/src/index.ts",
  );
  assert.equal(parseGameManifest(manifest).launch_mode, undefined);
  for (const value of ["auto", "solo", "choose"])
    assert.equal(
      parseGameManifest({ ...manifest, launch_mode: value }).launch_mode,
      value,
    );
  for (const value of ["room", "both", "solo-first", null, {}, true])
    assert.throws(
      () => parseGameManifest({ ...manifest, launch_mode: value }),
      /launch_mode/,
    );
  assert.throws(
    () =>
      parseGameManifest({
        ...manifest,
        modes: { room: manifest.modes.room },
        launch_mode: "solo",
      }),
    /requires modes.solo/,
  );
});
test("Manifest preference propagates to discovered and persisted library metadata", async () => {
  const load = modules({
    fetch: async () =>
      new Response(JSON.stringify({ ...manifest, launch_mode: "solo" }), {
        headers: { "Content-Type": "application/json" },
      }),
  });
  const { loadGameManifest, isStoredDiscoveredGame } = load(
    "apps/web/src/features/game/game-manifest.ts",
  );
  const loaded = await loadGameManifest(
    "https://game.example/demo/playweft.json",
  );
  assert.equal(loaded.game.launchMode, "solo");
  assert.equal(isStoredDiscoveredGame(loaded.game), true);
  const legacy = { ...loaded.game };
  delete legacy.launchMode;
  assert.equal(isStoredDiscoveredGame(legacy), true);
  assert.equal(
    isStoredDiscoveredGame({ ...loaded.game, launchMode: "auto" }),
    true,
  );
  assert.equal(
    isStoredDiscoveredGame({ ...loaded.game, modes: ["room"] }),
    false,
  );
});
test("disabled application caching still revalidates manifests and loads a changed version", async () => {
  const requests = [];
  let current = manifest;
  const load = modules({
    caches: {
      open: () =>
        assert.fail(
          "disabled application caching must not read or write offline manifests",
        ),
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return Response.json(current);
    },
  });
  const { loadGameManifest } = load(
    "apps/web/src/features/game/game-manifest.ts",
  );
  const url = "https://game.example/demo/playweft.json";
  assert.equal((await loadGameManifest(url)).game.version, "1.0.0");
  current = { ...manifest, version: "1.1.0", start_url: "./updated.html" };
  const updated = await loadGameManifest(url);
  assert.equal(updated.game.version, "1.1.0");
  assert.equal(updated.game.url, "https://game.example/demo/updated.html");
  assert.equal(requests.length, 2, "each opening must check the network");
  assert.ok(
    requests.every(
      (request) => request.url === url && request.options.cache === "no-cache",
    ),
  );
});
test("disabled application caching never falls back to a saved manifest on network failure", async () => {
  const load = modules({
    caches: {
      open: () =>
        assert.fail(
          "disabled application caching must not fall back to an old manifest",
        ),
    },
    fetch: async () => {
      throw new TypeError("offline");
    },
  });
  const { loadGameManifest } = load(
    "apps/web/src/features/game/game-manifest.ts",
  );
  await assert.rejects(
    loadGameManifest("https://game.example/demo/playweft.json"),
    (error) =>
      error.name === "ManifestNetworkError" &&
      error.cause?.message === "offline",
  );
});
const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => (resolve = yes));
  return { promise, resolve };
};
test("platform lobby creation from the game list uses the Manifest room mode", async () => {
  const { createGameRoom } = modules()("apps/web/src/features/game/room-creation.ts");
  const game = {
    manifestUrl: "https://game.example/demo/playweft.json",
    modes: ["solo", "room"],
  };
  const room = { roomId: "ROOM", manifestUrl: game.manifestUrl };
  const calls = [];
  const api = {
    createGuestSession: async (name) => calls.push(["guest", name]),
    createRoom: async (url) => {
      calls.push(["room", url]);
      return room;
    },
  };
  const waitForIdentity = async () => "Player";
  await assert.rejects(
    createGameRoom({ ...game, modes: ["solo"] }, waitForIdentity, () => false, api),
    (error) => error.data.code === "ROOM_MODE_UNAVAILABLE",
  );
  await assert.rejects(
    createGameRoom(game, waitForIdentity, () => true, api),
    (error) => error.data.code === "ROOM_CREATION_CANCELLED",
  );
  assert.deepEqual(calls, []);

  assert.equal(await createGameRoom(game, waitForIdentity, () => false, api), room);
  assert.deepEqual(calls, [["guest", "Player"], ["room", game.manifestUrl]]);
});
test("RPC replies to requests and ignores notifications for request-only methods", async () => {
  const load = modules(),
    { dispatchRpcMessage } = load("apps/web/src/platform/json-rpc.ts"),
    replies = [];
  let calls = 0;
  const port = { postMessage: (message) => replies.push(message) };
  const handlers = {
    "test.createRoom": {
      handle() {
        calls++;
        return { roomId: "ROOM" };
      },
    },
  };
  await dispatchRpcMessage(
    port,
    { jsonrpc: "2.0", id: "create", method: "test.createRoom" },
    handlers,
  );
  assert.deepEqual(json(replies), [
    { jsonrpc: "2.0", id: "create", result: { roomId: "ROOM" } },
  ]);
  replies.length = 0;
  await dispatchRpcMessage(
    port,
    { jsonrpc: "2.0", method: "test.createRoom" },
    handlers,
  );
  assert.deepEqual(replies, []);
  assert.equal(calls, 1);
  handlers["test.createRoom"].handle = () => {
    throw Error("offline");
  };
  await dispatchRpcMessage(
    port,
    { jsonrpc: "2.0", id: "fail", method: "test.createRoom" },
    handlers,
  );
  assert.equal(replies.length, 1);
  assert.equal(replies[0].error.message, "offline");
});
class Port extends EventTarget {
  messages = [];
  start() {}
  postMessage(value) {
    this.messages.push(value);
  }
  reply(data) {
    this.dispatchEvent(
      new MessageEvent("message", { data: { jsonrpc: "2.0", ...data } }),
    );
  }
}
test("room SDK exposes errors and rejects pending requests on bridge replacement", async () => {
  const port = new Port();
  const room = createRoomClient(port);
  const start = room.start();
  assert.equal(port.messages[0].method, "room.start");
  assert.equal(port.messages[0].params, undefined);
  port.reply({
    id: port.messages[0].id,
    error: {
      code: -32000,
      message: "Players are not ready",
      data: { code: "ROOM_NOT_READY", retryable: false },
    },
  });
  await assert.rejects(
    start,
    (error) => error.code === "ROOM_NOT_READY" && !error.retryable,
  );
  const ready = room.setReady(true);
  const state = { roomId: "ROOM", revision: 1 };
  port.reply({ id: port.messages[1].id, result: state });
  assert.deepEqual(await ready, state);
  const pending = room.getState();
  room.destroy();
  await assert.rejects(pending, (error) => error.code === "BRIDGE_CLOSED");
  await assert.rejects(room.getState(), (error) => error.code === "BRIDGE_CLOSED");
});

test("minimal manifests open directly and declare a room server without modes or player limits", async () => {
  const value = { ...manifest, room: { server: manifest.modes.room.server } };
  delete value.modes;
  const load = modules({ fetch: async () => Response.json(value) });
  const { parseGameManifest } = load("packages/game-protocol/src/index.ts");
  const parsed = parseGameManifest(value);
  assert.deepEqual(json(parsed.modes), { solo: {} });
  const loaded = await load(
    "apps/web/src/features/game/game-manifest.ts",
  ).loadGameManifest("https://game.example/demo/playweft.json");
  assert.equal(loaded.game.embeddedLobby, true);
  assert.deepEqual(json(loaded.game.modes), ["solo", "room"]);
  assert.equal(loaded.room.minPlayers, 1);
  assert.equal(loaded.room.maxPlayers, 32);
  assert.throws(
    () => parseGameManifest({ ...value, modes: manifest.modes }),
    /not both/,
  );
  delete value.room;
  assert.deepEqual(json(parseGameManifest(value).modes), { solo: {} });
});
const roomState = (revision = 1, changes = {}) => ({
  roomId: "ROOM",
  revision,
  phase: "lobby",
  ownerId: "self",
  selfId: "self",
  players: [{ id: "self", seat: 1, ready: false }],
  spectators: [],
  minPlayers: 1,
  maxPlayers: 4,
  lobby: "game",
  inviteUrl: "https://platform.example/r/ROOM",
  permissions: {
    setConfiguration: true,
    setReady: false,
    setSeat: true,
    start: true,
    leave: true,
  },
  ...changes,
});
test("rooms SDK returns one EventTarget handle, confirmed immutable state, and rejects joining another room", async () => {
  const port = new Port(),
    rooms = createRoomsClient(port),
    first = rooms.create({ minPlayers: 3, maxPlayers: 4, lobby: "platform" });
  assert.equal(first, rooms.create());
  assert.equal(port.messages.length, 1);
  assert.equal(port.messages[0].method, "rooms.create");
  assert.deepEqual(port.messages[0].params, {
    minPlayers: 3,
    maxPlayers: 4,
    lobby: "platform",
  });
  port.reply({ id: port.messages[0].id, result: roomState() });
  const room = await first;
  assert.ok(room instanceof EventTarget);
  assert.equal(rooms.current, room);
  assert.equal(room.id, "ROOM");
  assert.equal(await rooms.create(), room);
  assert.equal(await rooms.join("ROOM"), room);
  await assert.rejects(
    rooms.join("OTHER"),
    (error) => error.code === "ROOM_ALREADY_JOINED",
  );
  assert.equal(port.messages.length, 1);
  let changes = 0;
  room.addEventListener("statechange", () => changes++);
  const configured = room.setConfiguration({ maxPlayers: 3 });
  assert.equal(room.getConfiguration().maxPlayers, 4);
  port.reply({
    id: port.messages.at(-1).id,
    result: roomState(2, { maxPlayers: 3 }),
  });
  await configured;
  assert.equal(room.getConfiguration().maxPlayers, 3);
  assert.equal(changes, 1);
  assert.throws(() => {
    room.state.players[0].seat = 9;
  }, TypeError);
  port.reply({ method: "room.stateChanged", params: roomState(1) });
  assert.equal(changes, 1);
  port.reply({
    method: "room.stateChanged",
    params: roomState(3, { maxPlayers: 3, phase: "playing" }),
  });
  assert.equal(changes, 2);
  let closes = 0;
  room.addEventListener("close", () => closes++);
  const leave = room.leave(),
    request = port.messages.at(-1);
  port.reply({ method: "room.closed", params: { reason: "left" } });
  port.reply({ id: request.id, result: null });
  await leave;
  assert.equal(room.closed, true);
  assert.equal(closes, 1);
  assert.equal(rooms.current, null);
  await assert.rejects(room.start(), (error) => error.code === "ROOM_CLOSED");
  const next = rooms.create();
  port.reply({ id: port.messages.at(-1).id, result: roomState() });
  assert.notEqual(await next, room);
  rooms.destroy();
  assert.equal(rooms.current, null);
});
test("rooms SDK serializes different openings, retries failures and rejects pending work on bridge teardown", async () => {
  const port = new Port(),
    rooms = createRoomsClient(port),
    join = rooms.join("ROOM");
  assert.equal(join, rooms.join("ROOM"));
  await assert.rejects(
    rooms.create(),
    (e) => e.code === "ROOM_OPERATION_PENDING",
  );
  port.reply({
    id: port.messages[0].id,
    error: {
      code: -32000,
      message: "missing",
      data: { code: "ROOM_NOT_FOUND" },
    },
  });
  await assert.rejects(join, (e) => e.code === "ROOM_NOT_FOUND");
  const pending = rooms.create();
  rooms.destroy();
  await assert.rejects(pending, (e) => e.code === "BRIDGE_CLOSED");
});

test("games without a room declaration expose the embedded host and resolve creation servers against the Manifest", async () => {
  const value = { ...manifest };
  delete value.modes;
  const load = modules({
    fetch: async () =>
      Response.json({ ...value, start_url: "/client/index.html" }),
  });
  const { loadGameManifest, roomInitializationForServer } = load(
    "apps/web/src/features/game/game-manifest.ts",
  );
  const loaded = await loadGameManifest(
    "https://game.example/packages/demo/playweft.json",
  );
  assert.equal(loaded.room, undefined);
  assert.equal(loaded.game.embeddedLobby, true);
  const server = { runtime: "lua", entry: "./online.lua", persistence: "live" };
  const initialization = roomInitializationForServer(loaded.game, server);
  assert.equal(
    initialization.serverUrl,
    "https://game.example/packages/demo/online.lua",
  );
  assert.equal(initialization.liveRoom, true);
  assert.equal(initialization.gameVersion, loaded.game.version);
  for (const entry of [
    "https://foreign.example/game.lua",
    "https://user:pass@game.example/game.lua",
    "javascript:alert(1)",
  ])
    assert.throws(() =>
      roomInitializationForServer(loaded.game, { ...server, entry }),
    );
  for (const invalid of [
    { ...server, rules: {} },
    { ...server, runtime: "js" },
    { ...server, persistence: "other" },
    { ...server, entry: "" },
  ])
    assert.throws(() => roomInitializationForServer(loaded.game, invalid));
  const { roomCreateOptionsFromRpcParams, roomConfigurationFromRpcParams } =
    load("apps/web/src/features/room/room-lobby-bridge.ts");
  assert.deepEqual(
    json(roomCreateOptionsFromRpcParams({ server, maxPlayers: 4 })),
    { server, maxPlayers: 4 },
  );
  assert.throws(
    () => roomConfigurationFromRpcParams({ server }),
    (error) => error.rpcCode === -32602,
  );
});

function manifestCacheFixture({
  policy = "update-prompt",
  cached = manifest,
  fetch: fetchResponse,
} = {}) {
  const url = "https://game.example/demo/playweft.json",
    stored = new Map(),
    requests = [],
    writes = [];
  if (cached !== null)
    stored.set(
      url,
      new Response(
        typeof cached === "string" ? cached : JSON.stringify(cached),
      ),
    );
  let currentPolicy = policy;
  const written = deferred();
  const cache = {
    async match(key) {
      return stored.get(key)?.clone();
    },
    async put(key, response) {
      stored.set(key, response.clone());
      writes.push(key);
      written.resolve();
    },
    async delete(key) {
      return stored.delete(key);
    },
    async keys() {
      return [...stored.keys()];
    },
  };
  const load = modules(
    {
      caches: { open: async () => cache },
      fetch: async (...args) => {
        requests.push(args);
        return fetchResponse(...args);
      },
    },
    () => currentPolicy,
  )("apps/web/src/features/game/game-manifest.ts").loadGameManifest;
  return {
    load: () => load(url),
    url,
    stored,
    requests,
    writes,
    written: written.promise,
    policy: (value) => {
      currentPolicy = value;
    },
    async saved() {
      return JSON.parse(await stored.get(url).clone().text());
    },
  };
}
test("prompt updates returns the cached game before the network and only uses the refreshed version on a later load", async () => {
  const network = deferred(),
    latest = { ...manifest, version: "1.1.0", start_url: "./updated.html" };
  const f = manifestCacheFixture({ fetch: () => network.promise });
  const current = await f.load();
  assert.equal(current.game.version, "1.0.0");
  assert.equal(f.requests.length, 1);
  assert.equal(f.writes.length, 0);
  assert.equal(f.requests[0][1].cache, "no-cache");
  assert.equal((await f.load()).game.version, "1.0.0");
  assert.equal(f.requests.length, 1, "in-flight background checks are shared");
  network.resolve(Response.json(latest));
  await f.written;
  assert.equal((await f.saved()).version, "1.1.0");
  assert.equal(current.game.version, "1.0.0");
  assert.equal(current.game.url, "https://game.example/demo/");
  assert.equal(
    (await f.load()).game.url,
    "https://game.example/demo/updated.html",
  );
});
test("prompt updates retains the cached manifest when background checks fail or return invalid content", async () => {
  for (const outcome of [
    "offline",
    "http",
    "invalid-json",
    "invalid-manifest",
  ]) {
    const f = manifestCacheFixture({
      fetch: async () => {
        if (outcome === "offline") throw new TypeError("offline");
        if (outcome === "http") return new Response("missing", { status: 404 });
        if (outcome === "invalid-json") return new Response("{");
        return Response.json({ ...manifest, version: "broken" });
      },
    });
    assert.equal((await f.load()).game.version, "1.0.0");
    // Let failed background fetches and validation settle without wall-clock sleeps.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal((await f.saved()).version, "1.0.0");
    assert.equal(f.writes.length, 0);
  }
});
test("prompt updates waits for the network without a usable cache and repairs corrupt cache entries", async () => {
  for (const cached of [
    null,
    "{",
    JSON.stringify({ ...manifest, version: "broken" }),
  ]) {
    const network = deferred(),
      f = manifestCacheFixture({ cached, fetch: () => network.promise });
    let complete = false;
    const pending = f.load().then((value) => {
      complete = true;
      return value;
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(complete, false);
    network.resolve(Response.json(manifest));
    assert.equal((await pending).game.version, "1.0.0");
    assert.equal((await f.saved()).version, "1.0.0");
    assert.equal(f.writes.length, 1);
  }
});
test("switching away from prompt updates prevents a pending background refresh from saving its result", async () => {
  const network = deferred(),
    f = manifestCacheFixture({ fetch: () => network.promise });
  assert.equal((await f.load()).game.version, "1.0.0");
  f.policy("cache-disabled");
  network.resolve(Response.json({ ...manifest, version: "1.1.0" }));
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(f.writes.length, 0);
  assert.equal((await f.saved()).version, "1.0.0");
});
test("network-first still waits for fresh content, falls back only on network failure, and local-only never fetches", async () => {
  const network = deferred(),
    f = manifestCacheFixture({
      policy: "network-first",
      fetch: () => network.promise,
    });
  let complete = false;
  const pending = f.load().then((value) => {
    complete = true;
    return value;
  });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(complete, false);
  network.resolve(Response.json({ ...manifest, version: "1.1.0" }));
  assert.equal((await pending).game.version, "1.1.0");
  const offline = manifestCacheFixture({
    policy: "network-first",
    fetch: async () => {
      throw new TypeError("offline");
    },
  });
  assert.equal((await offline.load()).game.version, "1.0.0");
  assert.equal(offline.requests.length, 1);
  const missing = manifestCacheFixture({
    policy: "network-first",
    fetch: async () => new Response("missing", { status: 404 }),
  });
  await assert.rejects(missing.load(), /404/);
  const local = manifestCacheFixture({
    policy: "local-only",
    fetch: () => assert.fail("local-only must not fetch"),
  });
  assert.equal((await local.load()).game.version, "1.0.0");
  assert.equal(local.requests.length, 0);
  assert.equal(local.writes.length, 0);
});
