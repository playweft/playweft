export type FeaturedGameSource = { manifestUrl: string; listUrl?: never } | { listUrl: string; manifestUrl?: never };
export interface SiteBanner {
  image: string;
  alt: string;
  href: string;
}
export interface SiteConfig {
  featuredGames: FeaturedGameSource[];
  banners: SiteBanner[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fail(path: string, reason: string): never {
  throw new Error(`Invalid site config: ${path} ${reason}`);
}
function keys(value: Record<string, unknown>, allowed: string[], path: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key}`, "is not supported");
}
function url(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) fail(path, "must be a nonempty URL");
  const raw = value.trim();
  try {
    const parsed = new URL(raw, "https://site.invalid/");
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
      fail(path, "must be an HTTP(S) or relative URL without credentials");
  } catch {
    fail(path, "must be an HTTP(S) or relative URL without credentials");
  }
  return raw;
}
export function parseSiteConfig(value: unknown): SiteConfig {
  if (!object(value)) fail("root", "must be an object");
  keys(value, ["$schema", "featuredGames", "banners"], "root");
  if (value.$schema !== undefined && typeof value.$schema !== "string") fail("$schema", "must be a string");
  const sources = value.featuredGames === undefined ? [{ manifestUrl: "/games/rps/playweft.json" }] : value.featuredGames;
  const banners = value.banners === undefined ? [] : value.banners;
  if (!Array.isArray(sources)) fail("featuredGames", "must be an array");
  if (!Array.isArray(banners)) fail("banners", "must be an array");
  return {
    featuredGames: sources.map((source, index): FeaturedGameSource => {
      const path = `featuredGames[${index}]`;
      if (!object(source)) fail(path, "must be an object");
      keys(source, ["manifestUrl", "listUrl"], path);
      if ((source.manifestUrl !== undefined) === (source.listUrl !== undefined))
        fail(path, "must specify exactly one of manifestUrl or listUrl");
      return source.manifestUrl !== undefined
        ? { manifestUrl: url(source.manifestUrl, `${path}.manifestUrl`) }
        : { listUrl: url(source.listUrl, `${path}.listUrl`) };
    }),
    banners: banners.map((banner, index) => {
      const path = `banners[${index}]`;
      if (!object(banner)) fail(path, "must be an object");
      keys(banner, ["image", "alt", "href"], path);
      if (typeof banner.alt !== "string" || !banner.alt.trim()) fail(`${path}.alt`, "must be nonempty text");
      return { image: url(banner.image, `${path}.image`), alt: banner.alt.trim(), href: url(banner.href, `${path}.href`) };
    }),
  };
}
