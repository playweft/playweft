import type { SiteUrlMapping } from "./site-config-schema";

/** Resolve an alias internally, without navigating or modifying browser history. */
export function gameUrlFromMappedPath(
  location: string,
  mappings: SiteUrlMapping[],
  origin: string,
): string | undefined {
  const source = new URL(location, origin);
  if (source.origin !== origin) return undefined;
  const mapping = mappings
    .filter(
      ({ prefix }) =>
        source.pathname === `/${prefix}` ||
        source.pathname.startsWith(`/${prefix}/`),
    )
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (!mapping) return undefined;
  const target = new URL(mapping.target, origin);
  const suffix = source.pathname.slice(mapping.prefix.length + 1);
  // Append as a path, so a suffix starting with // cannot change the origin.
  target.pathname = `${target.pathname.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
  return target.href;
}

/** Prefer the most specific configured target, matching full path segments. */
export function mappedPathFromGameUrl(
  gameUrl: string,
  mappings: SiteUrlMapping[],
  origin: string,
): string | undefined {
  const game = new URL(gameUrl, origin);
  // Query-bearing game URLs cannot be represented by an alias: alias query
  // parameters belong to the platform (e.g. mode), not the game manifest.
  if (game.search || game.hash) return undefined;
  const candidates = mappings
    .map((mapping) => ({ mapping, target: new URL(mapping.target, origin) }))
    .filter(({ target }) => {
      const base = target.pathname.replace(/\/+$/, "");
      return (
        game.origin === target.origin &&
        (game.pathname === base || game.pathname.startsWith(`${base}/`))
      );
    })
    .sort(
      (a, b) =>
        b.target.pathname.replace(/\/+$/, "").length -
        a.target.pathname.replace(/\/+$/, "").length,
    );
  for (const { mapping, target } of candidates) {
    const suffix = game.pathname
      .slice(target.pathname.replace(/\/+$/, "").length)
      .replace(/^\/+/, "");
    const path = `/${mapping.prefix}/${suffix}`;
    // Nested alias prefixes can shadow an otherwise valid inverse mapping.
    if (gameUrlFromMappedPath(path, mappings, origin) === game.href)
      return path;
  }
  return undefined;
}
