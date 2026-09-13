import type {
  JsonValue,
  RoomActionResponse,
  RoomActionResult,
  RoomJoin,
  RoomLeave,
  RoomPresence,
  RoomSnapshot,
  RoomStart,
} from "@playweft/game-protocol";

export type {
  RoomActionResponse,
  RoomActionResult,
  RoomJoin,
  RoomLeave,
  RoomPresence,
  RoomSnapshot,
  RoomStart,
} from "@playweft/game-protocol";

const apiBase = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ?? "";

export class PlatformApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId?: string,
    readonly retryable?: boolean,
  ) {
    super(message);
    this.name = "PlatformApiError";
  }
}

function endpoint(path: string): URL {
  return new URL(`${apiBase}${path}`, window.location.origin);
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = (await response.json()) as
    | T
    | { error?: string; requestId?: string; retryable?: boolean };
  if (!response.ok) {
    const error =
      body !== null && typeof body === "object" && "error" in body
        ? body.error
        : undefined;
    const requestId =
      body !== null &&
      typeof body === "object" &&
      "requestId" in body &&
      typeof body.requestId === "string"
        ? body.requestId
        : undefined;
    const retryable =
      body !== null &&
      typeof body === "object" &&
      "retryable" in body &&
      typeof body.retryable === "boolean"
        ? body.retryable
        : undefined;
    throw new PlatformApiError(
      typeof error === "string" ? error : `request failed (${response.status})`,
      response.status,
      requestId,
      retryable,
    );
  }
  return body as T;
}

export interface RoomInitialization {
  gameId: string;
  gameVersion: string;
  runtime: "lua";
  serverUrl: string;
  minPlayers: number;
  maxPlayers: number;
  liveRoom?: boolean;
}

export interface CreatedRoom {
  roomId: string;
  manifestUrl: string;
}

export interface RoomLaunch {
  manifestUrl: string;
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

export interface CloudflareStatus {
  enabled: boolean;
  connected: boolean;
  displayName?: string;
  email?: string;
  expiresAt?: number;
  scopes?: string[];
  accountId?: string;
  needsReconnect?: boolean;
}

export interface CloudflareAccount {
  id: string;
  name: string;
}

export interface CloudflareAccountsResponse {
  accounts: CloudflareAccount[];
  accountId?: string;
}

export interface LanguageModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type LanguageModelInput = string | LanguageModelMessage[];

export interface LanguageModelPromptOptions {
  maxOutputTokens?: number;
}

export interface LanguageModelPromptRequest {
  input: LanguageModelInput;
  options?: LanguageModelPromptOptions;
}

export interface LanguageModelPromptResult {
  content: string;
}

export interface IssuedProfileAvatar {
  src: string | null;
  expiresAt?: number;
}

export function getCloudflareStatus(): Promise<CloudflareStatus> {
  return fetch(endpoint("/api/platform/cloudflare"), {
    credentials: "same-origin",
    cache: "no-store",
  }).then(responseJson<CloudflareStatus>);
}

export function getCloudflareAccounts(): Promise<CloudflareAccountsResponse> {
  return fetch(endpoint("/api/platform/cloudflare/accounts"), {
    credentials: "same-origin",
    cache: "no-store",
  }).then(responseJson<CloudflareAccountsResponse>);
}

export function selectCloudflareAccount(
  accountId: string,
): Promise<{ accountId: string }> {
  return fetch(endpoint("/api/platform/cloudflare/account"), {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId }),
  }).then(responseJson<{ accountId: string }>);
}

export function promptLanguageModel(
  prompt: LanguageModelPromptRequest,
): Promise<LanguageModelPromptResult> {
  return fetch(endpoint("/api/platform/cloudflare/ai/prompt"), {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(prompt),
  }).then(responseJson<LanguageModelPromptResult>);
}

export function cloudflareOAuthStartUrl(): string {
  const url = endpoint("/api/auth/cloudflare/start");
  const returnTo = new URL(window.location.href);
  returnTo.searchParams.set("settings", "1");
  url.searchParams.set(
    "return_to",
    `${returnTo.pathname}${returnTo.search}${returnTo.hash}`,
  );
  return url.toString();
}

/**
 * Cloudflare connections belong to a local Playweft identity. A visitor who
 * has not yet joined a room therefore gets a guest identity just before the
 * OAuth redirect; this is not a sign-in requirement.
 */
export async function beginCloudflareOAuth(): Promise<void> {
  await createGuestSession();
  window.location.assign(cloudflareOAuthStartUrl());
}

export function initializeRoom(
  roomId: string,
  initialization: RoomInitialization,
): Promise<RoomPresence> {
  return fetch(
    endpoint(`/api/rooms/${encodeURIComponent(roomId)}/initialize`),
    {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(initialization),
    },
  ).then(responseJson<RoomPresence>);
}

export function joinRoom(roomId: string): Promise<RoomJoin> {
  return fetch(endpoint(`/api/rooms/${encodeURIComponent(roomId)}/join`), {
    method: "POST",
    credentials: "same-origin",
  }).then(responseJson<RoomJoin>);
}

export function startRoom(roomId: string): Promise<RoomStart> {
  return fetch(endpoint(`/api/rooms/${encodeURIComponent(roomId)}/start`), {
    method: "POST",
    credentials: "same-origin",
  }).then(responseJson<RoomStart>);
}

export function leaveRoom(roomId: string): Promise<RoomLeave> {
  return fetch(endpoint(`/api/rooms/${encodeURIComponent(roomId)}/leave`), {
    method: "POST",
    credentials: "same-origin",
  }).then(responseJson<RoomLeave>);
}

export function setRoomSeat(
  roomId: string,
  seat: number | null,
): Promise<RoomPresence> {
  return fetch(endpoint(`/api/rooms/${encodeURIComponent(roomId)}/seat`), {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ seat }),
  }).then(responseJson<RoomPresence>);
}

export function setPlayerReady(
  roomId: string,
  ready: boolean,
): Promise<RoomPresence> {
  return fetch(endpoint(`/api/rooms/${encodeURIComponent(roomId)}/ready`), {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ready }),
  }).then(responseJson<RoomPresence>);
}

export function setRoomProfileAvatarSharing(
  roomId: string,
  shared: boolean,
): Promise<RoomPresence> {
  return fetch(
    endpoint(`/api/rooms/${encodeURIComponent(roomId)}/profile-avatar`),
    {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shared }),
    },
  ).then(responseJson<RoomPresence>);
}

export function kickPlayer(
  roomId: string,
  playerId: string,
): Promise<RoomPresence> {
  return fetch(endpoint(`/api/rooms/${encodeURIComponent(roomId)}/kick`), {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId }),
  }).then(responseJson<RoomPresence>);
}

export function transferRoomHost(
  roomId: string,
  playerId: string,
): Promise<RoomPresence> {
  return fetch(
    endpoint(`/api/rooms/${encodeURIComponent(roomId)}/transfer-host`),
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ playerId }),
    },
  ).then(responseJson<RoomPresence>);
}

export function dissolveRoom(roomId: string): Promise<{ dissolved: true }> {
  return fetch(endpoint(`/api/rooms/${encodeURIComponent(roomId)}/dissolve`), {
    method: "POST",
    credentials: "same-origin",
  }).then(responseJson<{ dissolved: true }>);
}

export function returnRoomToLobby(roomId: string): Promise<RoomPresence> {
  return fetch(
    endpoint(`/api/rooms/${encodeURIComponent(roomId)}/return-to-room`),
    { method: "POST", credentials: "same-origin" },
  ).then(responseJson<RoomPresence>);
}

export function createRoom(manifestUrl: string): Promise<CreatedRoom> {
  return fetch(endpoint("/api/rooms"), {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifestUrl }),
  }).then(responseJson<CreatedRoom>);
}

export function getRoomLaunch(roomId: string): Promise<RoomLaunch> {
  return fetch(endpoint(`/api/rooms/${encodeURIComponent(roomId)}/launch`), {
    credentials: "same-origin",
  }).then(responseJson<RoomLaunch>);
}

export function changeRoomGame(
  roomId: string,
  manifestUrl: string,
): Promise<RoomLaunch> {
  return fetch(endpoint(`/api/rooms/${encodeURIComponent(roomId)}/game`), {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifestUrl }),
  }).then(responseJson<RoomLaunch>);
}

export function createGuestSession(nickname = ""): Promise<void> {
  return fetch(endpoint("/api/platform/guest"), {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: nickname.trim() || null }),
  }).then(async (response) => {
    if (!response.ok)
      throw new Error(
        ((await response.json()) as { error?: string }).error ??
          "could not create platform session",
      );
  });
}

export function getPlatformSession(): Promise<PlatformSessionStatus> {
  return fetch(endpoint("/api/platform/session"), {
    credentials: "same-origin",
    cache: "no-store",
  }).then(responseJson<PlatformSessionStatus>);
}

export function issueProfileAvatar(
  manifestId: string,
): Promise<IssuedProfileAvatar> {
  return fetch(endpoint("/api/platform/profile/avatar"), {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifestId }),
  }).then(responseJson<IssuedProfileAvatar>);
}

export function xLoginUrl(): string {
  const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const url = endpoint("/api/auth/x/start");
  url.searchParams.set("return_to", returnTo);
  return url.toString();
}

export function logoutPlatformSession(): Promise<void> {
  return fetch(endpoint("/api/platform/logout"), {
    method: "POST",
    credentials: "same-origin",
  }).then(async (response) => {
    if (!response.ok) {
      throw new Error(
        ((await response.json()) as { error?: string }).error ??
          "could not end platform session",
      );
    }
  });
}

export function sendAction(
  roomId: string,
  requestId: string,
  action: JsonValue,
): Promise<RoomActionResponse> {
  return fetch(endpoint(`/api/rooms/${encodeURIComponent(roomId)}/actions`), {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId, action }),
  }).then(responseJson<RoomActionResponse>);
}

export function connectRoom(roomId: string): WebSocket {
  const url = endpoint(`/api/rooms/${encodeURIComponent(roomId)}/connect`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(url);
}

export function resolveRoomAvatarUrl(value: string): string | undefined {
  try {
    const platform = endpoint("/");
    const url = new URL(value, platform);
    if (
      url.origin !== platform.origin ||
      !/^\/api\/rooms\/[a-zA-Z0-9_-]{1,128}\/avatars\/[a-zA-Z0-9_-]{32}$/.test(
        url.pathname,
      ) ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

export function resolveProfileAvatarUrl(value: string): string | undefined {
  try {
    const platform = endpoint("/");
    const url = new URL(value, platform);
    if (
      url.origin !== platform.origin ||
      !/^\/api\/platform\/profile\/avatar\/v1\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(
        url.pathname,
      ) ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}
