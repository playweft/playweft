import { assertJsonSize, type JsonValue, type RoomLocalRuntime, type RoomPresence, type RoomSnapshot } from "@playweft/game-protocol";
import { actionContext, applyTimerOps, assertTimerSupport, compareTimers, consumeTimerBudget, initialTimerBudget,
  projectSnapshot, roomActor, type GameRuntime, type GameTransitionResult, type RoomTimer } from "@playweft/runtime-core";

/** Browser authority uses the same runtime, contexts, projections and timer rules as the Worker. */
export class LuaHost {
  private state: JsonValue;
  private events: JsonValue[];
  private version = 0;
  private timers: RoomTimer[];
  private budget;
  private results = new Map<string, { action: string; result: JsonValue }>();
  constructor(private runtime: GameRuntime, private boot: RoomLocalRuntime, private presence: RoomPresence) {
    const setup = runtime.setup(boot.context);
    assertJsonSize(setup.state, "initial state", 64 * 1024);
    this.assertTimers(setup);
    this.state = setup.state; this.events = setup.events;
    this.timers = applyTimerOps([], setup.timerOps ?? [], boot.startedAt);
    this.budget = initialTimerBudget(boot.startedAt);
  }
  setPresence(presence: RoomPresence): boolean {
    const removed = [...this.presence.players, ...this.presence.spectators]
      .filter(member => ![...presence.players, ...presence.spectators].some(next => next.id === member.id));
    const previous = this.presence;
    const changed = previous.ownerId !== presence.ownerId ||
      JSON.stringify([...previous.players, ...previous.spectators]) !== JSON.stringify([...presence.players, ...presence.spectators]);
    this.presence = presence;
    for (const member of removed) {
      const now = Date.now();
      this.commit(this.runtime.playerLeft(this.state, { protocolVersion: 1, matchId: this.boot.matchId,
        version: this.version, leftAt: now, serverTime: now,
        actor: roomActor(member, member.id === previous.ownerId) }), now);
    }
    if (changed && !removed.length) this.version++;
    return changed;
  }
  act(actorId: string, id: string, action: JsonValue): JsonValue {
    const key = `${actorId}:${id}`, encoded = JSON.stringify(action), old = this.results.get(key);
    if (old) return old.action === encoded ? old.result : this.reject("REQUEST_ID_REUSED", "Request id was reused");
    if (this.results.size >= 8192) return this.reject("MATCH_LIMIT", "Start a new match");
    try { assertJsonSize(action, "action", 8 * 1024); }
    catch { return this.reject("ACTION_TOO_LARGE", "Action is too large"); }
    const now = Date.now(); this.advance(now);
    const member = [...this.presence.players, ...this.presence.spectators].find(member => member.id === actorId);
    if (!member) return this.reject("NOT_A_MEMBER", "Player is not in this room");
    const result = this.runtime.applyAction(this.state, action, actionContext(this.boot.matchId, this.version,
      id, now, now, roomActor(member, actorId === this.presence.ownerId)));
    if (result.accepted) this.commit(result, now);
    const response: JsonValue = { type: "action-result", requestId: id, accepted: result.accepted,
      matchId: this.boot.matchId, version: this.version, ...(!result.accepted ? { error: result.error as unknown as JsonValue } : {}) };
    this.results.set(key, { action: encoded, result: response });
    return response;
  }
  advance(now: number): boolean {
    let changed = false;
    for (let count = 0; count < 16; count++) {
      const timer = this.timers.find(timer => timer.dueAt <= now); if (!timer) break;
      const budget = consumeTimerBudget(this.budget, now); this.budget = budget.budget;
      if (!budget.allowed) { timer.dueAt = budget.nextAllowedAt; this.timers.sort(compareTimers); break; }
      const result = this.runtime.onTimer(this.state,
        { id: timer.id, ...(timer.payload === undefined ? {} : { payload: timer.payload }) },
        { protocolVersion: 1, matchId: this.boot.matchId, version: this.version, dueAt: timer.dueAt,
          firedAt: now, lateByMs: Math.max(0, now - timer.dueAt) });
      this.commit(result, now, timer.id); changed = true;
    }
    return changed;
  }
  returnToRoom(actorId: string): boolean {
    const member = [...this.presence.players, ...this.presence.spectators].find(member => member.id === actorId);
    if (!member || actorId !== this.presence.ownerId) return false;
    const now = Date.now(); this.advance(now);
    return this.runtime.returnToRoom(this.state, { protocolVersion: 1, matchId: this.boot.matchId,
      version: this.version, serverTime: now, actor: roomActor(member, true) });
  }
  snapshot(viewerId: string): RoomSnapshot {
    const viewer = [...this.presence.players, ...this.presence.spectators].find(member => member.id === viewerId);
    if (!viewer) throw new Error("Viewer is not in this room");
    return projectSnapshot(this.runtime, { type: "snapshot", state: this.state, events: this.events,
      matchId: this.boot.matchId, version: this.version, serverTime: Date.now(), scriptHash: this.boot.scriptHash },
      roomActor(viewer, viewerId === this.presence.ownerId));
  }
  dispose(): void { this.runtime.dispose(); }
  private commit(result: GameTransitionResult, now: number, firedTimer?: string): void {
    assertJsonSize(result.state, "state", 64 * 1024); this.assertTimers(result);
    const timers = applyTimerOps(this.timers.filter(timer => timer.id !== firedTimer), result.timerOps ?? [], now);
    this.state = result.state; this.events = result.events; this.timers = timers; this.version++;
  }
  private assertTimers(result: GameTransitionResult): void {
    assertTimerSupport(this.boot.liveRoom, result.timerOps ?? []);
  }
  private reject(code: string, message: string): JsonValue { return { accepted: false, error: { code, message } }; }
}
