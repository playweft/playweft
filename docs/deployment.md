# Deploy to Cloudflare

Use one public origin, `https://play.example.com`, for the trusted platform
app, Worker API, WebSocket, Durable Object, and the bundled RPS sample at
`/games/rps/`. `npm run build:web` builds both frontend entries into
`apps/web/dist`, which is uploaded by the Worker configuration.

Third-party games should still use a separate origin. That keeps untrusted game
content outside the platform's origin; the Worker's same-origin
check remains the second defence.

## Secrets and authentication

Write the Worker session secret interactively. Do not put it in Git; `secret
put` immediately creates a new Worker version:

```sh
npx wrangler secret put AUTH_SECRET --config apps/worker/wrangler.jsonc
npx wrangler secret put X_CLIENT_ID --config apps/worker/wrangler.jsonc
npx wrangler secret put X_CLIENT_SECRET --config apps/worker/wrangler.jsonc
npx wrangler secret put CLOUDFLARE_OAUTH_CLIENT_SECRET --config apps/worker/wrangler.jsonc
```

## Optional Cloudflare connection

To enable the optional Cloudflare connection, configure its OAuth client as a
confidential Authorization Code client with `client_secret_basic`. Enable both
the `authorization_code` and `refresh_token` grant types, then register this
exact redirect URL:

```text
https://play.example.com/api/auth/cloudflare/callback
```

`CLOUDFLARE_OAUTH_CLIENT_ID` is a non-secret Worker variable, while the client
secret is a Worker secret. Playweft derives a separate AES key from
`AUTH_SECRET` with a Cloudflare-specific context, then encrypts the Cloudflare
access token into an HttpOnly, SameSite cookie scoped only to
`/api/platform/cloudflare`; it keeps no per-user Durable Object, KV, or D1
record for it. The short-lived access token is refreshed only when a protected
Cloudflare request needs it. Playweft explicitly requests the protocol scope
`offline_access`; configure `user-details.read` as a required scope. `ai.write`
may be configured as an optional scope for a future Workers AI integration.

## Optional Sign in with X

To enable Sign in with X, configure the X App as an OAuth 2.0 Web App and
register this exact Callback URL, replacing the example host with the deployed
platform origin:

```text
https://play.example.com/api/auth/x/callback
```

The Worker derives this URL from the incoming request origin. The flow uses
Authorization Code with PKCE and requests only `tweet.read` and `users.read`.

## Room codes

Room ID generation is optional to configure. By default, the Worker uses
`ROOM_ID_FORMAT=code:4` with the friendly alphabet
`23456789ABCDEFGHJKMNPQRSTUVWXYZ`, and retries up to
`ROOM_ID_MAX_ATTEMPTS=8` collisions. Supported formats are `code:N`,
`digits:N`, `base64url:N`, and `uuid`. If the frontend is separately
configured, set `VITE_ROOM_ID_FORMAT` to the same value so the home input can
recognize room codes without an extra config request.

## Deploy

Deploy the platform. The Worker configuration uploads `apps/web/dist`, including
the RPS files under `/games/rps/`; `/api/*` runs the Worker first while other
navigation requests are handled by the React SPA.

```sh
npm run deploy:platform
```

After the first Worker deployment, bind `play.example.com` to that Worker in
the Cloudflare Dashboard. Browser requests are accepted only when their origin
matches the Worker endpoint they reach.

The built-in game uses relative paths, so no game-origin environment variable is
required. Redeploy the platform whenever its frontend, bundled game, or Worker
code changes.

[Back to README](../README.md)
