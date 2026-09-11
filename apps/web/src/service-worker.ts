/// <reference lib="WebWorker" />

import {
  cleanupOutdatedCaches,
  matchPrecache,
  precacheAndRoute,
} from "workbox-precaching";
import { clientsClaim } from "workbox-core";
import { registerRoute } from "workbox-routing";

type AppLoadPolicy =
  | "cache-disabled"
  | "network-first"
  | "update-prompt"
  | "local-only";

const settingsCacheName = "playweft:settings:v1";
const settingsRequest = "/.playweft/settings";
const defaultPolicy: AppLoadPolicy = "cache-disabled";

declare const self: ServiceWorkerGlobalScope;

self.addEventListener("message", (event) => {
  const data = event.data as
    | { type?: unknown; settings?: { appLoadPolicy?: unknown } }
    | undefined;
  if (data?.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
    return;
  }
  const policy = data?.settings?.appLoadPolicy;
  if (
    data?.type !== "playweft:set-settings" ||
    !isAppLoadPolicy(policy)
  ) {
    return;
  }
  event.waitUntil(saveSettings(policy));
});

registerRoute(
  ({ request, url }) =>
    request.method === "GET" &&
    url.origin === self.location.origin &&
    isApplicationShellRequest(request, url),
  async ({ request }) => {
    const policy = await readPolicy();
    if (policy === "cache-disabled") return fetchFromNetwork(request);
    if (policy === "network-first") {
      try {
        return await fetchFromNetwork(request);
      } catch {
        return fromPrecache(request);
      }
    }
    if (policy === "local-only") return fromPrecache(request, false);
    return fromPrecache(request);
  },
);

// Register the policy route first. Workbox considers routes in registration
// order, so precacheAndRoute remains the fallback for requests outside the
// application shell (and supplies the local responses used above).
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
clientsClaim();

function isApplicationShellRequest(request: Request, url: URL): boolean {
  // OAuth callbacks are top-level navigations too, but they must always reach
  // the Worker API instead of being mistaken for the SPA shell.
  if (url.pathname.startsWith("/api/")) return false;
  return (
    request.mode === "navigate" ||
    url.pathname.startsWith("/assets/") ||
    /\.(?:css|html|js|mjs|png|svg|webmanifest)$/.test(url.pathname)
  );
}

async function fetchFromNetwork(request: Request): Promise<Response> {
  return fetch(new Request(request, { cache: "no-store" }));
}

async function fromPrecache(
  request: Request,
  fallbackToNetwork = true,
): Promise<Response> {
  const exactMatch = await matchPrecache(request);
  if (exactMatch) return exactMatch;
  if (request.mode === "navigate") {
    const appShell = await matchPrecache("/index.html");
    if (appShell) return appShell;
  }
  if (fallbackToNetwork) return fetch(request);
  return new Response("The requested application resource is unavailable locally.", {
    status: 504,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function readPolicy(): Promise<AppLoadPolicy> {
  try {
    const response = await (
      await caches.open(settingsCacheName)
    ).match(settingsRequest);
    const settings = response ? (await response.json()) as unknown : undefined;
    const policy =
      settings !== null && typeof settings === "object"
        ? (settings as { appLoadPolicy?: unknown }).appLoadPolicy
        : undefined;
    return isAppLoadPolicy(policy) ? policy : defaultPolicy;
  } catch {
    return defaultPolicy;
  }
}

async function saveSettings(policy: AppLoadPolicy): Promise<void> {
  await (
    await caches.open(settingsCacheName)
  ).put(
    settingsRequest,
    new Response(JSON.stringify({ appLoadPolicy: policy })),
  );
}

function isAppLoadPolicy(value: unknown): value is AppLoadPolicy {
  return (
    value === "cache-disabled" ||
    value === "network-first" ||
    value === "update-prompt" ||
    value === "local-only"
  );
}
