# Playweft

An open platform for playing static web games, solo or together.

Playweft discovers games through a manifest, runs them in sandboxed iframes,
and provides shared rooms, invitations, player identity, and networking.
Multiplayer games can use authoritative Lua logic hosted on Cloudflare Durable
Objects or the experimental browser-hosted WebRTC connection mode.

[Try Playweft](https://play.longern.com) · [Integrate a game](docs/game-integration/README.md) · [Deploy your own](docs/deployment.md)

## Features

- Launch games from a URL, with favorites, recent games, and recommendations.
- Share game links and invite players into rooms with configurable room codes.
- Play or spectate, including room hosts who manage a game without taking a seat.
- Use the platform lobby or build a lobby inside the game with the room SDK.
- Keep authoritative multiplayer state on the server, with player-specific views
  for games with hidden information.
- Customize recommendations, banners, and game URL aliases through JSON configuration.
- Support English and Simplified Chinese, with configurable loading and offline policies.

## Quick start

Use Node.js 22.12 or newer and npm. Run these commands from the repository root:

```sh
npm install
```

Start each server in a separate terminal:

```sh
# Platform API and local Durable Objects
npm run dev:worker -- --var AUTH_SECRET:local-session-secret
```

```sh
# Static Rock-Paper-Scissors example
npm run dev:rps
```

```sh
# Platform frontend
npm run dev:web
```

Open [localhost:9133](http://localhost:9133), enter `http://localhost:9139`,
and create a room to try the example. Open the invitation in a second browser
or browser profile to join as another player. No OAuth credentials are required
for local guest sessions.

See [local development](docs/development.md) for the example walkthrough and
session requirements.

## Integrate a game

Host a static game package with a `playweft.json` manifest and a client entry
such as `index.html`. Games open directly by default; they can request a room
through the SDK or declare a platform mode picker. The manifest endpoint must
allow the platform origin through CORS.

Start with the [game integration guide](docs/game-integration/README.md), which
covers the manifest, SDK, room lifecycle, storage, and platform capabilities.
For authoritative server logic, see the [Lua runtime reference](docs/lua-runtime.md).

## Configuration

Copy the example and edit the ignored local file:

```sh
cp apps/web/site.config.example.json apps/web/site.config.local.json
```

The configuration supports `featuredGames`, `banners`, and `urlMappings`.
It is validated and embedded at build time; rebuild after changing it. All
values are public, so keep secrets out of this file.

See [site configuration](docs/site-configuration.md) for examples, URL aliases,
share images, and custom configuration paths.

## Deployment

Playweft deploys the frontend, API, and bundled example as one Cloudflare Worker,
with Durable Objects for rooms. Use a Cloudflare account and choose the Worker
name and domain in `apps/worker/wrangler.jsonc`.

Set a session secret, then deploy:

```sh
npx wrangler secret put AUTH_SECRET --config apps/worker/wrangler.jsonc
npm run deploy:platform
```

The deployment command builds the frontend and bundled game before uploading.
Third-party games should be hosted on a separate origin.

See [deployment](docs/deployment.md) for domain setup, optional OAuth providers,
and room code configuration.

## Development

```text
apps/web                 React frontend and iframe bridge
apps/worker              HTTP API, WebSockets, and room Durable Objects
apps/rps-demo            Bundled Rock-Paper-Scissors example
packages/game-protocol   Shared protocol definitions
packages/runtime-core    Runtime interface
packages/runtime-lua     Lua runtime implementation
```

Run the checks before submitting changes:

```sh
npm run check
```

For design and implementation details, see [architecture](docs/architecture.md).
When contributing a change, include a description of the behavior and the checks
performed. Never commit deployment secrets or local configuration.

## Documentation

| Guide | Contents |
| --- | --- |
| [Game integration](docs/game-integration/README.md) | Manifest, SDK, iframe bridge, and game capabilities |
| [Room client](docs/room-client.md) | Room SDK and client connection behavior |
| [Lua runtime](docs/lua-runtime.md) | Callbacks, timers, state visibility, and runtime limits |
| [Site configuration](docs/site-configuration.md) | Recommendations, banners, share images, and URL aliases |
| [Game URLs](docs/game-urls.md) | Launch modes, sharing, and browser history |
| [Deployment](docs/deployment.md) | Cloudflare deployment, authentication, and room codes |
| [Local development](docs/development.md) | Development servers, example walkthrough, and verification |
| [Architecture](docs/architecture.md) | Repository layout, trust boundary, modules, and room cleanup |
| [HTTP API](docs/http-api.md) | Endpoints used by the trusted platform client |

## License

[MIT](LICENSE)
