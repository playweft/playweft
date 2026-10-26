import { JsonRpcErrorCode, parseRoomServer, type GameRoomState, type JsonValue } from "@playweft/game-protocol";
import { RpcFault, rpcPlatformFault, type RpcHandlers } from "@/platform/json-rpc";
import type { RoomConfiguration, RoomCreateOptions } from "@/platform/platform-api";
import type { RoomSession } from "./RoomSession";

export const ROOM_LOBBY_CAPABILITIES = ["room.getState", "room.setConfiguration", "room.setReady", "room.setSeat", "room.start", "room.leave"];

export function gameRoomState(session: RoomSession): GameRoomState {
  const { presence, selfId, lifecycle } = session.getState();
  if (lifecycle !== "joined" || !presence || !selfId)
    throw rpcPlatformFault("ROOM_CLOSED", "The room is unavailable");
  const player = presence.players.find(member => member.id === selfId);
  const inLobby = presence.phase === "lobby";
  return {
    roomId: session.roomId, revision: presence.revision, phase: presence.phase,
    ownerId: presence.ownerId, selfId,
    players: presence.players.map(({ id, seat, ready }) => ({ id, seat, ready: ready === true })),
    spectators: presence.spectators.map(({ id }) => ({ id })),
    minPlayers: presence.minPlayers, maxPlayers: presence.maxPlayers,
    lobby: presence.lobby ?? (session.getState().loadedGame?.manifest.room ? "game" : "platform"),
    inviteUrl: new URL(`/r/${encodeURIComponent(session.roomId)}`, window.location.origin).href,
    permissions: {
      setConfiguration: inLobby && selfId === presence.ownerId,
      setReady: inLobby && !!player && selfId !== presence.ownerId,
      setSeat: inLobby,
      start: inLobby && selfId === presence.ownerId && presence.players.length >= presence.minPlayers &&
        presence.players.every(member => member.id === presence.ownerId || member.ready),
      leave: true,
    },
  };
}

function paramsObject(params: JsonValue | undefined, keys: string[]): Record<string, JsonValue> {
  const value = params === undefined && keys.length === 0 ? {} : params;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || keys.some(key => !(key in value)))
    throw new RpcFault(JsonRpcErrorCode.InvalidParams, `Expected { ${keys.join(", ")} }`);
  return value;
}

export function roomConfigurationFromRpcParams(params: JsonValue | undefined, optional = false): Partial<RoomConfiguration> {
  const value = params === undefined && optional ? {} : params;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => key !== "minPlayers" && key !== "maxPlayers" && key !== "lobby") ||
      Object.entries(value).some(([key, entry]) => key === "lobby"
        ? entry !== "game" && entry !== "platform"
        : typeof entry !== "number" || !Number.isInteger(entry) || entry < 1 || entry > 32) ||
      (typeof value.minPlayers === "number" && typeof value.maxPlayers === "number" && value.minPlayers > value.maxPlayers))
    throw new RpcFault(JsonRpcErrorCode.InvalidParams, "Expected { minPlayers?, maxPlayers?, lobby? }; limits must be ordered integers from 1 to 32");
  return value as Partial<RoomConfiguration>;
}

export function roomCreateOptionsFromRpcParams(params: JsonValue | undefined): RoomCreateOptions {
  if (params === undefined) return {};
  if (!params || typeof params !== "object" || Array.isArray(params))
    throw new RpcFault(JsonRpcErrorCode.InvalidParams, "rooms.create expects an options object");
  const { server, ...configuration } = params;
  const options: RoomCreateOptions = roomConfigurationFromRpcParams(configuration);
  if (server !== undefined) {
    try { options.server = parseRoomServer(server); }
    catch (error) { throw new RpcFault(JsonRpcErrorCode.InvalidParams, error instanceof Error ? error.message : "Invalid server"); }
  }
  return options;
}

export function createRoomLobbyHandlers(session: RoomSession, assertBridgeOpen: () => void): RpcHandlers {
  const check = (permission?: keyof GameRoomState["permissions"]) => {
    assertBridgeOpen();
    const state = gameRoomState(session);
    if (permission && !state.permissions[permission])
      throw rpcPlatformFault("ROOM_OPERATION_NOT_ALLOWED", "This room operation is not currently allowed");
    return state;
  };
  const done = (success: boolean) => {
    assertBridgeOpen();
    if (!success) throw rpcPlatformFault("ROOM_OPERATION_FAILED", session.getState().error ?? "The room operation failed", true);
    return gameRoomState(session);
  };
  return {
    "room.setConfiguration": { async handle(params) {
      const configuration = roomConfigurationFromRpcParams(params);
      check("setConfiguration");
      return done(await session.setConfiguration(configuration));
    } },
    "room.getState": { handle(params) { paramsObject(params, []); return check(); } },
    "room.setReady": { async handle(params) {
      const { ready } = paramsObject(params, ["ready"]);
      if (typeof ready !== "boolean") throw new RpcFault(JsonRpcErrorCode.InvalidParams, "ready must be boolean");
      const state = check("setReady");
      if (state.players.find(player => player.id === state.selfId)?.ready === ready) return state;
      return done(await session.setReady(ready));
    } },
    "room.setSeat": { async handle(params) {
      const { seat } = paramsObject(params, ["seat"]);
      const state = check("setSeat");
      if (seat !== null && (typeof seat !== "number" || !Number.isInteger(seat) || seat < 1 || seat > state.maxPlayers))
        throw new RpcFault(JsonRpcErrorCode.InvalidParams, "seat must be null or an available seat number");
      return done(await session.chooseSeat(seat as number | null));
    } },
    "room.start": { async handle(params) { paramsObject(params, []); check("start"); return done(await session.start()); } },
    "room.leave": { async handle(params) {
      paramsObject(params, []); check("leave"); await session.leave();
      if (session.getState().lifecycle !== "ended")
        throw rpcPlatformFault("ROOM_OPERATION_FAILED", session.getState().error ?? "Could not leave the room", true);
      return null;
    } },
  };
}
