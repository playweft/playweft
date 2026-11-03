import type { Env } from "./env";
import {
  PlatformSessionError,
  requirePlatformOrigin,
  requirePlatformSession,
} from "./platform-session";

const TOKEN_VERSION = "v1";
const TOKEN_TTL_SECONDS = 10 * 60;
const MAX_AVATAR_BYTES = 1024 * 1024;

interface AvatarTokenPayload {
  avatarUrl: string;
  expiresAt: number;
  manifestId: string;
}

export async function issueProfileAvatar(
  request: Request,
  env: Env,
): Promise<Response> {
  requirePlatformOrigin(request);
  const session = await requirePlatformSession(request, env);
  const manifestId = await requestManifestId(request);
  if (session.provider === "guest" || !session.avatarUrl || !isAllowedAvatarSource(new URL(session.avatarUrl))) {
    return noStoreJson({ src: null });
  }
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const token = await encryptToken(
    { avatarUrl: session.avatarUrl, expiresAt, manifestId },
    authSecret(env),
  );
  return noStoreJson({
    src: `/api/platform/profile/avatar/${token}`,
    expiresAt: expiresAt * 1000,
  });
}

export async function serveProfileAvatar(
  request: Request,
  env: Env,
  token: string,
): Promise<Response> {
  const payload = await decryptToken(token, authSecret(env));
  if (payload.expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new PlatformSessionError(410, "profile avatar URL has expired");
  }
  return proxyAvatar(payload.avatarUrl, request);
}

async function requestManifestId(request: Request): Promise<string> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new PlatformSessionError(400, "request body must be valid JSON");
  }
  if (!isRecord(body) || Object.keys(body).some((key) => key !== "manifestId")) {
    throw new PlatformSessionError(400, "request must contain manifestId");
  }
  if (typeof body.manifestId !== "string" || body.manifestId.length > 2_048) {
    throw new PlatformSessionError(400, "manifestId must be a valid URL");
  }
  try {
    const url = new URL(body.manifestId);
    if (url.protocol !== "https:" && !isLocalHttp(url)) throw new Error();
    url.hash = "";
    return url.toString();
  } catch {
    throw new PlatformSessionError(400, "manifestId must be a valid URL");
  }
}

async function encryptToken(
  payload: AvatarTokenPayload,
  secret: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(secret),
    plaintext,
  );
  return `${TOKEN_VERSION}.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

async function decryptToken(
  token: string,
  secret: string,
): Promise<AvatarTokenPayload> {
  const [version, encodedIv, encodedCiphertext, extra] = token.split(".");
  if (
    version !== TOKEN_VERSION ||
    !encodedIv ||
    !encodedCiphertext ||
    extra !== undefined
  ) {
    throw invalidToken();
  }
  try {
    const iv = base64UrlDecode(encodedIv);
    if (iv.byteLength !== 12) throw new Error();
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      await encryptionKey(secret),
      base64UrlDecode(encodedCiphertext),
    );
    const value = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
    if (!isRecord(value)) throw new Error();
    if (
      typeof value.avatarUrl !== "string" ||
      typeof value.manifestId !== "string" ||
      typeof value.expiresAt !== "number" ||
      !Number.isSafeInteger(value.expiresAt)
    ) {
      throw new Error();
    }
    const source = new URL(value.avatarUrl);
    if (!isAllowedAvatarSource(source)) throw new Error();
    return {
      avatarUrl: source.toString(),
      expiresAt: value.expiresAt,
      manifestId: value.manifestId,
    };
  } catch (error) {
    if (error instanceof PlatformSessionError) throw error;
    throw invalidToken();
  }
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const material = new TextEncoder().encode(
    `playweft-profile-avatar-v1\0${secret}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

async function proxyAvatar(source: string, request: Request): Promise<Response> {
  const destination = request.headers.get("Sec-Fetch-Dest");
  if (destination && destination !== "image") {
    throw new PlatformSessionError(
      403,
      "profile avatars may only be loaded as images",
    );
  }
  const sourceUrl = new URL(source);
  if (!isAllowedAvatarSource(sourceUrl)) {
    throw new PlatformSessionError(502, "profile avatar source is not allowed");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(sourceUrl, {
      headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif" },
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new PlatformSessionError(
        502,
        `profile avatar request failed (${response.status})`,
      );
    }
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (!isSupportedImageType(contentType)) {
      throw new PlatformSessionError(
        502,
        "profile avatar has an unsupported type",
      );
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_AVATAR_BYTES
    ) {
      throw new PlatformSessionError(502, "profile avatar exceeds the size limit");
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_AVATAR_BYTES) {
      throw new PlatformSessionError(502, "profile avatar exceeds the size limit");
    }
    return new Response(bytes, {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Type": contentType,
        "Cross-Origin-Resource-Policy": "cross-origin",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof PlatformSessionError) throw error;
    if (controller.signal.aborted) {
      throw new PlatformSessionError(504, "profile avatar request timed out");
    }
    throw new PlatformSessionError(502, "could not load profile avatar");
  } finally {
    clearTimeout(timeout);
  }
}

function authSecret(env: Env): string {
  if (!env.AUTH_SECRET) {
    throw new PlatformSessionError(503, "AUTH_SECRET is not configured");
  }
  return env.AUTH_SECRET;
}

function invalidToken(): PlatformSessionError {
  return new PlatformSessionError(404, "profile avatar URL is invalid");
}

function isAllowedAvatarSource(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    (url.hostname === "pbs.twimg.com" || url.hostname === "abs.twimg.com")
  );
}

function isSupportedImageType(value: string | undefined): value is string {
  return (
    value === "image/avif" ||
    value === "image/gif" ||
    value === "image/jpeg" ||
    value === "image/png" ||
    value === "image/webp"
  );
}

function isLocalHttp(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]")
  );
}

function noStoreJson(value: unknown): Response {
  return Response.json(value, { headers: { "Cache-Control": "no-store" } });
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
