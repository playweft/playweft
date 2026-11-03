import * as oauth from "oauth4webapi";
import type { Env } from "./env";
import {
  authenticatedSessionCookie,
  defaultDisplayName,
  PlatformSessionError,
} from "./platform-session";

const CALLBACK_PATH = "/api/auth/oidc/callback";
const CLIENT_PATH = "/api/auth/oidc/client.json";
const COOKIE_NAME = "playweft_oidc";
const LOGIN_TTL = 600;

type LoginState = {
  state: string;
  nonce: string;
  verifier: string;
  issuer: string;
  clientId: string;
  redirectUri: string;
  returnTo: string;
  exp: number;
};

function configuration(request: Request, env: Env) {
  const issuerValue = env.OIDC_ISSUER_URL?.trim();
  const configuredId = env.OIDC_CLIENT_ID?.trim() || undefined;
  const secret = env.OIDC_CLIENT_SECRET;
  if (!issuerValue)
    throw new PlatformSessionError(503, "OIDC_ISSUER_URL is not configured");
  if (secret && !configuredId)
    throw new PlatformSessionError(
      503,
      "OIDC_CLIENT_SECRET requires OIDC_CLIENT_ID",
    );
  const issuer = endpointUrl(issuerValue);
  if (issuer.search || issuer.hash)
    throw new PlatformSessionError(
      503,
      "OIDC_ISSUER_URL must be an issuer URL without a query or fragment",
    );
  const origin = new URL(request.url).origin;
  endpointUrl(origin);
  const clientId = configuredId ?? new URL(CLIENT_PATH, origin).href;
  const cimd = !configuredId;
  if (cimd && new URL(clientId).protocol !== "https:")
    throw new PlatformSessionError(
      503,
      "CIMD requires a public HTTPS platform URL; use a registered OIDC_CLIENT_ID for local HTTP development",
    );
  if (!env.AUTH_SECRET)
    throw new PlatformSessionError(503, "AUTH_SECRET is not configured");
  return {
    issuer,
    issuerIdentifier: issuerValue,
    clientId,
    secret,
    cimd,
    redirectUri: new URL(CALLBACK_PATH, origin).href,
  };
}

function endpointUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PlatformSessionError(
      503,
      "OIDC endpoint must be an absolute URL",
    );
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new PlatformSessionError(
      503,
      "OIDC endpoints require HTTPS (or loopback HTTP for development)",
    );
  return url;
}

function requestOptions(issuer: URL) {
  return {
    [oauth.allowInsecureRequests]: issuer.protocol === "http:",
    [oauth.customFetch]: async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      endpointUrl(String(input));
      return fetch(input, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    },
  };
}

async function provider(config: ReturnType<typeof configuration>) {
  const options = requestOptions(config.issuer);
  const response = await oauth.discoveryRequest(config.issuer, options);
  const as = await oauth.processDiscoveryResponse(config.issuer, response);
  if (as.issuer !== config.issuerIdentifier)
    throw new PlatformSessionError(
      502,
      "OIDC discovery issuer must exactly match OIDC_ISSUER_URL",
    );
  for (const key of [
    "authorization_endpoint",
    "token_endpoint",
    "jwks_uri",
  ] as const) {
    if (typeof as[key] !== "string")
      throw new PlatformSessionError(502, `OIDC discovery is missing ${key}`);
    endpointUrl(as[key]);
  }
  if (as.userinfo_endpoint) endpointUrl(as.userinfo_endpoint);
  if (config.cimd && as.client_id_metadata_document_supported !== true)
    throw new PlatformSessionError(
      503,
      "This OIDC issuer does not advertise CIMD support; configure OIDC_CLIENT_ID (and OIDC_CLIENT_SECRET if required)",
    );
  const method = config.secret
    ? ((
        as.token_endpoint_auth_methods_supported ?? ["client_secret_basic"]
      ).find((value) => value === "client_secret_basic") ??
      as.token_endpoint_auth_methods_supported?.find(
        (value) => value === "client_secret_post",
      ))
    : "none";
  if (
    !method ||
    (as.token_endpoint_auth_methods_supported &&
      !as.token_endpoint_auth_methods_supported.includes(method))
  )
    throw new PlatformSessionError(
      503,
      "OIDC issuer does not support this client's token endpoint authentication method",
    );
  if (
    as.code_challenge_methods_supported &&
    !as.code_challenge_methods_supported.includes("S256")
  )
    throw new PlatformSessionError(
      503,
      "OIDC issuer does not support S256 PKCE",
    );
  const client: oauth.Client = {
    client_id: config.clientId,
    token_endpoint_auth_method: method,
  };
  const clientAuth = config.secret
    ? method === "client_secret_post"
      ? oauth.ClientSecretPost(config.secret)
      : oauth.ClientSecretBasic(config.secret)
    : oauth.None();
  return { as, client, clientAuth, options };
}

export function oidcClientMetadata(request: Request, env: Env): Response {
  const config = configuration(request, env);
  if (!config.cimd) throw new PlatformSessionError(404, "CIMD is not enabled");
  return Response.json(
    {
      client_id: config.clientId,
      client_name: "Playweft",
      client_uri: new URL("/", request.url).href,
      logo_uri: new URL("/icons/pwa-512.png", request.url).href,
      redirect_uris: [config.redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      scope: "openid profile",
      token_endpoint_auth_method: "none",
    },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
}

export async function startOidcLogin(
  request: Request,
  env: Env,
): Promise<Response> {
  const config = configuration(request, env);
  const { as } = await provider(config);
  const state: LoginState = {
    state: oauth.generateRandomState(),
    nonce: oauth.generateRandomNonce(),
    verifier: oauth.generateRandomCodeVerifier(),
    issuer: config.issuerIdentifier,
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    returnTo: safeReturnTo(
      new URL(request.url).searchParams.get("return_to"),
      request.url,
    ),
    exp: Math.floor(Date.now() / 1000) + LOGIN_TTL,
  };
  const url = new URL(as.authorization_endpoint!);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid profile");
  url.searchParams.set("state", state.state);
  url.searchParams.set("nonce", state.nonce);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set(
    "code_challenge",
    await oauth.calculatePKCECodeChallenge(state.verifier),
  );
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.href,
      "Cache-Control": "no-store",
      "Set-Cookie": stateCookie(request, await sealState(state, env)),
    },
  });
}

export async function finishOidcLogin(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const config = configuration(request, env);
    const state = await readState(request, env);
    if (
      state.issuer !== config.issuerIdentifier ||
      state.clientId !== config.clientId ||
      state.redirectUri !== config.redirectUri
    )
      throw new PlatformSessionError(
        400,
        "OIDC login configuration changed; restart sign in",
      );
    const { as, client, clientAuth, options } = await provider(config);
    const url = new URL(request.url);
    let params: URLSearchParams;
    try {
      params = oauth.validateAuthResponse(as, client, url, state.state);
    } catch (error) {
      if (
        error instanceof oauth.AuthorizationResponseError &&
        error.error === "access_denied"
      ) {
        return new Response(null, {
          status: 302,
          headers: {
            Location: new URL(state.returnTo, request.url).href,
            "Cache-Control": "no-store",
            "Set-Cookie": stateCookie(request, "", 0),
          },
        });
      }
      throw error;
    }
    const response = await oauth.authorizationCodeGrantRequest(
      as,
      client,
      clientAuth,
      params,
      config.redirectUri,
      state.verifier,
      options,
    );
    const tokens = await oauth.processAuthorizationCodeResponse(
      as,
      client,
      response,
      { expectedNonce: state.nonce, requireIdToken: true },
    );
    await oauth.validateApplicationLevelSignature(as, response, options);
    const claims = oauth.getValidatedIdTokenClaims(tokens)!;
    let profile: Record<string, unknown> = claims;
    if (as.userinfo_endpoint) {
      const userResponse = await oauth.userInfoRequest(
        as,
        client,
        tokens.access_token,
        options,
      );
      const user = await oauth.processUserInfoResponse(
        as,
        client,
        claims.sub,
        userResponse,
      );
      if (
        userResponse.headers.get("content-type")?.split(";")[0] ===
        "application/jwt"
      )
        await oauth.validateApplicationLevelSignature(
          as,
          userResponse,
          options,
        );
      profile = { ...claims, ...user };
    }
    const accountName =
      shortText(profile.name, 100) ??
      shortText(profile.preferred_username, 100) ??
      "Player";
    const subject = encode(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify([as.issuer, claims.sub])),
        ),
      ),
    );
    const picture = httpsPicture(profile.picture);
    const sessionCookie = await authenticatedSessionCookie(request, env, {
      sub: `oidc:${subject}`,
      provider: "oidc",
      accountName,
      name: defaultDisplayName(accountName),
      ...(shortText(profile.preferred_username, 100)
        ? { username: shortText(profile.preferred_username, 100) }
        : {}),
      ...(picture ? { avatarUrl: picture } : {}),
    });
    const headers = new Headers({
      Location: new URL(state.returnTo, request.url).href,
      "Cache-Control": "no-store",
    });
    headers.append("Set-Cookie", stateCookie(request, "", 0));
    headers.append("Set-Cookie", sessionCookie);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    // Retire the transaction on cancellation and validation failures alike.
    return Response.json(
      {
        error:
          error instanceof PlatformSessionError
            ? error.message
            : "OIDC sign in failed; please restart sign in",
      },
      {
        status: error instanceof PlatformSessionError ? error.status : 400,
        headers: {
          "Cache-Control": "no-store",
          "Set-Cookie": stateCookie(request, "", 0),
        },
      },
    );
  }
}

function shortText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  let result = "";
  for (const character of value.trim()) {
    if (result.length + character.length > limit) break;
    result += character;
  }
  return result;
}

function httpsPicture(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password)
      return url.href;
  } catch {
    /* No usable picture. */
  }
}

function safeReturnTo(value: string | null, base: string): string {
  if (!value?.startsWith("/") || value.startsWith("//") || value.length > 1024)
    return "/";
  const url = new URL(value, base);
  return url.origin === new URL(base).origin &&
    !url.pathname.startsWith("/api/")
    ? `${url.pathname}${url.search}${url.hash}`
    : "/";
}

function stateCookie(request: Request, value: string, ttl = LOGIN_TTL): string {
  return `${COOKIE_NAME}=${value}; Path=/api/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=${ttl}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}

async function stateKey(env: Env): Promise<CryptoKey> {
  if (!env.AUTH_SECRET)
    throw new PlatformSessionError(503, "AUTH_SECRET is not configured");
  const key = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`playweft:oidc-state:v1:${env.AUTH_SECRET}`),
  );
  return crypto.subtle.importKey("raw", key, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

async function sealState(state: LoginState, env: Env): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await stateKey(env),
    new TextEncoder().encode(JSON.stringify(state)),
  );
  return `${encode(iv)}.${encode(new Uint8Array(data))}`;
}

async function readState(request: Request, env: Env): Promise<LoginState> {
  try {
    const cookie = request.headers
      .get("Cookie")
      ?.split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${COOKIE_NAME}=`))
      ?.slice(COOKIE_NAME.length + 1);
    const parts = cookie?.split(".");
    if (!parts || parts.length !== 2) throw new Error();
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(parts[0]!) },
      await stateKey(env),
      decode(parts[1]!),
    );
    const value = JSON.parse(new TextDecoder().decode(plain));
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.exp !== "number" ||
      value.exp <= Math.floor(Date.now() / 1000) ||
      [
        "state",
        "nonce",
        "verifier",
        "issuer",
        "clientId",
        "redirectUri",
        "returnTo",
      ].some((key) => typeof value[key] !== "string" || !value[key])
    )
      throw new Error();
    return value;
  } catch {
    throw new PlatformSessionError(
      400,
      "OIDC login session is missing, invalid or expired",
    );
  }
}

function encode(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function decode(value: string): Uint8Array {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (char) => char.charCodeAt(0),
  );
}
