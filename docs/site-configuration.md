# Site configuration

Recommended games and homepage banners can be supplied at deployment time without changing tracked
source. Copy the example to the ignored local configuration and edit it:

```sh
cp apps/web/site.config.example.json apps/web/site.config.local.json
```

Rebuild or deploy the platform after editing the file.

## Share images

Sharing images use `/icons/pwa-512.png` by default. To emit absolute image
URLs for link previews, set `VITE_SITE_ORIGIN` in the frontend environment
or when building, for example:

```sh
VITE_SITE_ORIGIN=https://play.example.com npm run deploy:platform
```

The value must be an HTTP(S) origin without a path, query, or fragment.

## Configuration format

Vite reads `apps/web/site.config.local.json` while building and embeds its
contents into the frontend bundle. The file is not uploaded separately and
changes take effect only after rebuilding. Do not put secrets in it: all
embedded configuration is public in the browser.

The JSON root is an object. `site.config.schema.json` provides editor validation;
the build validates fields and URLs and rejects unknown fields. For example:

```json
{
  "$schema": "./site.config.schema.json",
  "featuredGames": [
    { "manifestUrl": "/games/rps/playweft.json" },
    { "listUrl": "https://catalog.example.com/playweft-games.json" }
  ],
  "banners": [
    {
      "image": "/banners/event.webp",
      "alt": "Join our game night",
      "href": "https://example.com/event"
    }
  ]
}
```

## URL aliases

URL aliases can be configured with `urlMappings`:

```json
"urlMappings": [
  { "prefix": "abc", "target": "https://games.example.com/base/" }
]
```

Visiting `/abc/xxx` opens `https://games.example.com/base/xxx` internally
while keeping the alias in the address bar. No redirect or history replacement
is performed to resolve an alias. Generated game launch and share links use
`/abc/xxx` when their target matches this mapping; unmatched URLs retain the
existing `/?game=...` format. Mode links use `/abc/xxx?mode=solo` or `?mode=room`.
The target is an absolute HTTP(S) URL or a root-relative path; its trailing
slash is optional. Both `/abc` and `/abc/` resolve to the target directory.
Nested prefixes use the longest complete path prefix. Reverse mapping uses
the longest matching target path and verifies it resolves to the original URL.
Targets with game-specific query parameters keep the generic URL format to
avoid confusing game parameters with platform parameters. Reserved platform
paths and duplicate prefixes are rejected. Omit `urlMappings` or use `[]` to
disable aliases. The platform origin is always read from the current URL.

## Banners

Banners appear above the game shelves, in configured
order. Multiple banners rotate every five seconds and also support manual horizontal
scrolling. Rotation pauses on hover, keyboard focus, touch interaction, and hidden
tabs, and when the carousel leaves the viewport; reduced-motion preferences
disable automatic rotation. Scrollbars are hidden, and mobile layouts reveal a
small part of the next banner. Repeated slides support seamless looping in both
directions; duplicated slides are hidden from keyboard and screen-reader navigation.
Single banners do not rotate.
Each banner links in the current tab. `alt` is required as its accessible name.
Use images around 3:1; images fill that aspect ratio and may be cropped.
Broken images are hidden. Omit `banners` or use `[]` to show none. Image and link
URLs accept HTTP(S) or relative paths; executable URLs and credentials are rejected.
Place local images in `apps/web/public/banners/` and reference `/banners/...`.

## Recommended games

Each `featuredGames` entry references either a game Manifest or another JSON
list. Remote lists keep the original array format (they are not site configs)
and may reference more lists. Relative URLs resolve against the containing list.
Both remote lists and game Manifests must allow the Playweft frontend origin
through CORS. Card metadata is fetched from each Manifest. The loader displays
successful requests progressively, preserves configured order, ignores failures,
deduplicates by Manifest ID, and limits recursion, requests, size, and duration.

## Custom configuration path

When the deployment file is elsewhere, set
`PLAYWEFT_SITE_CONFIG_FILE=/path/to/site.config.json`. Relative file paths resolve
against the command's initial working directory. Missing explicit files, invalid
JSON, or invalid configuration fail the build. Without a file, or when
`featuredGames` is omitted, the built-in RPS recommendation is used; an explicit
`featuredGames: []` disables recommendations.

## Migrating older deployments

Existing deployments should rename `featured-games.local.json` to
`site.config.local.json`, wrap the old array in `{ "featuredGames": [...] }`, and
rename `PLAYWEFT_FEATURED_GAMES_FILE` to `PLAYWEFT_SITE_CONFIG_FILE` if used.

[Back to README](../README.md)
