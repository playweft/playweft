import * as api from "@/platform/platform-api";
import { loadGameManifest, manifestUrlFromInput, roomInitializationForServer, type LoadedGame } from "./game-manifest";
import { RoomSession, initialRoomState, type RoomSessionState, type RoomServices, type RoomMessageKey, type RoomSessionError } from "@/features/room/RoomSession";
import { gameRoomState } from "@/features/room/room-lobby-bridge";
import { RpcFault, rpcPlatformFault } from "@/platform/json-rpc";
import type { GameRoomState } from "@playweft/game-protocol";

/** A running iframe owns at most one room; URL changes do not replace the iframe. */
export class GameRoomManager {
  session?: RoomSession;
  private pending?: { target: string; promise: Promise<GameRoomState> };
  private generation = 0;
  private disposed = false;
  private errorListeners = new Set<(error: RoomSessionError) => void>();
  private listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  constructor(readonly game: LoadedGame, private options: {
    waitForIdentity(): Promise<string>;
    nickname(): string;
    message(key: RoomMessageKey): string;
    onRoomChange(roomId?: string): void;
  }, private services: RoomServices & Pick<typeof api, "createRoom"> = { ...api, loadGameManifest, manifestUrlFromInput }) {}
  getState = (): RoomSessionState => this.session?.getState() ?? initialRoomState;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  subscribeErrors = (listener: (error: RoomSessionError) => void) => {
    this.errorListeners.add(listener); return () => { this.errorListeners.delete(listener); };
  };
  private emit() { for (const listener of this.listeners) listener(); }
  create(configuration: api.RoomCreateOptions = {}): Promise<GameRoomState> {
    return this.open("create", { lobby: "game", ...configuration });
  }
  join(roomId: string): Promise<GameRoomState> { return this.open(roomId); }
  private open(target: string, configuration?: api.RoomCreateOptions): Promise<GameRoomState> {
    if (this.disposed) return Promise.reject(rpcPlatformFault("BRIDGE_CLOSED", "The game was closed"));
    if (this.session?.getState().lifecycle === "joined") {
      if (target === "create" || target === this.session.roomId) return Promise.resolve(gameRoomState(this.session));
      return Promise.reject(rpcPlatformFault("ROOM_ALREADY_JOINED", "Leave the current room before joining another room"));
    }
    if (this.pending) return this.pending.target === target ? this.pending.promise :
      Promise.reject(rpcPlatformFault("ROOM_OPERATION_PENDING", "Another room operation is in progress"));
    const generation = this.generation;
    const check = () => { if (this.disposed || generation !== this.generation) throw rpcPlatformFault("BRIDGE_CLOSED", "The game bridge was replaced"); };
    const promise = (async () => {
      let createdId: string | undefined, current: RoomSession | undefined;
      try {
        const nickname = await this.options.waitForIdentity(); check();
        await this.services.createGuestSession(nickname); check();
        let roomId = target;
        if (target === "create") {
          const { server, ...roomConfiguration } = configuration ?? {};
          const initialization = server ? roomInitializationForServer(this.game.game, server) : this.game.room;
          if (!initialization) throw rpcPlatformFault("ROOM_SERVER_REQUIRED", "rooms.create requires a server descriptor");
          createdId = roomId = (await this.services.createRoom(this.game.game.manifestUrl, roomConfiguration, initialization)).roomId;
        }
        check();
        // Validate the target game before adding this player to the room.
        const launch = await this.services.getRoomLaunch(roomId); check();
        const loaded = await this.services.loadGameManifest(launch.manifestUrl); check();
        if (loaded.game.manifestId !== this.game.game.manifestId)
          throw rpcPlatformFault("ROOM_GAME_MISMATCH", "The room belongs to another game");
        current = new RoomSession(roomId, this.services, {
          nickname: this.options.nickname, message: this.options.message,
          onGameDiscovered: () => {},
          onEnd: () => {
            if (this.session !== current) return;
            // Subscribers observe the ended session before its reference is cleared.
            this.emit(); this.unsubscribe?.(); this.unsubscribe = undefined;
            this.session = undefined; this.emit(); this.options.onRoomChange();
          },
        });
        await current.enter(); check();
        if (current.getState().loadedGame?.game.manifestId !== this.game.game.manifestId ||
            current.getState().loadedGame?.game.version !== this.game.game.version)
          throw rpcPlatformFault("ROOM_GAME_MISMATCH", "Reload the game to join this room version");
        await current.activate(); check();
        if (current.getState().lifecycle !== "joined")
          throw rpcPlatformFault("ROOM_ENTRY_FAILED", current.getState().error ?? "Could not enter the room", true);
        this.session = current;
        let leavingChangedGame = false;
        const unsubscribeState = current.subscribe(() => {
          const loaded = current!.getState().loadedGame;
          if (!leavingChangedGame && (current!.getState().lifecycle === "entering" || (loaded && (loaded.game.manifestId !== this.game.game.manifestId || loaded.game.version !== this.game.game.version)))) {
            leavingChangedGame = true;
            void current!.leave();
          }
          this.emit();
        });
        const unsubscribeErrors = current.subscribeErrors(error => {
          for (const listener of this.errorListeners) listener(error);
        });
        this.unsubscribe = () => { unsubscribeState(); unsubscribeErrors(); };
        this.options.onRoomChange(roomId); this.emit();
        return gameRoomState(current);
      } catch (error) {
        if (current?.getState().lifecycle === "joined") await this.services.leaveRoom(current.roomId).catch(() => {});
        current?.dispose();
        if (createdId) await this.services.dissolveRoom(createdId).catch(() => {});
        if (error instanceof RpcFault) throw error;
        const failure = error as { code?: string; message?: string; status?: number };
        throw rpcPlatformFault(failure.code ?? "ROOM_ENTRY_FAILED", failure.message ?? "Could not enter the room",
          failure.status === undefined || failure.status >= 500 || failure.status === 408 || failure.status === 429);
      }
    })();
    this.pending = { target, promise };
    void promise.then(() => { if (this.pending?.promise === promise) this.pending = undefined; }, () => { if (this.pending?.promise === promise) this.pending = undefined; });
    return promise;
  }
  cancelPending() { this.generation++; this.pending = undefined; }
  dispose() {
    this.disposed = true; this.cancelPending(); this.unsubscribe?.();
    const session = this.session; this.session = undefined;
    if (session?.getState().lifecycle === "joined") void this.services.leaveRoom(session.roomId).catch(() => {});
    session?.dispose(); this.listeners.clear(); this.errorListeners.clear();
  }
}
