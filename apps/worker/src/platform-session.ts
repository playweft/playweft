import type { Env } from "./env";

const COOKIE_NAME = "playweft_session";
const SESSION_TTL_SECONDS = 24 * 60 * 60;
const AUTHENTICATED_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_DISPLAY_NAME_LENGTH = 24;
const MAX_ACCOUNT_NAME_LENGTH = 100;

export interface PlatformSession {
  sub: string;
  exp: number;
  provider: "guest" | "x";
  name?: string;
  accountName?: string;
  avatarUrl?: string;
  username?: string;
}

export interface PlatformSessionStatus {
  authenticated: boolean;
  accountKey?: string;
  accountName?: string;
  avatarUrl?: string;
  name?: string;
  provider?: "guest" | "x";
  username?: string;
}

export class PlatformSessionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function issueGuestSession(
  request: Request,
  env: Env,
): Promise<Response> {
  requirePlatformOrigin(request);
  const secret = requireSecret(env);
  const requestedName = await requestedDisplayName(request);
  const existingToken = readCookie(request.headers.get("Cookie"), COOKIE_NAME);
  const existing = existingToken
    ? await verify(existingToken, secret)
    : undefined;
  const now = Math.floor(Date.now() / 1000);
  const current = existing && existing.exp > now ? existing : undefined;
  const name =
    requestedName === undefined
      ? current?.name
      : (requestedName ?? accountDefaultName(current));
  if (current && current.name === name) {
    return Response.json(
      { authenticated: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const sessionTtl =
    current?.provider === "x"
      ? AUTHENTICATED_SESSION_TTL_SECONDS
      : SESSION_TTL_SECONDS;
  const payload: PlatformSession = {
    sub: current?.sub ?? `guest_${crypto.randomUUID()}`,
    exp: now + sessionTtl,
    provider: current?.provider ?? "guest",
    ...(name ? { name } : {}),
    ...(current?.accountName ? { accountName: current.accountName } : {}),
    ...(current?.avatarUrl ? { avatarUrl: current.avatarUrl } : {}),
    ...(current?.username ? { username: current.username } : {}),
  };
  const cookie = await sessionCookie(request, payload, secret, sessionTtl);
  return Response.json(
    { authenticated: true },
    {
      headers: {
        "Set-Cookie": cookie,
        "Cache-Control": "no-store",
      },
    },
  );
}

export async function platformSessionStatus(
  request: Request,
  env: Env,
): Promise<Response> {
  const token = readCookie(request.headers.get("Cookie"), COOKIE_NAME);
  if (!token) return sessionStatusResponse({ authenticated: false });
  const session = await verify(token, requireSecret(env));
  if (!session || session.exp <= Math.floor(Date.now() / 1000)) {
    return sessionStatusResponse({ authenticated: false });
  }
  return sessionStatusResponse({
    authenticated: true,
    provider: session.provider,
    ...(session.provider === "x"
      ? { accountKey: await accountKey(session.sub, requireSecret(env)) }
      : {}),
    ...(session.accountName ? { accountName: session.accountName } : {}),
    ...(session.avatarUrl ? { avatarUrl: session.avatarUrl } : {}),
    ...(session.name ? { name: session.name } : {}),
    ...(session.username ? { username: session.username } : {}),
  });
}

async function accountKey(subject: string, secret: string): Promise<string> {
  return base64Url(await hmac(`account-profile:${subject}`, secret));
}

export function clearPlatformSession(request: Request): Response {
  requirePlatformOrigin(request);
  return Response.json(
    { authenticated: false },
    {
      headers: {
        "Set-Cookie": expiredSessionCookie(request),
        "Cache-Control": "no-store",
      },
    },
  );
}

export async function authenticatedSessionCookie(
  request: Request,
  env: Env,
  identity: {
    sub: string;
    provider: "x";
    accountName: string;
    username: string;
    avatarUrl?: string;
    name?: string;
  },
): Promise<string> {
  const payload: PlatformSession = {
    ...identity,
    exp: Math.floor(Date.now() / 1000) + AUTHENTICATED_SESSION_TTL_SECONDS,
  };
  return sessionCookie(
    request,
    payload,
    requireSecret(env),
    AUTHENTICATED_SESSION_TTL_SECONDS,
  );
}

async function requestedDisplayName(
  request: Request,
): Promise<string | null | undefined> {
  const text = await request.text();
  if (!text) return undefined;
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new PlatformSessionError(400, "invalid session request");
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new PlatformSessionError(400, "session request must be an object");
  }
  const value = (input as { name?: unknown }).name;
  if (value === undefined) return undefined;
  if (value === null) return null;
  const name = displayName(value);
  if (!name) {
    throw new PlatformSessionError(
      400,
      `name must be 1-${MAX_DISPLAY_NAME_LENGTH} characters`,
    );
  }
  return name;
}

export async function requirePlatformSession(
  request: Request,
  env: Env,
): Promise<PlatformSession> {
  const token = readCookie(request.headers.get("Cookie"), COOKIE_NAME);
  if (!token) throw new PlatformSessionError(401, "platform session required");
  const payload = await verify(token, requireSecret(env));
  if (!payload || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new PlatformSessionError(
      401,
      "platform session is invalid or expired",
    );
  }
  return payload;
}

/**
 * Reads the browser-local platform identity without treating its absence as a
 * request failure. OAuth entry points use this to return a normal 401 for a
 * direct navigation before the client has created its first guest session.
 */
export async function findPlatformSession(
  request: Request,
  env: Env,
): Promise<PlatformSession | undefined> {
  const token = readCookie(request.headers.get("Cookie"), COOKIE_NAME);
  if (!token) return undefined;
  const payload = await verify(token, requireSecret(env));
  return payload && payload.exp > Math.floor(Date.now() / 1000)
    ? payload
    : undefined;
}

export function requirePlatformOrigin(request: Request): void {
  const requestOrigin = new URL(request.url).origin;
  if (request.headers.get("Origin") !== requestOrigin) {
    throw new PlatformSessionError(
      403,
      "request must originate from the same origin as the platform endpoint",
    );
  }
}

function requireSecret(env: Env): string {
  if (!env.AUTH_SECRET) {
    throw new PlatformSessionError(503, "AUTH_SECRET is not configured");
  }
  return env.AUTH_SECRET;
}

async function sign(payload: PlatformSession, secret: string): Promise<string> {
  const body = base64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmac(body, secret);
  return `${body}.${base64Url(signature)}`;
}

async function verify(
  token: string,
  secret: string,
): Promise<PlatformSession | undefined> {
  const [body, signature] = token.split(".");
  if (
    !body ||
    !signature ||
    !constantTimeEqual(base64UrlDecode(signature), await hmac(body, secret))
  )
    return undefined;
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(body)),
    ) as Record<string, unknown>;
    if (
      typeof payload.sub !== "string" ||
      typeof payload.exp !== "number" ||
      (payload.provider !== "guest" && payload.provider !== "x")
    ) {
      return undefined;
    }
    const name = displayName(payload.name);
    if (payload.name !== undefined && !name) return undefined;
    const accountName = accountDisplayName(payload.accountName);
    if (payload.accountName !== undefined && !accountName) return undefined;
    const avatarUrl = accountAvatarUrl(payload.avatarUrl);
    if (payload.avatarUrl !== undefined && !avatarUrl) return undefined;
    const provider = payload.provider;
    const username = accountUsername(payload.username);
    if (payload.username !== undefined && !username) return undefined;
    if (provider === "x" && (!accountName || !username)) return undefined;
    if (
      provider === "guest" &&
      (accountName !== undefined ||
        avatarUrl !== undefined ||
        username !== undefined)
    ) {
      return undefined;
    }
    return {
      sub: payload.sub,
      exp: payload.exp,
      provider,
      ...(name ? { name } : {}),
      ...(accountName ? { accountName } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
      ...(username ? { username } : {}),
    };
  } catch {
    return undefined;
  }
}

function accountDefaultName(
  session: PlatformSession | undefined,
): string | undefined {
  if (session?.provider !== "x" || !session.accountName) return undefined;
  return defaultDisplayName(session.accountName);
}

export function defaultDisplayName(value: string): string {
  let result = "";
  for (const character of value.trim()) {
    if (result.length + character.length > MAX_DISPLAY_NAME_LENGTH) break;
    result += character;
  }
  return result;
}

function accountDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return name.length > 0 && name.length <= MAX_ACCOUNT_NAME_LENGTH
    ? name
    : undefined;
}

function accountAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return undefined;
    if (url.hostname === "pbs.twimg.com") {
      url.pathname = url.pathname.replace(
        /_normal(\.[a-z0-9]+)$/i,
        "_200x200$1",
      );
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function accountUsername(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const username = value.trim();
  return username.length > 0 && username.length <= 100 ? username : undefined;
}

async function sessionCookie(
  request: Request,
  payload: PlatformSession,
  secret: string,
  maxAge: number,
): Promise<string> {
  const token = await sign(payload, secret);
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function expiredSessionCookie(request: Request): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

function sessionStatusResponse(status: PlatformSessionStatus): Response {
  return Response.json(status, { headers: { "Cache-Control": "no-store" } });
}

function displayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return name.length > 0 && name.length <= MAX_DISPLAY_NAME_LENGTH
    ? name
    : undefined;
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

function readCookie(header: string | null, name: string): string | undefined {
  return header
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function base64Url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded =
    value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1)
    difference |= left[index]! ^ right[index]!;
  return difference === 0;
}
