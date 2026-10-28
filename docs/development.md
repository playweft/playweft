# Local development

## Run the applications

Run commands from the repository root, with each development server in a separate terminal.

```sh
npm install
npm run dev:worker -- --var AUTH_SECRET:local-session-secret
npm run dev:rps
npm run dev:web
```

`AUTH_SECRET` signs the HttpOnly platform session and must be a Worker secret
in a real deployment. Without an X account, the platform issues a temporary
guest identity. The UI may copy its browser-local nickname into the signed
session as an optional display name. Browser-facing
mutations and WebSocket upgrades must have an `Origin` equal to the Worker
endpoint origin. Authenticated read requests remain usable in browsers that
omit `Origin` for a same-origin GET.

## Try Rock-Paper-Scissors

The game page is a static entry in `apps/rps-demo`, bundled with the platform at
`/games/rps/`. It has no direct API access and cannot be meaningfully opened as
a standalone game page. The platform homepage creates an ordinary room for it;
there is no dedicated demo route.

```sh
# Terminal 1: the trusted Worker. No game script needs pre-seeding.
npm run dev:worker -- --var AUTH_SECRET:local-session-secret

# Terminal 2: the static game example.
npm run dev:rps

# Terminal 3: trusted platform page.
npm run dev:web
```

For local development, open `http://localhost:9133`, enter
`http://localhost:9139`, then create a room. In a deployed build, select the
built-in game from the homepage, which resolves to `/games/rps/`. Copy the
resulting `/r/<roomId>` link to another browser or device. Each browser receives
an anonymous platform session. The first player chooses one of three buttons;
the server reveals both choices only after a second player chooses. A draw clears
both choices and starts the next round.

The platform keeps a browser-local list of recently used game Manifests. Names,
translations, icons and modes all come from the validated Manifest; protected
features are requested at runtime, and the iframe cannot replace catalogue
metadata. The room Durable Object
stores only the Manifest URL, fixed package identity, Lua configuration and player limits, game
state, the room creator, and opaque room-scoped player membership.

## Verification

```sh
npm run check
npm run build:web
npx wrangler deploy --config apps/worker/wrangler.jsonc --dry-run
```

[Back to README](../README.md)
