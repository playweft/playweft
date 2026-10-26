import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { MessageChannel } from "node:worker_threads";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import ts from "typescript";
import { createLocalStorageClient } from "../apps/web/public/sdk/local-storage.js";

async function load(path, imports) {
  const { outputText } = ts.transpileModule(
    await readFile(new URL(path, import.meta.url), "utf8"),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  );
  const module = { exports: {} };
  vm.runInNewContext(outputText, {
    module,
    exports: module.exports,
    Error,
    DOMException,
    URL,
    IDBKeyRange,
    require: (name) => imports[name],
    globalThis: {},
  });
  return module.exports;
}
const protocol = {
  JSON_RPC_VERSION: "2.0",
  PLAYWEFT_BRIDGE_VERSION: 1,
  JsonRpcErrorCode: {
    InvalidRequest: -32600,
    InvalidParams: -32602,
    InternalError: -32603,
    PlatformError: -32000,
  },
  isJson: () => true,
};
const rpc = await load("../apps/web/src/platform/json-rpc.ts", {
  "@playweft/game-protocol": protocol,
});
const {
  createGameStorageDatabase,
  createLocalStorageHandlers,
  LOCAL_STORAGE_CAPABILITIES,
} = await load("../apps/web/src/features/game/local-storage.ts", {
  "@playweft/game-protocol": protocol,
  "@/platform/json-rpc": rpc,
});
const A = "https://game.example",
  B = "https://other.example";
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test("origin partitions survive connections and support empty strings, overwrite, enumeration, remove and clear", async () => {
  const factory = new IDBFactory();
  let db = createGameStorageDatabase({ factory });
  await db.setItem(A, "", "");
  await db.setItem(A, "save", "旧存档");
  await db.setItem(A, "save", "新存档🐶");
  await db.setItem(A, "__proto__", "plain key");
  await db.setItem(B, "save", "other game");
  assert.equal(await db.length(A), 3);
  assert.equal(await db.getItem(A, ""), "");
  assert.equal(await db.getItem(A, "missing"), null);
  assert.equal(await db.key(A, 0), "");
  assert.equal(await db.key(A, 1), "__proto__");
  assert.equal(await db.key(A, 2), "save");
  assert.equal(await db.key(A, 3), null);
  await db.close();
  db = createGameStorageDatabase({ factory });
  assert.equal(await db.getItem(A, "save"), "新存档🐶");
  assert.equal(await db.getItem(B, "save"), "other game");
  await db.removeItem(A, "missing");
  await db.removeItem(A, "__proto__");
  assert.equal(await db.length(A), 2);
  await db.clear(A);
  assert.equal(await db.length(A), 0);
  assert.equal(await db.getItem(B, "save"), "other game");
  await db.close();
});

test("quota failures preserve entries and accounting, including overwrites and concurrent connections", async () => {
  const factory = new IDBFactory();
  const db = createGameStorageDatabase({ factory, maxOriginBytes: 20 });
  await db.setItem(A, "a", "1234"); // ten logical bytes
  await assert.rejects(db.setItem(A, "b", "1234567890"), {
    name: "QuotaExceededError",
  });
  await assert.rejects(db.setItem(A, "a", "1234567890"), {
    name: "QuotaExceededError",
  });
  assert.equal(await db.getItem(A, "a"), "1234");
  assert.equal(await db.getItem(A, "b"), null);
  assert.equal(await db.length(A), 1);
  await db.setItem(A, "a", "1");
  await db.setItem(A, "b", "1234567");
  assert.equal(await db.length(A), 2);
  await db.clear(A);
  const second = createGameStorageDatabase({ factory, maxOriginBytes: 20 });
  await Promise.all([db.setItem(A, "a", "1"), second.setItem(A, "b", "2")]);
  assert.equal(await db.length(A), 2);
  const connection = await new Promise((resolve, reject) => {
    const r = factory.open("playweft-game-storage");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const meta = await new Promise((resolve) => {
    const r = connection.transaction("origins").objectStore("origins").get(A);
    r.onsuccess = () => resolve(r.result);
  });
  assert.equal(meta.usageBytes, 8);
  assert.equal(meta.entryCount, 2);
  connection.close();
  await db.close();
  await second.close();
});

test("RPC derives the namespace from the bridge and rejects forged origins and malformed arguments", async () => {
  const db = createGameStorageDatabase({ factory: new IDBFactory() });
  const handlers = createLocalStorageHandlers(A, db);
  for (const params of [
    { origin: B, key: "x" },
    { key: 1 },
    { key: "x", value: "y" },
  ])
    assert.throws(
      () => handlers["localStorage.getItem"].handle(params),
      (error) => error.rpcCode === -32602,
    );
  assert.throws(
    () => handlers["localStorage.clear"].handle({ origin: B }),
    (error) => error.rpcCode === -32602,
  );
  assert.throws(
    () => handlers["localStorage.key"].handle({ index: -1 }),
    (error) => error.rpcCode === -32602,
  );
  assert.throws(() =>
    createLocalStorageHandlers("https://game.example/path", db),
  );
  const results = [];
  const port = { postMessage: (value) => results.push(value) };
  await rpc.dispatchRpcMessage(
    port,
    {
      jsonrpc: "2.0",
      id: "write",
      method: "localStorage.setItem",
      params: { key: "save", value: "29" },
    },
    handlers,
  );
  assert.equal(results[0].result, null);
  assert.equal(await db.getItem(A, "save"), "29");
  assert.equal(await db.getItem(B, "save"), null);
  await db.close();
});

test("RPC acknowledgement waits for commit; ordered reads and retries cannot overtake a pending write", async () => {
  const gate = deferred(),
    calls = [];
  const handlers = createLocalStorageHandlers(A, {
    async setItem() {
      calls.push("write");
      await gate.promise;
    },
    async getItem() {
      calls.push("read");
      return "committed";
    },
  });
  const replies = [],
    port = { postMessage: (value) => replies.push(value) };
  const write = rpc.dispatchRpcMessage(
    port,
    {
      jsonrpc: "2.0",
      id: "w",
      method: "localStorage.setItem",
      params: { key: "k", value: "v" },
    },
    handlers,
  );
  const read = rpc.dispatchRpcMessage(
    port,
    {
      jsonrpc: "2.0",
      id: "r",
      method: "localStorage.getItem",
      params: { key: "k" },
    },
    handlers,
  );
  await Promise.resolve();
  assert.deepEqual(calls, ["write"]);
  assert.equal(replies.length, 0);
  gate.reject(new DOMException("Full", "QuotaExceededError"));
  await Promise.all([write, read]);
  assert.equal(replies[0].error.data.code, "STORAGE_QUOTA_EXCEEDED");
  assert.equal(replies[1].result, "committed");
});

test("SDK and real MessageChannel persist through a new game client with all six operations", async () => {
  const db = createGameStorageDatabase({ factory: new IDBFactory() });
  function connect(origin) {
    const channel = new MessageChannel(),
      handlers = createLocalStorageHandlers(origin, db);
    channel.port1.on("message", (message) => {
      void rpc.dispatchRpcMessage(channel.port1, message, handlers);
    });
    const client = createLocalStorageClient(channel.port2);
    return {
      client,
      close() {
        client.destroy();
        channel.port1.close();
        channel.port2.close();
      },
    };
  }
  let game = connect(A),
    other = connect(B);
  const write = game.client.setItem(123, { progress: 29 });
  const read = game.client.getItem(123);
  assert.equal(await write, undefined);
  assert.equal(await read, "[object Object]");
  await other.client.setItem("123", "separate");
  game.close();
  game = connect(A);
  assert.equal(await game.client.getItem("123"), "[object Object]");
  assert.equal(await game.client.length(), 1);
  assert.equal(await game.client.key(0), "123");
  await game.client.removeItem("123");
  assert.equal(await game.client.length(), 0);
  await game.client.setItem("a", "b");
  await game.client.clear();
  assert.equal(await game.client.getItem("a"), null);
  assert.equal(await other.client.getItem("123"), "separate");
  game.close();
  other.close();
  await db.close();
});

test("SDK close rejects both active and queued requests and unavailable IDB never returns missing data", async () => {
  const channel = new MessageChannel();
  const client = createLocalStorageClient(channel.port2);
  const outcomes = Promise.allSettled([
    client.setItem("a", "b"),
    client.getItem("a"),
  ]);
  await Promise.resolve();
  client.destroy();
  assert.ok(
    (await outcomes).every(
      (result) =>
        result.status === "rejected" && result.reason.code === "BRIDGE_CLOSED",
    ),
  );
  channel.port1.close();
  channel.port2.close();
  const db = createGameStorageDatabase({ factory: undefined });
  await assert.rejects(db.getItem(A, "a"), /unavailable/);
});

test("both platform hosts advertise the storage methods", async () => {
  for (const path of [
    "../apps/web/src/features/game/LegacySoloHost.tsx",
    "../apps/web/src/features/room/useRoomGameBridge.ts",
  ]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /\.\.\.LOCAL_STORAGE_CAPABILITIES/);
    assert.match(source, /\.\.\.createLocalStorageHandlers\(/);
  }
  assert.equal(LOCAL_STORAGE_CAPABILITIES.length, 6);
});
