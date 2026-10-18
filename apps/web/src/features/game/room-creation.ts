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

/** One solo game owns its transition; concurrent RPC calls share one room. */
export class SoloRoomCreation {
  private generation = 0;
  private closed = false;
  private entered = false;
  private pending?: Promise<platformApi.CreatedRoom>;
  private room?: platformApi.CreatedRoom;
  private navigationTimer?: number;
  constructor(
    private game: DiscoveredGame,
    private options: {
      waitForIdentity(): Promise<string>;
      onEnterRoom(roomId: string): void;
      onPendingChange(pending: boolean): void;
      isCancelled(): boolean;
    },
    private api: RoomApi = platformApi,
  ) {}
  create(): Promise<platformApi.CreatedRoom> {
    if (this.closed || this.options.isCancelled())
      return Promise.reject(rpcPlatformFault("ROOM_CREATION_CANCELLED", "The solo game was closed"));
    if (this.pending) return this.pending;
    const generation = this.generation;
    this.options.onPendingChange(true);
    const cancelled = () => this.closed || generation !== this.generation || this.options.isCancelled();
    const pending = createGameRoom(this.game, this.options.waitForIdentity, cancelled, this.api)
      .then(room => {
        if (cancelled()) throw rpcPlatformFault("ROOM_CREATION_CANCELLED", "Room creation was cancelled");
        this.room = room; return room;
      })
      .catch(error => { if (this.pending === pending) this.pending = undefined; throw error; })
      .finally(() => {
        if (!this.closed && generation === this.generation) this.options.onPendingChange(false);
      });
    this.pending = pending;
    return pending;
  }
  enter(expectedRoomId?: string): void {
    if (expectedRoomId && this.room?.roomId !== expectedRoomId) return;
    if (!this.room || this.closed || this.entered || this.navigationTimer !== undefined || this.options.isCancelled()) return;
    const roomId = this.room.roomId, generation = this.generation;
    // Let the RPC response reach the game before replacing its iframe.
    this.navigationTimer = window.setTimeout(() => {
      this.navigationTimer = undefined;
      if (!this.closed && generation === this.generation && !this.options.isCancelled()) {
        this.entered = true;
        this.options.onEnterRoom(roomId);
      }
    }, 0);
  }
  cancel(): void {
    this.generation++;
    this.pending = undefined; this.room = undefined; this.entered = false;
    window.clearTimeout(this.navigationTimer); this.navigationTimer = undefined;
    if (!this.closed) this.options.onPendingChange(false);
  }
  dispose(): void { this.closed = true; this.cancel(); }
}
