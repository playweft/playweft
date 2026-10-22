import { JsonRpcErrorCode, type JsonValue } from "@playweft/game-protocol";
import {
  RpcFault,
  rpcPlatformFault,
  type RpcHandlers,
} from "@/platform/json-rpc";

export const LOCAL_STORAGE_CAPABILITIES = [
  "localStorage.getItem",
  "localStorage.setItem",
  "localStorage.removeItem",
  "localStorage.clear",
  "localStorage.key",
  "localStorage.length",
];
export const STORAGE_DATABASE = "playweft-game-storage";
export const MAX_ORIGIN_BYTES = 128 * 1024 * 1024;
export const MAX_VALUE_BYTES = 16 * 1024 * 1024;
const MAX_KEY_LENGTH = 4096;

type Entry = {
  origin: string;
  key: string;
  value: string;
  sizeBytes: number;
  updatedAt: number;
};
type Origin = {
  origin: string;
  entryCount: number;
  usageBytes: number;
  updatedAt: number;
};

/** Runs only in the platform's first-party document. All games share this DB. */
export function createGameStorageDatabase({
  factory = globalThis.indexedDB,
  name = STORAGE_DATABASE,
  maxOriginBytes = MAX_ORIGIN_BYTES,
}: { factory?: IDBFactory; name?: string; maxOriginBytes?: number } = {}) {
  let connection: Promise<IDBDatabase> | undefined;
  function open(): Promise<IDBDatabase> {
    if (connection) return connection;
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      if (!factory)
        return reject(
          new DOMException("IndexedDB is unavailable", "InvalidStateError"),
        );
      const request = factory.open(name, 1);
      let failed = false;
      request.onupgradeneeded = () => {
        const entries = request.result.createObjectStore("entries", {
          keyPath: ["origin", "key"],
        });
        entries.createIndex("byOrigin", "origin");
        request.result.createObjectStore("origins", { keyPath: "origin" });
      };
      request.onblocked = () => {
        failed = true;
        reject(
          new DOMException(
            "Close other platform tabs to upgrade storage",
            "InvalidStateError",
          ),
        );
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        if (failed) {
          db.close();
          return;
        }
        db.onversionchange = () => {
          db.close();
          connection = undefined;
        };
        db.onclose = () => {
          connection = undefined;
        };
        // This improves eviction resistance when granted; saving does not depend
        // on the browser granting a persistent-storage request.
        try {
          const storage = globalThis.navigator?.storage;
          if (storage?.persist) void storage.persist().catch(() => false);
        } catch {
          /* Persistence requests are optional browser policy. */
        }
        resolve(db);
      };
    });
    connection = pending;
    void pending.catch(() => {
      if (connection === pending) connection = undefined;
    });
    return pending;
  }
  async function transaction<T>(
    mode: IDBTransactionMode,
    work: (
      tx: IDBTransaction,
      result: (value: T) => void,
      abort: (error: unknown) => void,
    ) => void,
  ): Promise<T> {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(["entries", "origins"], mode, {
        durability: mode === "readwrite" ? "strict" : "default",
      });
      let result: T, failure: unknown;
      const abort = (error: unknown) => {
        failure = error;
        tx.abort();
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () =>
        reject(
          failure ??
            tx.error ??
            new DOMException("Storage transaction aborted", "AbortError"),
        );
      try {
        work(
          tx,
          (value) => {
            result = value;
          },
          abort,
        );
      } catch (error) {
        abort(error);
      }
    });
  }
  return {
    getItem(origin: string, key: string) {
      return transaction<string | null>("readonly", (tx, done) => {
        const request = tx.objectStore("entries").get([origin, key]);
        request.onsuccess = () =>
          done((request.result as Entry | undefined)?.value ?? null);
      });
    },
    setItem(origin: string, key: string, value: string) {
      return transaction<null>("readwrite", (tx, done, abort) => {
        const entries = tx.objectStore("entries"),
          origins = tx.objectStore("origins");
        const entryRequest = entries.get([origin, key]),
          originRequest = origins.get(origin);
        originRequest.onsuccess = () => {
          try {
            const old = entryRequest.result as Entry | undefined;
            if (old?.value === value) return done(null);
            const meta: Origin = originRequest.result ?? {
              origin,
              entryCount: 0,
              usageBytes: 0,
              updatedAt: 0,
            };
            const sizeBytes = 2 * (key.length + value.length);
            const usageBytes =
              meta.usageBytes - (old?.sizeBytes ?? 0) + sizeBytes;
            if (usageBytes > maxOriginBytes)
              return abort(
                new DOMException(
                  "The game origin's storage quota was exceeded",
                  "QuotaExceededError",
                ),
              );
            const updatedAt = Date.now();
            entries.put({
              origin,
              key,
              value,
              sizeBytes,
              updatedAt,
            } satisfies Entry);
            origins.put({
              origin,
              entryCount: meta.entryCount + (old ? 0 : 1),
              usageBytes,
              updatedAt,
            } satisfies Origin);
            done(null);
          } catch (error) {
            abort(error);
          }
        };
      });
    },
    removeItem(origin: string, key: string) {
      return transaction<null>("readwrite", (tx, done, abort) => {
        const entries = tx.objectStore("entries"),
          origins = tx.objectStore("origins");
        const entryRequest = entries.get([origin, key]),
          originRequest = origins.get(origin);
        originRequest.onsuccess = () => {
          try {
            const old = entryRequest.result as Entry | undefined;
            if (old) {
              const meta = originRequest.result as Origin;
              entries.delete([origin, key]);
              origins.put({
                origin,
                entryCount: meta.entryCount - 1,
                usageBytes: meta.usageBytes - old.sizeBytes,
                updatedAt: Date.now(),
              } satisfies Origin);
            }
            done(null);
          } catch (error) {
            abort(error);
          }
        };
      });
    },
    clear(origin: string) {
      return transaction<null>("readwrite", (tx, done) => {
        const request = tx
          .objectStore("entries")
          .index("byOrigin")
          .openCursor(IDBKeyRange.only(origin));
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };
        tx.objectStore("origins").put({
          origin,
          entryCount: 0,
          usageBytes: 0,
          updatedAt: Date.now(),
        } satisfies Origin);
        done(null);
      });
    },
    key(origin: string, index: number) {
      return transaction<string | null>("readonly", (tx, done) => {
        const request = tx
          .objectStore("entries")
          .index("byOrigin")
          .openKeyCursor(IDBKeyRange.only(origin));
        let advanced = false;
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor && index > 0 && !advanced) {
            advanced = true;
            cursor.advance(index);
          } else done(cursor ? (cursor.primaryKey as string[])[1] : null);
        };
      });
    },
    length(origin: string) {
      return transaction<number>("readonly", (tx, done) => {
        const request = tx.objectStore("origins").get(origin);
        request.onsuccess = () =>
          done((request.result as Origin | undefined)?.entryCount ?? 0);
      });
    },
    async close() {
      (await connection)?.close();
      connection = undefined;
    },
  };
}

let database: ReturnType<typeof createGameStorageDatabase> | undefined;
/** Origin comes exclusively from attachGameBridge's validated frame identity. */
export function createLocalStorageHandlers(
  origin: string,
  storage = (database ??= createGameStorageDatabase()),
): RpcHandlers {
  const normalized = new URL(origin);
  if (
    !["https:", "http:"].includes(normalized.protocol) ||
    normalized.origin !== origin
  )
    throw new Error("Invalid game storage origin");
  let tail: Promise<unknown> = Promise.resolve();
  const handlers: RpcHandlers = {};
  for (const method of LOCAL_STORAGE_CAPABILITIES) {
    const action = method.slice("localStorage.".length);
    handlers[method] = {
      handle(params) {
        const fields =
          action === "setItem"
            ? ["key", "value"]
            : action === "getItem" || action === "removeItem"
              ? ["key"]
              : action === "key"
                ? ["index"]
                : [];
        const input = params ?? {};
        if (
          typeof input !== "object" ||
          input === null ||
          Array.isArray(input) ||
          Object.keys(input).length !== fields.length ||
          fields.some((field) => !(field in input))
        )
          throw new RpcFault(
            JsonRpcErrorCode.InvalidParams,
            `Invalid ${method} parameters`,
          );
        const data = input as Record<string, JsonValue>;
        if (
          fields.includes("key") &&
          (typeof data.key !== "string" || data.key.length > MAX_KEY_LENGTH)
        )
          throw new RpcFault(
            JsonRpcErrorCode.InvalidParams,
            "Storage key must be a string of at most 4096 UTF-16 code units",
          );
        if (
          action === "setItem" &&
          (typeof data.value !== "string" ||
            data.value.length * 2 > MAX_VALUE_BYTES)
        )
          throw new RpcFault(
            JsonRpcErrorCode.InvalidParams,
            "Storage value must be a string of at most 16 MiB",
          );
        if (
          action === "key" &&
          (!Number.isSafeInteger(data.index) || Number(data.index) < 0)
        )
          throw new RpcFault(
            JsonRpcErrorCode.InvalidParams,
            "Storage index must be a non-negative safe integer",
          );
        // Serialize every operation on this port, including reads after writes.
        const result = tail.then(async () => {
          try {
            switch (action) {
              case "getItem":
                return await storage.getItem(origin, data.key as string);
              case "setItem":
                return await storage.setItem(
                  origin,
                  data.key as string,
                  data.value as string,
                );
              case "removeItem":
                return await storage.removeItem(origin, data.key as string);
              case "clear":
                return await storage.clear(origin);
              case "key":
                return await storage.key(origin, data.index as number);
              default:
                return await storage.length(origin);
            }
          } catch (error) {
            const name = error instanceof Error ? error.name : "Error";
            throw rpcPlatformFault(
              name === "QuotaExceededError"
                ? "STORAGE_QUOTA_EXCEEDED"
                : "STORAGE_UNAVAILABLE",
              error instanceof Error
                ? error.message
                : "Game storage is unavailable",
              name !== "QuotaExceededError",
            );
          }
        });
        tail = result.catch(() => {});
        return result;
      },
    };
  }
  return handlers;
}
