export function gameLaunchPath(manifestUrl: string): string {
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
  return `/?game=${encodedGame}`;
}

export function gameLaunchLink(manifestUrl: string): string {
  return `${window.location.origin}${gameLaunchPath(manifestUrl)}`;
}
