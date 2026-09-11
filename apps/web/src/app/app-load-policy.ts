const SETTINGS_STORAGE_KEY = "playweft:settings:v1";
const SETTINGS_CACHE = "playweft:settings:v1";
const SETTINGS_REQUEST = "/.playweft/settings";
const APP_MANIFEST_CACHE = "playweft:manifests:v1";
const FEATURED_LIST_CACHE = "playweft:featured-lists:v1";

export const appLoadPolicies = [
  "cache-disabled",
  "network-first",
  "update-prompt",
  "local-only",
] as const;

export type AppLoadPolicy = (typeof appLoadPolicies)[number];

const DEFAULT_APP_LOAD_POLICY: AppLoadPolicy = "cache-disabled";
const changeEvent = "playweft:settings-change";

interface StoredSettings {
  appLoadPolicy?: AppLoadPolicy;
}

export function readAppLoadPolicy(): AppLoadPolicy {
  if (typeof window === "undefined") return DEFAULT_APP_LOAD_POLICY;
  return readSettings().appLoadPolicy ?? DEFAULT_APP_LOAD_POLICY;
}

export function subscribeToAppLoadPolicy(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === SETTINGS_STORAGE_KEY) onChange();
  };
  window.addEventListener(changeEvent, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(changeEvent, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export async function applyAppLoadPolicy(policy: AppLoadPolicy): Promise<void> {
  writeSettings({ ...readSettings(), appLoadPolicy: policy });
  window.dispatchEvent(new Event(changeEvent));
  await enforceAppLoadPolicy(policy);
}

export async function enforceAppLoadPolicy(
  policy = readAppLoadPolicy(),
): Promise<void> {
  if (policy === "cache-disabled") {
    await disablePlatformCaching();
    return;
  }
  await savePolicyForServiceWorker(policy);
}

export function isAppLoadPolicy(value: unknown): value is AppLoadPolicy {
  return (
    typeof value === "string" &&
    appLoadPolicies.includes(value as AppLoadPolicy)
  );
}

function readSettings(): StoredSettings {
  return parseSettings(window.localStorage.getItem(SETTINGS_STORAGE_KEY));
}

function parseSettings(value: string | null): StoredSettings {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const appLoadPolicy = (parsed as Record<string, unknown>).appLoadPolicy;
    return isAppLoadPolicy(appLoadPolicy) ? { appLoadPolicy } : {};
  } catch {
    return {};
  }
}

function writeSettings(settings: StoredSettings): void {
  window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

async function savePolicyForServiceWorker(
  policy: AppLoadPolicy,
): Promise<void> {
  if (typeof caches !== "undefined") {
    try {
      await (
        await caches.open(SETTINGS_CACHE)
      ).put(
        SETTINGS_REQUEST,
        new Response(JSON.stringify({ appLoadPolicy: policy })),
      );
    } catch {
      // Local storage remains the source of truth for the current page.
    }
  }

  if (!("serviceWorker" in navigator)) return;
  const message = {
    type: "playweft:set-settings",
    settings: { appLoadPolicy: policy },
  };
  navigator.serviceWorker.controller?.postMessage(message);
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    registration?.installing?.postMessage(message);
    registration?.waiting?.postMessage(message);
    registration?.active?.postMessage(message);
  } catch {
    // The next service-worker registration reads the saved cache entry.
  }
}

async function disablePlatformCaching(): Promise<void> {
  if ("serviceWorker" in navigator) {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration?.unregister();
    } catch {
      // Cache deletion below is still worthwhile when unregistering fails.
    }
  }

  if (typeof caches === "undefined") return;
  try {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter(
          (name) =>
            name === APP_MANIFEST_CACHE ||
            name === FEATURED_LIST_CACHE ||
            name.startsWith("workbox-precache"),
        )
        .map((name) => caches.delete(name)),
    );
  } catch {
    // Storage may be unavailable; regular browser loading still works.
  }
}
