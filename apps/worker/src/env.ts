import type { GameRoom } from "./room";

export interface Env {
  GAME_ROOMS: DurableObjectNamespace<GameRoom>;
  ASSETS: Fetcher;
  AUTH_SECRET?: string;
  CLOUDFLARE_OAUTH_CLIENT_ID?: string;
  CLOUDFLARE_OAUTH_CLIENT_SECRET?: string;
  X_CLIENT_ID?: string;
  X_CLIENT_SECRET?: string;
  ROOM_ID_FORMAT?: string;
  ROOM_ID_MAX_ATTEMPTS?: string;
}
