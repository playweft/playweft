export function gameLaunchPath(manifestUrl: string, mode?: "solo" | "room"): string {
  const manifest = new URL(manifestUrl);
  if (/\/playweft\.json$/i.test(manifest.pathname)) {
    manifest.pathname = manifest.pathname.slice(0, -"playweft.json".length);
    manifest.search = "";
    manifest.hash = "";
  }
  const game =
    manifest.protocol === "https:"
      ? `${manifest.host}${manifest.pathname}${manifest.search}`
      : manifest.toString();
  const encodedGame = encodeURIComponent(game).replaceAll("%2F", "/");
  return `/?game=${encodedGame}${mode ? `&mode=${mode}` : ""}`;
}

export function gameLaunchLink(manifestUrl: string): string {
  return `${window.location.origin}${gameLaunchPath(manifestUrl)}`;
}

export function gameUrlFromExternalLaunch(
  location: string,
): string | undefined {
  const url = new URL(location, window.location.origin);
  if (url.pathname !== "/") return undefined;
  const value = url.searchParams.get("game")?.trim();
  if (!value) return undefined;
  return /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
}

/** Explicit mode links override the Manifest entry preference. */
export function gameModeFromExternalLaunch(location: string): string | undefined {
  if (!gameUrlFromExternalLaunch(location)) return undefined;
  return new URL(location, window.location.origin).searchParams.get("mode") ?? undefined;
}


/** Only rooms entered through the game API carry a local return destination.
 * History state survives refresh without putting creator-specific data in the
 * room invite URL shared with other players. */
export function roomReturnPath(roomId: string, state: unknown): string {
  if (!state || typeof state !== "object" || !("roomReturn" in state)) return "/";
  const target = state.roomReturn;
  if (!target || typeof target !== "object" || !("roomId" in target) ||
      target.roomId !== roomId || !("manifestUrl" in target) || typeof target.manifestUrl !== "string") return "/";
  try {
    const manifest = new URL(target.manifestUrl);
    return ["http:", "https:"].includes(manifest.protocol) ? gameLaunchPath(manifest.href, "solo") : "/";
  } catch { return "/"; }
}
