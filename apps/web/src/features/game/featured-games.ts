import { useEffect, useState } from "react";
import { loadGameManifest, type DiscoveredGame } from "@/features/game/game-manifest";
import { readAppLoadPolicy } from "@/app/app-load-policy";

export type FeaturedGame = DiscoveredGame;

declare const __PLAYWEFT_FEATURED_GAME_SOURCES__: unknown;

const MAX_LIST_DEPTH = 4;
const MAX_REMOTE_LISTS = 16;
const MAX_REMOTE_LIST_BYTES = 256 * 1024;
const REMOTE_LIST_TIMEOUT_MS = 8_000;
const FEATURED_LIST_CACHE_NAME = "playweft:featured-lists:v1";
const FEATURED_LIST_CACHED_AT_HEADER = "X-Playweft-Cached-At";

const DEFAULT_FEATURED_GAME_SOURCES: unknown[] = [
  { manifestUrl: "/games/rps/playweft.json" },
];

const configuredSources = Array.isArray(__PLAYWEFT_FEATURED_GAME_SOURCES__)
  ? __PLAYWEFT_FEATURED_GAME_SOURCES__
  : DEFAULT_FEATURED_GAME_SOURCES;
const platformBaseUrl = new URL("/", window.location.href).href;

let featuredGamesPromise: Promise<FeaturedGame[]> | undefined;

export function useFeaturedGames(enabled = true): FeaturedGame[] {
  const [games, setGames] = useState<FeaturedGame[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    featuredGamesPromise ??= loadFeaturedGames(configuredSources);
    void featuredGamesPromise.then((loaded) => {
      if (!cancelled) setGames(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return games;
}

async function loadFeaturedGames(sources: unknown[]): Promise<FeaturedGame[]> {
  const visited = new Set<string>();
  const games = await resolveSources(sources, platformBaseUrl, visited, 0);
  return uniqueGames(games);
}

async function resolveSources(
  sources: unknown[],
  baseUrl: string,
  visited: Set<string>,
  depth: number,
): Promise<FeaturedGame[]> {
  const groups = await Promise.all(
    sources.map(async (source): Promise<FeaturedGame[]> => {
      const parsed = parseSource(source, baseUrl);
      if (!parsed) {
        console.warn("Ignoring an invalid featured-game source", source);
        return [];
      }
      if (parsed.kind === "game") {
        try {
          return [(await loadGameManifest(parsed.url)).game];
        } catch (error) {
          console.warn(`Could not discover featured game ${parsed.url}`, error);
          return [];
        }
      }
      if (
        depth >= MAX_LIST_DEPTH ||
        visited.has(parsed.url) ||
        visited.size >= MAX_REMOTE_LISTS
      ) {
        return [];
      }
      visited.add(parsed.url);
      try {
        const nested = await fetchList(new URL(parsed.url));
        return resolveSources(nested, parsed.url, visited, depth + 1);
      } catch (error) {
        console.warn(`Could not load featured-game list ${parsed.url}`, error);
        return [];
      }
    }),
  );
  return groups.flat();
}

function parseSource(
  value: unknown,
  baseUrl: string,
): { kind: "game" | "list"; url: string } | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const hasGame = typeof source.manifestUrl === "string";
  const hasList = typeof source.listUrl === "string";
  if (hasGame === hasList) return undefined;
  const rawUrl = hasGame ? source.manifestUrl : source.listUrl;
  const url = webUrl(rawUrl as string, baseUrl);
  return url ? { kind: hasGame ? "game" : "list", url } : undefined;
}

async function fetchList(url: URL): Promise<unknown[]> {
  const loadPolicy = readAppLoadPolicy();
  if (loadPolicy === "local-only") {
    const cached = await cachedList(url);
    if (cached === undefined) {
      throw new FeaturedListNetworkError(url, new Error("Not stored locally"));
    }
    return cached;
  }

  try {
    const list = await fetchListFromNetwork(url);
    if (loadPolicy !== "cache-disabled") await cacheList(url, list);
    return JSON.parse(list) as unknown[];
  } catch (error) {
    if (
      loadPolicy === "cache-disabled" ||
      !(error instanceof FeaturedListNetworkError)
    ) {
      throw error;
    }
    const cached = await cachedList(url);
    if (cached !== undefined) return cached;
    throw error;
  }
}

class FeaturedListNetworkError extends Error {
  constructor(
    readonly url: URL,
    readonly cause: unknown,
  ) {
    super(`Could not connect to ${url}`);
  }
}

async function fetchListFromNetwork(url: URL): Promise<string> {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    REMOTE_LIST_TIMEOUT_MS,
  );
  try {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`request failed (${response.status})`);
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > MAX_REMOTE_LIST_BYTES) {
        throw new Error(`list exceeds the ${MAX_REMOTE_LIST_BYTES}-byte limit`);
      }
      const value = JSON.parse(text) as unknown;
      if (!Array.isArray(value)) throw new Error("list must be a JSON array");
      return text;
    } catch (error) {
      if (isNetworkFailure(error))
        throw new FeaturedListNetworkError(url, error);
      throw error;
    }
  } finally {
    window.clearTimeout(timeout);
  }
}

async function cachedList(url: URL): Promise<unknown[] | undefined> {
  if (typeof caches === "undefined") return undefined;
  try {
    const response = await (
      await caches.open(FEATURED_LIST_CACHE_NAME)
    ).match(url);
    if (!response) return undefined;
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_REMOTE_LIST_BYTES) {
      return undefined;
    }
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function cacheList(url: URL, text: string): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const cache = await caches.open(FEATURED_LIST_CACHE_NAME);
    await cache.put(
      url,
      new Response(text, {
        headers: {
          "Content-Type": "application/json",
          [FEATURED_LIST_CACHED_AT_HEADER]: String(Date.now()),
        },
      }),
    );
    await pruneListCache(cache);
  } catch {
    // The list can still load from the network when Cache Storage is unavailable.
  }
}

async function pruneListCache(cache: Cache): Promise<void> {
  const requests = await cache.keys();
  if (requests.length <= MAX_REMOTE_LISTS) return;
  const entries = await Promise.all(
    requests.map(async (request) => {
      const response = await cache.match(request);
      return {
        request,
        cachedAt:
          Number(response?.headers.get(FEATURED_LIST_CACHED_AT_HEADER)) || 0,
      };
    }),
  );
  entries.sort((left, right) => left.cachedAt - right.cachedAt);
  await Promise.all(
    entries
      .slice(0, entries.length - MAX_REMOTE_LISTS)
      .map(({ request }) => cache.delete(request)),
  );
}

function isNetworkFailure(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

function webUrl(value: string, baseUrl: string): string | undefined {
  try {
    const url = new URL(value.trim(), baseUrl);
    const isLocalHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    return (url.protocol === "https:" || isLocalHttp) &&
      url.username.length === 0 &&
      url.password.length === 0
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function uniqueGames(games: FeaturedGame[]): FeaturedGame[] {
  const ids = new Set<string>();
  return games.filter((game) => {
    if (ids.has(game.manifestId)) return false;
    ids.add(game.manifestId);
    return true;
  });
}
