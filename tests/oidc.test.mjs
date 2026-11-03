import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import ts from "typescript";
import * as oauth from "oauth4webapi";

const issuer = "https://sso.example.com/identity";
const origin = "https://play.example.com";
const callback = `${origin}/api/auth/oidc/callback`;
const keys = await webcrypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const jwk = {
  ...(await webcrypto.subtle.exportKey("jwk", keys.publicKey)),
  kid: "test",
  alg: "RS256",
  use: "sig",
};
const base64 = (value) =>
  Buffer.from(
    typeof value === "string" ? value : JSON.stringify(value),
  ).toString("base64url");
async function jwt(claims, wrongSignature = false) {
  const input = `${base64({ alg: "RS256", kid: "test" })}.${base64(claims)}`;
  const signature = new Uint8Array(
    await webcrypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keys.privateKey,
      Buffer.from(input),
    ),
  );
  if (wrongSignature) signature[0] ^= 1;
  return `${input}.${Buffer.from(signature).toString("base64url")}`;
}

function fixture(config = {}, options = {}) {
  const env = {
    AUTH_SECRET: "test-platform-secret-not-for-production",
    OIDC_ISSUER_URL: issuer,
    ...config,
  };
  const requests = [];
  let authorization;
  const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [
      "none",
      "client_secret_basic",
      "client_secret_post",
    ],
    client_id_metadata_document_supported: true,
    ...options.metadata,
  };
  const fakeFetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/.well-known/openid-configuration"))
      return Response.json(metadata);
    if (url === `${issuer}/jwks`) return Response.json({ keys: [jwk] });
    if (url === `${issuer}/token`) {
      const body = new URLSearchParams(init.body);
      assert.equal(body.get("redirect_uri"), callback);
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.equal(
        await oauth.calculatePKCECodeChallenge(body.get("code_verifier")),
        authorization.searchParams.get("code_challenge"),
      );
      return Response.json({
        token_type: "Bearer",
        access_token: "access",
        id_token: await jwt(
          {
            iss: issuer,
            sub: "user-123",
            aud: authorization.searchParams.get("client_id"),
            exp: Math.floor(Date.now() / 1000) + 300,
            iat: Math.floor(Date.now() / 1000),
            nonce: authorization.searchParams.get("nonce"),
            ...options.claims,
          },
          options.wrongSignature,
        ),
      });
    }
    if (url === `${issuer}/userinfo`)
      return Response.json({
        sub: "user-123",
        name: "OIDC Player",
        preferred_username: "player",
        picture: "https://images.example.com/avatar.png",
        ...options.userInfo,
      });
    throw new Error(`Unexpected fetch ${url}`);
  };
  const cache = new Map();
  function module(name) {
    if (cache.has(name)) return cache.get(name);
    const exports = {};
    cache.set(name, exports);
    const source = readFileSync(
      new URL(`../apps/worker/src/${name}.ts`, import.meta.url),
      "utf8",
    );
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    });
    vm.runInNewContext(outputText, {
      exports,
      URL,
      URLSearchParams,
      Request,
      Response,
      Headers,
      TextEncoder,
      TextDecoder,
      Uint8Array,
      Date,
      Error,
      AbortSignal,
      crypto: webcrypto,
      btoa,
      atob,
      fetch: fakeFetch,
      require(specifier) {
        if (specifier === "oauth4webapi") return oauth;
        return module(specifier.replace("./", ""));
      },
    });
    return exports;
  }
  const api = module("oidc"),
    session = module("platform-session");
  return {
    env,
    api,
    session,
    requests,
    async start(returnTo = "/?game=test") {
      const response = await api.startOidcLogin(
        new Request(
          `${origin}/api/auth/oidc/start?return_to=${encodeURIComponent(returnTo)}`,
        ),
        env,
      );
      authorization = new URL(response.headers.get("location"));
      return {
        response,
        authorization,
        cookie: response.headers.get("set-cookie").split(";")[0],
      };
    },
    async finish(login, params = {}) {
      const url = new URL(callback);
      url.search = new URLSearchParams({
        code: "code",
        state: login.authorization.searchParams.get("state"),
        ...params,
      });
      return api.finishOidcLogin(
        new Request(url, { headers: { cookie: login.cookie } }),
        env,
      );
    },
  };
}

test("issuer-only CIMD publishes matching public metadata and completes a signed OIDC login", async () => {
  const f = fixture();
  const metadata = f.api.oidcClientMetadata(
    new Request(`${origin}/api/auth/oidc/client.json`),
    f.env,
  );
  const document = await metadata.json();
  assert.equal(document.client_id, `${origin}/api/auth/oidc/client.json`);
  assert.deepEqual(document.redirect_uris, [callback]);
  assert.equal(document.token_endpoint_auth_method, "none");
  assert.equal(document.client_secret, undefined);
  const login = await f.start();
  assert.equal(
    login.authorization.searchParams.get("client_id"),
    document.client_id,
  );
  assert.equal(login.authorization.searchParams.get("scope"), "openid profile");
  assert.ok(login.authorization.searchParams.get("nonce"));
  assert.match(
    login.response.headers.get("set-cookie"),
    /HttpOnly; SameSite=Lax/,
  );
  const response = await f.finish(login);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `${origin}/?game=test`);
  const tokenRequest = f.requests.find((request) =>
    request.url.endsWith("/token"),
  );
  assert.equal(
    new Headers(tokenRequest.init.headers).get("authorization"),
    null,
  );
  const cookies = response.headers.getSetCookie();
  const platformCookie = cookies.find((cookie) =>
    cookie.startsWith("playweft_session="),
  );
  assert.ok(platformCookie);
  assert.match(cookies[0], /Max-Age=0/);
  const request = new Request(`${origin}/api/platform/session`, {
    headers: { cookie: platformCookie.split(";")[0] },
  });
  const status = await (
    await f.session.platformSessionStatus(request, f.env)
  ).json();
  assert.equal(status.provider, "oidc");
  assert.equal(status.accountName, "OIDC Player");
  assert.equal(status.avatarUrl, "https://images.example.com/avatar.png");
  assert.ok(status.accountKey);
  const guestUpdate = await f.session.issueGuestSession(
    new Request(`${origin}/api/platform/guest`, {
      method: "POST",
      headers: { origin, cookie: platformCookie.split(";")[0] },
      body: JSON.stringify({ name: "New nickname" }),
    }),
    f.env,
  );
  assert.match(guestUpdate.headers.get("set-cookie"), /Max-Age=2592000/);
  const identity = await f.session.requirePlatformSession(
    new Request(origin, {
      headers: { cookie: guestUpdate.headers.get("set-cookie").split(";")[0] },
    }),
    f.env,
  );
  assert.equal(identity.provider, "oidc");
  assert.equal(identity.name, "New nickname");
  assert.ok(identity.sub.startsWith("oidc:"));
});

test("pre-registered public and secret clients work without CIMD support", async () => {
  for (const secret of [undefined, "secret"]) {
    const f = fixture(
      { OIDC_CLIENT_ID: "registered", OIDC_CLIENT_SECRET: secret },
      { metadata: { client_id_metadata_document_supported: false } },
    );
    const login = await f.start();
    assert.equal(
      login.authorization.searchParams.get("client_id"),
      "registered",
    );
    assert.equal((await f.finish(login)).status, 302);
    const request = f.requests.find((request) =>
      request.url.endsWith("/token"),
    );
    assert.equal(
      new Headers(request.init.headers).get("authorization"),
      secret ? `Basic ${btoa("registered:secret")}` : null,
    );
    assert.throws(
      () => f.api.oidcClientMetadata(new Request(origin), f.env),
      (error) => error.status === 404,
    );
  }
});

test("configuration errors and unsupported CIMD fail before sending users to the issuer", async () => {
  for (const [config, options] of [
    [{ OIDC_CLIENT_SECRET: "secret" }, {}],
    [{ OIDC_ISSUER_URL: "http://untrusted.example" }, {}],
    [{}, { metadata: { client_id_metadata_document_supported: false } }],
    [
      {},
      {
        metadata: {
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
        },
      },
    ],
    [{}, { metadata: { issuer: "https://different.example" } }],
    [
      { OIDC_ISSUER_URL: "https://sso.example.com" },
      { metadata: { issuer: "https://sso.example.com/" } },
    ],
  ]) {
    const f = fixture(config, options);
    await assert.rejects(f.start());
    assert.equal(
      f.requests.some((request) => request.url.endsWith("/token")),
      false,
    );
  }
});

test("state, nonce, audience, issuer, expiry, signature and UserInfo subject must validate", async () => {
  const variants = [
    { params: { state: "wrong" } },
    { options: { claims: { nonce: "wrong" } } },
    { options: { claims: { aud: "wrong" } } },
    { options: { claims: { iss: "https://wrong.example" } } },
    { options: { claims: { exp: 1 } } },
    { options: { wrongSignature: true } },
    { options: { userInfo: { sub: "different-user" } } },
    { tamper: true },
  ];
  for (const variant of variants) {
    const f = fixture({}, variant.options);
    const login = await f.start();
    if (variant.tamper) login.cookie += "tampered";
    const result = await f.finish(login, variant.params);
    assert.equal(result.status, 400, JSON.stringify(variant));
    assert.ok(
      !result.headers
        .getSetCookie()
        .some((cookie) => cookie.startsWith("playweft_session=")),
    );
    assert.match(result.headers.get("set-cookie"), /Max-Age=0/);
  }
});

test("unsafe return URLs never redirect the authenticated browser away from the platform", async () => {
  for (const target of [
    "//evil.example",
    "/\\\\evil.example",
    "/api/auth/oidc/start",
  ]) {
    const f = fixture();
    const login = await f.start(target);
    const result = await f.finish(login);
    assert.equal(result.headers.get("location"), `${origin}/`);
  }
});

test("client_secret_post is selected only when advertised and Basic is unavailable", async () => {
  const f = fixture(
    { OIDC_CLIENT_ID: "registered", OIDC_CLIENT_SECRET: "secret" },
    {
      metadata: {
        token_endpoint_auth_methods_supported: ["client_secret_post"],
      },
    },
  );
  const login = await f.start();
  assert.equal((await f.finish(login)).status, 302);
  const request = f.requests.find((request) => request.url.endsWith("/token"));
  assert.equal(new Headers(request.init.headers).get("authorization"), null);
  assert.equal(
    new URLSearchParams(request.init.body).get("client_id"),
    "registered",
  );
  assert.equal(
    new URLSearchParams(request.init.body).get("client_secret"),
    "secret",
  );
});

test("canceling authorization returns to the platform and retires state without exchanging tokens", async () => {
  const f = fixture();
  const login = await f.start("/?game=demo");
  const response = await f.finish(login, { error: "access_denied" });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `${origin}/?game=demo`);
  assert.equal(
    f.requests.some((request) => request.url.endsWith("/token")),
    false,
  );
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
  const wrongState = await f.finish(login, {
    error: "access_denied",
    state: "wrong",
  });
  assert.equal(wrongState.status, 400);
});

test("session status advertises only configured login providers even before a guest session exists", async () => {
  const f = fixture();
  const status = await (
    await f.session.platformSessionStatus(new Request(origin), f.env)
  ).json();
  assert.equal(status.authenticated, false);
  assert.deepEqual(status.loginProviders, { oidc: true, x: false });
  const withoutOidc = await (
    await f.session.platformSessionStatus(new Request(origin), {
      AUTH_SECRET: f.env.AUTH_SECRET,
      X_CLIENT_ID: "x",
      X_CLIENT_SECRET: "secret",
    })
  ).json();
  assert.deepEqual(withoutOidc.loginProviders, { oidc: false, x: true });
});

test("changed configuration or missing transaction cannot establish an OIDC session", async () => {
  const f = fixture({ OIDC_CLIENT_ID: "registered" });
  const login = await f.start();
  f.env.OIDC_CLIENT_ID = "changed";
  assert.equal((await f.finish(login)).status, 400);
  assert.equal(
    f.requests.some((request) => request.url.endsWith("/token")),
    false,
  );
  assert.equal(
    (await f.api.finishOidcLogin(new Request(callback), f.env)).status,
    400,
  );
});

test("blank client IDs select CIMD and client metadata never publishes a secret", async () => {
  const f = fixture({ OIDC_CLIENT_ID: "  ", OIDC_CLIENT_SECRET: "" });
  const login = await f.start();
  assert.equal(
    login.authorization.searchParams.get("client_id"),
    `${origin}/api/auth/oidc/client.json`,
  );
  const metadata = await f.api
    .oidcClientMetadata(new Request(origin), f.env)
    .json();
  assert.equal(metadata.client_secret, undefined);
});
