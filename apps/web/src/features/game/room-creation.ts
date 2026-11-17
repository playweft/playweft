import * as platformApi from "@/platform/platform-api";
import { RpcFault, rpcPlatformFault } from "@/platform/json-rpc";
import type { DiscoveredGame } from "./game-manifest";

type RoomApi = Pick<typeof platformApi, "createGuestSession" | "createRoom">;
export async function createGameRoom(
  game: Pick<DiscoveredGame, "modes" | "manifestUrl">,
  waitForIdentity: () => Promise<string>,
  cancelled: () => boolean,
  api: RoomApi = platformApi,
): Promise<platformApi.CreatedRoom> {
  if (!game.modes.includes("room"))
    throw rpcPlatformFault("ROOM_MODE_UNAVAILABLE", "The game Manifest does not declare room mode");
  const check = () => {
    if (cancelled()) throw rpcPlatformFault("ROOM_CREATION_CANCELLED", "Room creation was cancelled");
  };
  try {
    check();
    const nickname = await waitForIdentity(); check();
    await api.createGuestSession(nickname); check();
    const room = await api.createRoom(game.manifestUrl); check();
    return room;
  } catch (error) {
    if (error instanceof RpcFault) throw error;
    const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
    throw rpcPlatformFault("ROOM_CREATION_FAILED", error instanceof Error ? error.message : "Could not create the room",
      typeof status !== "number" || status >= 500 || status === 408 || status === 429);
  }
}
