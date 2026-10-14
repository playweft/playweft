export * from "./timers";
export * from "./match";

import type { ActionError, JsonValue } from "@playweft/game-protocol";

export class GameRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameRuntimeError";
  }
}

export type GameTimerOperation =
  | {
      op: "schedule";
      id: string;
      afterMs: number;
      payload?: JsonValue;
    }
  | {
      op: "cancel";
      id: string;
    };

export interface GameTransitionResult {
  state: JsonValue;
  events: JsonValue[];
  /** Authoritative timer mutations to commit with this state transition. */
  timerOps?: GameTimerOperation[];
}

export type GameActionResult =
  | ({ accepted: true } & GameTransitionResult)
  | { accepted: false; error: ActionError };

export interface GameRuntime {
  setup(context: JsonValue): GameTransitionResult;
  applyAction(
    state: JsonValue,
    action: JsonValue,
    context: JsonValue,
  ): GameActionResult;
  view(
    state: JsonValue,
    events: JsonValue[],
    context: JsonValue,
  ): GameTransitionResult;
  playerLeft(state: JsonValue, context: JsonValue): GameTransitionResult;
  onTimer(
    state: JsonValue,
    timer: JsonValue,
    context: JsonValue,
  ): GameTransitionResult;
  returnToRoom(state: JsonValue, context: JsonValue): boolean;
  dispose(): void;
}

export interface GameRuntimeAdapter {
  readonly kind: string;
  create(source: string): Promise<GameRuntime>;
}
