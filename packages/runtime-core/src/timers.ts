import { assertJsonSize, type JsonValue } from "@playweft/game-protocol";
import { GameRuntimeError, type GameTimerOperation } from "./index";

const MAX_PENDING_TIMERS = 32;
const MAX_TIMER_PAYLOAD_BYTES = 8 * 1024;
const MAX_TIMER_PAYLOAD_TOTAL_BYTES = 32 * 1024;
const TIMER_BUDGET_CAPACITY = 16;
const TIMER_BUDGET_REFILL_MS = 5_000;
const MAX_TIMER_FIRES_PER_DAY = 2_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

export interface RoomTimer {
  id: string;
  dueAt: number;
  payload?: JsonValue;
}

export interface TimerBudget {
  tokens: number;
  updatedAt: number;
  dayStart: number;
  firedToday: number;
}

type TimerBudgetConsumption =
  | { allowed: true; budget: TimerBudget }
  | { allowed: false; budget: TimerBudget; nextAllowedAt: number };

export function applyTimerOps(
  existing: RoomTimer[],
  operations: GameTimerOperation[],
  scheduledAt: number,
): RoomTimer[] {
  const timers = new Map(existing.map((timer) => [timer.id, timer]));
  for (const operation of operations) {
    if (operation.op === "cancel") {
      timers.delete(operation.id);
      continue;
    }
    if (operation.payload !== undefined) {
      assertJsonSize(
        operation.payload,
        `timer ${operation.id} payload`,
        MAX_TIMER_PAYLOAD_BYTES,
      );
    }
    timers.set(operation.id, {
      id: operation.id,
      dueAt: scheduledAt + operation.afterMs,
      ...(operation.payload === undefined
        ? {}
        : { payload: operation.payload }),
    });
  }
  if (timers.size > MAX_PENDING_TIMERS) {
    throw new GameRuntimeError(
      `a room may have at most ${MAX_PENDING_TIMERS} pending timers`,
    );
  }
  const result = [...timers.values()].sort(compareTimers);
  const payloadBytes = result.reduce(
    (total, timer) =>
      total +
      (timer.payload === undefined
        ? 0
        : new TextEncoder().encode(JSON.stringify(timer.payload)).byteLength),
    0,
  );
  if (payloadBytes > MAX_TIMER_PAYLOAD_TOTAL_BYTES) {
    throw new GameRuntimeError(
      `timer payloads exceed the ${MAX_TIMER_PAYLOAD_TOTAL_BYTES}-byte room limit`,
    );
  }
  return result;
}



export function compareTimers(left: RoomTimer, right: RoomTimer): number {
  return left.dueAt - right.dueAt || left.id.localeCompare(right.id);
}

export function initialTimerBudget(now: number): TimerBudget {
  return {
    tokens: TIMER_BUDGET_CAPACITY,
    updatedAt: now,
    dayStart: utcDayStart(now),
    firedToday: 0,
  };
}

export function consumeTimerBudget(
  stored: TimerBudget,
  now: number,
): TimerBudgetConsumption {
  const dayStart = utcDayStart(now);
  const firedToday = stored.dayStart === dayStart ? stored.firedToday : 0;
  const tokens = Math.min(
    TIMER_BUDGET_CAPACITY,
    stored.tokens +
      Math.max(0, now - stored.updatedAt) / TIMER_BUDGET_REFILL_MS,
  );
  if (firedToday >= MAX_TIMER_FIRES_PER_DAY) {
    return {
      allowed: false,
      budget: { tokens, updatedAt: now, dayStart, firedToday },
      nextAllowedAt: dayStart + DAY_MS,
    };
  }
  if (tokens < 1) {
    return {
      allowed: false,
      budget: { tokens, updatedAt: now, dayStart, firedToday },
      nextAllowedAt: now + Math.ceil((1 - tokens) * TIMER_BUDGET_REFILL_MS),
    };
  }
  return {
    allowed: true,
    budget: {
      tokens: tokens - 1,
      updatedAt: now,
      dayStart,
      firedToday: firedToday + 1,
    },
  };
}

function utcDayStart(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

export function assertTimerSupport(liveRoom: boolean, operations: GameTimerOperation[]): void {
  if (liveRoom && operations.length > 0) {
    throw new GameRuntimeError("timerOps require persisted room storage; live rooms cannot schedule timers");
  }
}
