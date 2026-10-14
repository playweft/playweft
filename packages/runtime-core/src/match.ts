import type { JsonValue, RoomSnapshot } from "@playweft/game-protocol";
import type { GameRuntime } from "./index";

export type GameActor = { [key: string]: JsonValue; id: string; role: "player" | "spectator"; isOwner: boolean };
export function roomActor(member: { id: string; name?: string; seat?: number }, isOwner: boolean): GameActor {
  return { id: member.id, ...(member.name ? { name: member.name } : {}),
    role: member.seat === undefined ? "spectator" : "player",
    ...(member.seat === undefined ? {} : { seat: member.seat }), isOwner };
}
export function setupContext(match: { id: string; startedAt: number; randomSeed: string }, ownerId: string,
  players: Array<{ id: string; name?: string; seat: number }>): JsonValue {
  return { protocolVersion: 1, serverTime: match.startedAt, match: { ...match, ownerId },
    players: players.map(({ id, name, seat }) => ({ id, ...(name ? { name } : {}), seat })) };
}
export function actionContext(matchId: string, version: number, actionId: string, actionAt: number,
  serverTime: number, actor: GameActor): JsonValue {
  return { protocolVersion: 1, matchId, version, actionId, actionAt, serverTime, actor };
}
/** Both authorities must project state and events through the game's view handler. */
export function projectSnapshot(engine: GameRuntime, snapshot: RoomSnapshot, viewer: GameActor): RoomSnapshot {
  const visible = engine.view(snapshot.state, snapshot.events ?? [], {
    protocolVersion: 1, matchId: snapshot.matchId, version: snapshot.version,
    serverTime: snapshot.serverTime, viewer,
  });
  return { ...snapshot, state: visible.state, events: visible.events };
}
