export function gameLaunchPath(manifestUrl: string, mode?: "solo"): string {
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
  return `/?game=${encodedGame}${mode === "solo" ? "&mode=solo" : ""}`;
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

/** A shared game link chooses a mode; only an explicit mode restores solo play. */
export function gameModeFromExternalLaunch(location: string): string | undefined {
  if (!gameUrlFromExternalLaunch(location)) return undefined;
  return new URL(location, window.location.origin).searchParams.get("mode") ?? undefined;
}
