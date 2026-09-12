import { GameRoom } from "./room";
import type { Env } from "./env";
import {
  clearPlatformSession,
  issueGuestSession,
  platformSessionStatus,
  PlatformSessionError,
  requirePlatformOrigin,
  requirePlatformSession,
  type PlatformSession,
} from "./platform-session";
import { generateRoomId, roomIdMaxAttempts } from "./room-id";
import { finishXOAuth, startXOAuth } from "./x-oauth";
import {
  cloudflareAccounts,
  cloudflareStatus,
  finishCloudflareOAuth,
  promptCloudflareLanguageModel,
  selectCloudflareAccount,
  startCloudflareOAuth,
} from "./cloudflare-oauth";
import { issueProfileAvatar, serveProfileAvatar } from "./profile-avatar";

const PLAYER_ID_HEADER = "X-Playweft-Player-Id";
const PLAYER_NAME_HEADER = "X-Playweft-Player-Name";
const PLAYER_AVATAR_HEADER = "X-Playweft-Player-Avatar";
const ROOM_ID_HEADER = "X-Playweft-Room-Id";

export { GameRoom };
export type { Env };

export default {
  async fetch(request, env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/api/platform/guest") {
        return issueGuestSession(request, env);
      }
      if (request.method === "GET" && url.pathname === "/api/platform/session") {
        return platformSessionStatus(request, env);
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/platform/cloudflare"
      ) {
        return cloudflareStatus(request, env);
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/platform/cloudflare/accounts"
      ) {
        return cloudflareAccounts(request, env);
      }
      if (
        request.method === "PUT" &&
        url.pathname === "/api/platform/cloudflare/account"
      ) {
        requirePlatformOrigin(request);
        return selectCloudflareAccount(request, env);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/platform/cloudflare/ai/prompt"
      ) {
        requirePlatformOrigin(request);
        return promptCloudflareLanguageModel(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/platform/logout") {
        return clearPlatformSession(request);
      }
      if (
        request.method === "POST" &&
        url.pathname === "/api/platform/profile/avatar"
      ) {
        return issueProfileAvatar(request, env);
      }
      if (request.method === "GET" && url.pathname === "/api/auth/x/start") {
        return startXOAuth(request, env);
      }
      if (request.method === "GET" && url.pathname === "/api/auth/x/callback") {
        return finishXOAuth(request, env);
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/auth/cloudflare/start"
      ) {
        return startCloudflareOAuth(request, env);
      }
      if (
        request.method === "GET" &&
        url.pathname === "/api/auth/cloudflare/callback"
      ) {
        return finishCloudflareOAuth(request, env);
      }
      if (request.method === "POST" && url.pathname === "/api/rooms") {
        requirePlatformOrigin(request);
        const session = await requirePlatformSession(request, env);
        const body = await request.text();
        const attempts = roomIdMaxAttempts(env.ROOM_ID_MAX_ATTEMPTS);
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          const roomId = generateRoomId(env.ROOM_ID_FORMAT);
          const forwarded = new Request(new URL("/create", request.url), {
            body,
            headers: request.headers,
            method: request.method,
          });
          setForwardedIdentity(forwarded, session);
          forwarded.headers.set(ROOM_ID_HEADER, roomId);
          const response =
            await env.GAME_ROOMS.getByName(roomId).fetch(forwarded);
          if (response.status === 409) {
            if (attempt + 1 < attempts) continue;
            return Response.json(
              { error: "room id collision limit reached" },
              { status: 409 },
            );
          }
          if (!response.ok) return response;
          const launch = (await response.json()) as { manifestUrl: string };
          return Response.json({ roomId, manifestUrl: launch.manifestUrl });
        }
      }
      if (request.method === "GET" && url.pathname === "/") {
        return Response.json({
          service: "playweft-game-rooms",
          endpoints: {
            guestSession: "POST /api/platform/guest",
            platformSession: "GET /api/platform/session",
            cloudflare: "GET /api/platform/cloudflare",
            cloudflareAccounts: "GET /api/platform/cloudflare/accounts",
            cloudflareAccount: "PUT /api/platform/cloudflare/account",
            cloudflareLanguageModel:
              "POST /api/platform/cloudflare/ai/prompt",
            profileAvatar: "POST /api/platform/profile/avatar",
            logout: "POST /api/platform/logout",
            xLogin: "GET /api/auth/x/start",
            xCallback: "GET /api/auth/x/callback",
            cloudflareOAuthStart: "GET /api/auth/cloudflare/start",
            cloudflareOAuthCallback: "GET /api/auth/cloudflare/callback",
            createRoom: "POST /api/rooms",
            launch: "GET /api/rooms/:roomId/launch",
            initialize: "PUT /api/rooms/:roomId/initialize",
            join: "POST /api/rooms/:roomId/join",
            start: "POST /api/rooms/:roomId/start",
            leave: "POST /api/rooms/:roomId/leave",
            seat: "POST /api/rooms/:roomId/seat",
            ready: "POST /api/rooms/:roomId/ready",
            roomProfileAvatar: "PUT /api/rooms/:roomId/profile-avatar",
            kick: "POST /api/rooms/:roomId/kick",
            transferHost: "POST /api/rooms/:roomId/transfer-host",
            dissolve: "POST /api/rooms/:roomId/dissolve",
            changeGame: "PUT /api/rooms/:roomId/game",
            returnToRoom: "POST /api/rooms/:roomId/return-to-room",
            state: "GET /api/rooms/:roomId/state",
            action: "POST /api/rooms/:roomId/actions",
            connect: "GET /api/rooms/:roomId/connect (WebSocket)",
            avatar: "GET /api/rooms/:roomId/avatars/:token",
          },
        });
      }

      const avatarMatch =
        /^\/api\/rooms\/([a-zA-Z0-9_-]{1,128})\/avatars\/([a-zA-Z0-9_-]{32})$/.exec(
          url.pathname,
        );
      if (request.method === "GET" && avatarMatch) {
        const roomId = avatarMatch[1]!;
        const token = avatarMatch[2]!;
        return env.GAME_ROOMS.getByName(roomId).fetch(
          new Request(new URL(`/avatars/${token}`, request.url), request),
        );
      }

      const profileAvatarMatch =
        /^\/api\/platform\/profile\/avatar\/(v1\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)$/.exec(
          url.pathname,
        );
      if (request.method === "GET" && profileAvatarMatch) {
        return serveProfileAvatar(request, env, profileAvatarMatch[1]!);
      }

      const match =
        /^\/api\/rooms\/([a-zA-Z0-9_-]{1,128})\/(game|launch|initialize|join|start|leave|seat|ready|profile-avatar|kick|transfer-host|dissolve|return-to-room|state|actions|connect)$/.exec(
          url.pathname,
        );
      if (!match) return Response.json({ error: "not found" }, { status: 404 });

      const roomId = match[1]!;
      const endpoint = match[2]!;
      const forwarded = new Request(
        new URL(`/${endpoint}`, request.url),
        request,
      );
      // These are authenticated, read-only requests. Browsers are allowed to
      // omit (or vary) Origin on a same-origin GET, so enforcing Origin here
      // makes a freshly redirected room fail before its iframe can load.
      // All mutations and the WebSocket handshake still require an exact
      // platform Origin below.
      if (endpoint !== "launch" && endpoint !== "state") {
        requirePlatformOrigin(request);
      }
      const session = await requirePlatformSession(request, env);
      setForwardedIdentity(forwarded, session, endpoint === "profile-avatar");
      return env.GAME_ROOMS.getByName(roomId).fetch(forwarded);
    } catch (error) {
      if (error instanceof PlatformSessionError)
        return Response.json(
          { error: error.message },
          { status: error.status },
        );
      console.error("worker request failed", error);
      return Response.json({ error: "internal worker error" }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;

function setForwardedIdentity(
  request: Request,
  session: PlatformSession,
  includeAvatar = false,
): void {
  request.headers.set(PLAYER_ID_HEADER, session.sub);
  request.headers.delete(PLAYER_NAME_HEADER);
  request.headers.delete(PLAYER_AVATAR_HEADER);
  if (session.name) {
    request.headers.set(PLAYER_NAME_HEADER, encodeURIComponent(session.name));
  }
  if (includeAvatar && session.provider === "x" && session.avatarUrl) {
    request.headers.set(
      PLAYER_AVATAR_HEADER,
      encodeURIComponent(session.avatarUrl),
    );
  }
}
