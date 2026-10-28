import type { DiscoveredGame } from "./game-manifest";
import { gameLaunchMode } from "./game-launch-mode";
import { siteConfig } from "@/app/site-config";
import {
  gameUrlFromMappedPath,
  mappedPathFromGameUrl,
} from "@/app/url-mapping";

export function gameLaunchPath(
  manifestUrl: string,
  mode?: "solo" | "room",
): string {
  const manifest = new URL(manifestUrl);
  if (/\/playweft\.json$/i.test(manifest.pathname)) {
    manifest.pathname = manifest.pathname.slice(0, -"playweft.json".length);
    manifest.search = "";
    manifest.hash = "";
  }
  const mappedPath = mappedPathFromGameUrl(
    manifest.href,
    siteConfig.urlMappings,
    window.location.origin,
  );
  if (mappedPath) return `${mappedPath}${mode ? `?mode=${mode}` : ""}`;
  const game =
    manifest.protocol === "https:"
      ? `${manifest.host}${manifest.pathname}${manifest.search}`
      : manifest.toString();
  const encodedGame = encodeURIComponent(game).replaceAll("%2F", "/");
  return `/?game=${encodedGame}${mode ? `&mode=${mode}` : ""}`;
}

/** Solo only needs an explicit override when the default would ask for a mode. */
export function soloGameLaunchPath(game: Pick<DiscoveredGame, "manifestUrl" | "modes" | "launchMode">): string {
  return gameLaunchPath(game.manifestUrl, gameLaunchMode(game) === "choose" ? "solo" : undefined);
}

/** URL identity and effective launch behavior determine the active game view.
 * Accept generic URLs, aliases and older explicit solo links equally. */
export function isSoloGameLocation(game: Pick<DiscoveredGame, "manifestUrl" | "modes" | "launchMode">, location: string): boolean {
  const source = gameUrlFromExternalLaunch(location);
  if (!source || gameLaunchMode(game, gameModeFromExternalLaunch(location)) !== "solo") return false;
  const expected = gameUrlFromExternalLaunch(gameLaunchPath(game.manifestUrl));
  if (!expected) return false;
  try { return new URL(source).href === new URL(expected).href; }
  catch { return false; }
}

export function gameLaunchLink(manifestUrl: string): string {
  return `${window.location.origin}${gameLaunchPath(manifestUrl)}`;
}

export function gameUrlFromExternalLaunch(
  location: string,
): string | undefined {
  const url = new URL(location, window.location.origin);
  if (url.origin !== window.location.origin) return undefined;
  const mapped = gameUrlFromMappedPath(
    url.href,
    siteConfig.urlMappings,
    window.location.origin,
  );
  if (mapped) return mapped;
  if (url.pathname !== "/") return undefined;
  const value = url.searchParams.get("game")?.trim();
  if (!value) return undefined;
  return /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
}

/** Explicit mode links override the Manifest entry preference. */
export function gameModeFromExternalLaunch(
  location: string,
): string | undefined {
  if (!gameUrlFromExternalLaunch(location)) return undefined;
  return (
    new URL(location, window.location.origin).searchParams.get("mode") ??
    undefined
  );
}

/** Only rooms entered through the game API carry a local return destination.
 * History state survives refresh without putting creator-specific data in the
 * room invite URL shared with other players. */
export function roomReturnPath(roomId: string, state: unknown): string {
  if (!state || typeof state !== "object" || !("roomReturn" in state))
    return "/";
  const target = state.roomReturn;
  if (
    !target ||
    typeof target !== "object" ||
    !("roomId" in target) ||
    target.roomId !== roomId ||
    !("manifestUrl" in target) ||
    typeof target.manifestUrl !== "string"
  )
    return "/";
  try {
    const manifest = new URL(target.manifestUrl);
    return ["http:", "https:"].includes(manifest.protocol)
      ? gameLaunchPath(manifest.href, "soloModeOverride" in target && target.soloModeOverride === false ? undefined : "solo")
      : "/";
  } catch {
    return "/";
  }
}
