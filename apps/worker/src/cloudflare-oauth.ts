import type { Env } from "./env";
import {
  findPlatformSession,
  PlatformSessionError,
  requirePlatformSession,
} from "./platform-session";

const AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
const TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
const USER_URL = "https://api.cloudflare.com/client/v4/user";
const OAUTH_COOKIE_NAME = "playweft_cloudflare_oauth";
const CONNECTION_COOKIE_NAME = "playweft_cloudflare_connection";
const OAUTH_TTL_SECONDS = 10 * 60;
const ACCESS_TOKEN_REFRESH_SKEW_MS = 60 * 1_000;
const CONNECTION_VERSION = "v1";
// Make the OIDC offline-access request explicit. The client must also enable
// the refresh_token grant type in its dashboard configuration.
const REQUIRED_SCOPES = ["user-details.read", "offline_access"];
const OPTIONAL_SCOPES = ["ai.write"];

interface OAuthState {
  state: string;
  subject: string;
  platformExpiresAt: number;
  returnTo: string;
  exp: number;
}

interface CloudflareTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
}

interface CloudflareUserResponse {
  success?: unknown;
  result?: unknown;
}

interface StoredCloudflareConnection {
  subject: string;
  platformExpiresAt: number;
  accessToken: string;
  expiresAt?: number;
  refreshToken?: string;
  scopes: string[];
  userId: string;
  displayName?: string;
  email?: string;
}

interface CloudflareTokenGrant {
  accessToken: string;
  expiresAt?: number;
  refreshToken?: string;
  scopes?: string[];
}

export interface CloudflareAccessToken {
  accessToken: string;
  setCookie?: string;
}

export interface CloudflareStatus {
  enabled: boolean;
  connected: boolean;
  displayName?: string;
  email?: string;
  expiresAt?: number;
  scopes?: string[];
}

export async function startCloudflareOAuth(
  request: Request,
  env: Env,
): Promise<Response> {
  const clientId = cloudflareClientId(env);
  cloudflareClientSecret(env);
  authSecret(env);
  const session = await findPlatformSession(request, env);
  if (!session) {
    return noStoreJson({ error: "platform session required" }, undefined, 401);
  }
  const requestUrl = new URL(request.url);
  const state: OAuthState = {
    state: randomBase64Url(24),
    subject: session.sub,
    platformExpiresAt: session.exp,
    returnTo: safeReturnTo(requestUrl.searchParams.get("return_to")),
    exp: Math.floor(Date.now() / 1000) + OAUTH_TTL_SECONDS,
  };
  const authorizeUrl = new URL(AUTHORIZE_URL);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: callbackUrl(request),
    scope: [...REQUIRED_SCOPES, ...OPTIONAL_SCOPES].join(" "),
    state: state.state,
  }).toString();

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl.toString(),
      "Set-Cookie": oauthStateCookie(
        request,
        await encodeState(state, authSecret(env)),
      ),
      "Cache-Control": "no-store",
    },
  });
}

export async function finishCloudflareOAuth(
  request: Request,
  env: Env,
): Promise<Response> {
  const state = await oauthState(request, authSecret(env));
  const requestUrl = new URL(request.url);
  if (!state || state.exp <= Math.floor(Date.now() / 1000)) {
    throw new PlatformSessionError(
      400,
      "Cloudflare authorization session is missing or expired",
    );
  }
  // The platform session cookie is SameSite=Strict and is intentionally not
  // relied on during the cross-site OAuth return. The signed, HttpOnly state
  // cookie is issued only after binding this authorization to that session.
  if (requestUrl.searchParams.get("state") !== state.state) {
    throw new PlatformSessionError(
      400,
      "Cloudflare authorization state is invalid",
    );
  }
  if (requestUrl.searchParams.has("error")) {
    return redirectAfterOAuth(request, state.returnTo, undefined, true);
  }
  const code = requestUrl.searchParams.get("code");
  if (!code) {
    throw new PlatformSessionError(
      400,
      "Cloudflare authorization code is missing",
    );
  }

  const token = await exchangeCode(request, env, code);
  const profile = await fetchCloudflareUser(token.accessToken);
  const connection: StoredCloudflareConnection = {
    ...profile,
    subject: state.subject,
    platformExpiresAt: state.platformExpiresAt,
    accessToken: token.accessToken,
    scopes: token.scopes ?? [],
    ...(token.expiresAt ? { expiresAt: token.expiresAt } : {}),
    ...(token.refreshToken ? { refreshToken: token.refreshToken } : {}),
  };
  const maxAge = connectionMaxAge(connection);
  if (maxAge <= 0) {
    return redirectAfterOAuth(request, state.returnTo, undefined, true);
  }
  return redirectAfterOAuth(
    request,
    state.returnTo,
    await connectionCookie(request, connection, authSecret(env), maxAge),
  );
}

export function cloudflareOAuthIsConfigured(env: Env): boolean {
  return Boolean(
    env.CLOUDFLARE_OAUTH_CLIENT_ID?.trim() &&
    env.CLOUDFLARE_OAUTH_CLIENT_SECRET &&
    env.AUTH_SECRET,
  );
}

export async function cloudflareStatus(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!cloudflareOAuthIsConfigured(env)) {
    return noStoreJson({ enabled: false, connected: false });
  }
  let session;
  try {
    session = await requirePlatformSession(request, env);
  } catch (error) {
    if (error instanceof PlatformSessionError && error.status === 401) {
      return noStoreJson({ enabled: true, connected: false });
    }
    throw error;
  }
  const connection = await readConnection(request, session.sub, env);
  if (!connection) {
    return noStoreJson(
      { enabled: true, connected: false },
      connectionCookieIsPresent(request)
        ? expiredConnectionCookie(request)
        : undefined,
    );
  }
  if (
    connection.expiresAt &&
    connection.expiresAt <= Date.now() &&
    !connection.refreshToken
  ) {
    return noStoreJson(
      { enabled: true, connected: false },
      expiredConnectionCookie(request),
    );
  }
  return noStoreJson({
    enabled: true,
    connected: true,
    ...(connection.displayName ? { displayName: connection.displayName } : {}),
    ...(connection.email ? { email: connection.email } : {}),
    ...(connection.expiresAt ? { expiresAt: connection.expiresAt } : {}),
    scopes: connection.scopes,
  } satisfies CloudflareStatus);
}

/**
 * Returns a usable Cloudflare access token for a future protected platform
 * request. Refresh is demand-driven so an idle connection never makes a
 * background OAuth request.
 */
export async function cloudflareAccessToken(
  request: Request,
  env: Env,
): Promise<CloudflareAccessToken> {
  const session = await requirePlatformSession(request, env);
  const connection = await readConnection(request, session.sub, env);
  if (!connection) {
    throw new PlatformSessionError(401, "Cloudflare connection required");
  }
  if (!accessTokenNeedsRefresh(connection)) {
    return { accessToken: connection.accessToken };
  }
  if (!connection.refreshToken) {
    throw new PlatformSessionError(401, "Cloudflare connection has expired");
  }

  const refreshed = await refreshAccessToken(env, connection.refreshToken);
  const next: StoredCloudflareConnection = {
    ...connection,
    accessToken: refreshed.accessToken,
    scopes: refreshed.scopes ?? connection.scopes,
    ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}),
    ...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : {}),
  };
  const maxAge = connectionMaxAge(next);
  if (maxAge <= 0) {
    throw new PlatformSessionError(401, "Cloudflare connection has expired");
  }
  return {
    accessToken: next.accessToken,
    setCookie: await connectionCookie(request, next, authSecret(env), maxAge),
  };
}

async function exchangeCode(
  request: Request,
  env: Env,
  code: string,
): Promise<CloudflareTokenGrant> {
  return exchangeToken(
    env,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl(request),
    }),
    "Cloudflare token exchange failed",
  );
}

async function refreshAccessToken(
  env: Env,
  refreshToken: string,
): Promise<CloudflareTokenGrant> {
  return exchangeToken(
    env,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    "Cloudflare token refresh failed",
  );
}

async function exchangeToken(
  env: Env,
  body: URLSearchParams,
  failureMessage: string,
): Promise<CloudflareTokenGrant> {
  const clientId = cloudflareClientId(env);
  const clientSecret = cloudflareClientSecret(env);
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!response.ok) {
    throw new PlatformSessionError(502, failureMessage);
  }
  const token = (await response.json()) as CloudflareTokenResponse;
  if (typeof token.access_token !== "string" || !token.access_token) {
    throw new PlatformSessionError(502, "Cloudflare token response is invalid");
  }
  const expiresIn =
    typeof token.expires_in === "number" && token.expires_in > 0
      ? token.expires_in
      : undefined;
  return {
    accessToken: token.access_token,
    ...(typeof token.scope === "string"
      ? {
          scopes: token.scope.split(/\s+/).filter(Boolean),
        }
      : {}),
    ...(typeof token.refresh_token === "string" && token.refresh_token
      ? { refreshToken: token.refresh_token }
      : {}),
    ...(expiresIn ? { expiresAt: Date.now() + expiresIn * 1_000 } : {}),
  };
}

async function fetchCloudflareUser(
  accessToken: string,
): Promise<
  Pick<StoredCloudflareConnection, "userId" | "displayName" | "email">
> {
  const response = await fetch(USER_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new PlatformSessionError(502, "Cloudflare user lookup failed");
  }
  const payload = (await response.json()) as CloudflareUserResponse;
  if (
    payload.success !== true ||
    !isRecord(payload.result) ||
    typeof payload.result.id !== "string" ||
    !payload.result.id
  ) {
    throw new PlatformSessionError(502, "Cloudflare user response is invalid");
  }
  const firstName = textValue(payload.result.first_name);
  const lastName = textValue(payload.result.last_name);
  const displayName = [firstName, lastName].filter(Boolean).join(" ");
  const email = textValue(payload.result.email);
  return {
    userId: payload.result.id,
    ...(displayName ? { displayName } : {}),
    ...(email ? { email } : {}),
  };
}

async function readConnection(
  request: Request,
  subject: string,
  env: Env,
): Promise<StoredCloudflareConnection | undefined> {
  const ciphertext = readCookie(
    request.headers.get("Cookie"),
    CONNECTION_COOKIE_NAME,
  );
  if (!ciphertext) return undefined;
  try {
    const connection = await decryptConnection(ciphertext, authSecret(env));
    return connection.subject === subject ? connection : undefined;
  } catch {
    return undefined;
  }
}

async function encryptConnection(
  value: StoredCloudflareConnection,
  secret: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(secret),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return `${CONNECTION_VERSION}.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

async function decryptConnection(
  ciphertext: string,
  secret: string,
): Promise<StoredCloudflareConnection> {
  const [version, encodedIv, encodedCiphertext, extra] = ciphertext.split(".");
  if (
    version !== CONNECTION_VERSION ||
    !encodedIv ||
    !encodedCiphertext ||
    extra !== undefined
  ) {
    throw new PlatformSessionError(
      502,
      "Cloudflare connection data is invalid",
    );
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlDecode(encodedIv) },
      await encryptionKey(secret),
      base64UrlDecode(encodedCiphertext),
    );
    const value = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
    if (
      !isRecord(value) ||
      typeof value.accessToken !== "string" ||
      !value.accessToken ||
      typeof value.subject !== "string" ||
      !value.subject ||
      typeof value.platformExpiresAt !== "number" ||
      !Number.isFinite(value.platformExpiresAt) ||
      !Array.isArray(value.scopes) ||
      !value.scopes.every((scope) => typeof scope === "string") ||
      typeof value.userId !== "string" ||
      !value.userId ||
      (value.expiresAt !== undefined &&
        (typeof value.expiresAt !== "number" ||
          !Number.isFinite(value.expiresAt))) ||
      (value.refreshToken !== undefined &&
        (typeof value.refreshToken !== "string" || !value.refreshToken))
    ) {
      throw new Error();
    }
    const displayName = textValue(value.displayName);
    const email = textValue(value.email);
    return {
      accessToken: value.accessToken,
      subject: value.subject,
      platformExpiresAt: value.platformExpiresAt,
      scopes: value.scopes,
      userId: value.userId,
      ...(displayName ? { displayName } : {}),
      ...(email ? { email } : {}),
      ...(typeof value.expiresAt === "number"
        ? { expiresAt: value.expiresAt }
        : {}),
      ...(typeof value.refreshToken === "string"
        ? { refreshToken: value.refreshToken }
        : {}),
    };
  } catch {
    throw new PlatformSessionError(
      502,
      "Cloudflare connection data is invalid",
    );
  }
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`playweft-cloudflare-oauth-v1\0${secret}`),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

async function encodeState(state: OAuthState, secret: string): Promise<string> {
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(state)));
  return `${payload}.${base64Url(await hmac(payload, secret))}`;
}

async function oauthState(
  request: Request,
  secret: string,
): Promise<OAuthState | undefined> {
  const value = readCookie(request.headers.get("Cookie"), OAUTH_COOKIE_NAME);
  if (!value) return undefined;
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra !== undefined) return undefined;
  if (
    !constantTimeEqual(base64UrlDecode(signature), await hmac(payload, secret))
  ) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(payload)),
    ) as Record<string, unknown>;
    if (
      typeof parsed.state !== "string" ||
      typeof parsed.subject !== "string" ||
      typeof parsed.platformExpiresAt !== "number" ||
      !Number.isFinite(parsed.platformExpiresAt) ||
      typeof parsed.returnTo !== "string" ||
      typeof parsed.exp !== "number"
    ) {
      return undefined;
    }
    return {
      state: parsed.state,
      subject: parsed.subject,
      platformExpiresAt: parsed.platformExpiresAt,
      returnTo: safeReturnTo(parsed.returnTo),
      exp: parsed.exp,
    };
  } catch {
    return undefined;
  }
}

function redirectAfterOAuth(
  request: Request,
  returnTo: string,
  connection?: string,
  failed = false,
): Response {
  const location = new URL(returnTo, request.url);
  if (failed) location.searchParams.set("cloudflare", "failed");
  const headers = new Headers({
    Location: location.toString(),
    "Cache-Control": "no-store",
  });
  headers.append("Set-Cookie", expiredOAuthStateCookie(request));
  if (connection) headers.append("Set-Cookie", connection);
  return new Response(null, { status: 302, headers });
}

function callbackUrl(request: Request): string {
  return new URL("/api/auth/cloudflare/callback", request.url).toString();
}

function cloudflareClientId(env: Env): string {
  if (!env.CLOUDFLARE_OAUTH_CLIENT_ID?.trim()) {
    throw new PlatformSessionError(
      503,
      "CLOUDFLARE_OAUTH_CLIENT_ID is not configured",
    );
  }
  return env.CLOUDFLARE_OAUTH_CLIENT_ID.trim();
}

function cloudflareClientSecret(env: Env): string {
  if (!env.CLOUDFLARE_OAUTH_CLIENT_SECRET) {
    throw new PlatformSessionError(
      503,
      "CLOUDFLARE_OAUTH_CLIENT_SECRET is not configured",
    );
  }
  return env.CLOUDFLARE_OAUTH_CLIENT_SECRET;
}

function authSecret(env: Env): string {
  if (!env.AUTH_SECRET) {
    throw new PlatformSessionError(503, "AUTH_SECRET is not configured");
  }
  return env.AUTH_SECRET;
}

function oauthStateCookie(request: Request, value: string): string {
  return `${OAUTH_COOKIE_NAME}=${value}; Path=/api/auth/cloudflare; HttpOnly; SameSite=Lax; Max-Age=${OAUTH_TTL_SECONDS}${secureAttribute(request)}`;
}

function expiredOAuthStateCookie(request: Request): string {
  return `${OAUTH_COOKIE_NAME}=; Path=/api/auth/cloudflare; HttpOnly; SameSite=Lax; Max-Age=0${secureAttribute(request)}`;
}

async function connectionCookie(
  request: Request,
  connection: StoredCloudflareConnection,
  secret: string,
  maxAge: number,
): Promise<string> {
  const ciphertext = await encryptConnection(connection, secret);
  const cookie = `${CONNECTION_COOKIE_NAME}=${ciphertext}; Path=/api/platform/cloudflare; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureAttribute(request)}`;
  if (new TextEncoder().encode(cookie).byteLength > 3_800) {
    throw new PlatformSessionError(
      502,
      "Cloudflare connection data exceeds cookie limits",
    );
  }
  return cookie;
}

function connectionMaxAge(connection: StoredCloudflareConnection): number {
  // Cloudflare does not document a refresh-token expiry field for this OAuth
  // endpoint. A refresh-capable connection is therefore bounded by the local
  // Playweft identity; a stale refresh token is rejected by Cloudflare on use.
  const latest = connection.refreshToken
    ? connection.platformExpiresAt * 1_000
    : Math.min(
        connection.platformExpiresAt * 1_000,
        connection.expiresAt ?? Number.POSITIVE_INFINITY,
      );
  return Math.floor((latest - Date.now()) / 1_000);
}

function accessTokenNeedsRefresh(
  connection: StoredCloudflareConnection,
): boolean {
  return (
    connection.expiresAt !== undefined &&
    connection.expiresAt - Date.now() <= ACCESS_TOKEN_REFRESH_SKEW_MS
  );
}

function expiredConnectionCookie(request: Request): string {
  return `${CONNECTION_COOKIE_NAME}=; Path=/api/platform/cloudflare; HttpOnly; SameSite=Strict; Max-Age=0${secureAttribute(request)}`;
}

function connectionCookieIsPresent(request: Request): boolean {
  return Boolean(
    readCookie(request.headers.get("Cookie"), CONNECTION_COOKIE_NAME),
  );
}

function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

function secureAttribute(request: Request): string {
  return new URL(request.url).protocol === "https:" ? "; Secure" : "";
}

function noStoreJson(value: unknown, cookie?: string, status = 200): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (cookie) headers.append("Set-Cookie", cookie);
  return Response.json(value, { headers, status });
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readCookie(header: string | null, name: string): string | undefined {
  return header
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

async function hmac(value: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
