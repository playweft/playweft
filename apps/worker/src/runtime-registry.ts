import "@playweft/runtime-lua/wasm";
import { LuaGameRuntime } from "@playweft/runtime-lua";
import type { GameRuntime, GameRuntimeAdapter } from "@playweft/runtime-core";

export type RuntimeKind = "lua";

const runtimes: Record<RuntimeKind, GameRuntimeAdapter> = {
  lua: {
    kind: "lua",
    create: LuaGameRuntime.create,
  },
};

export function isRuntimeKind(value: string): value is RuntimeKind {
  return value in runtimes;
}

export function createRuntime(kind: RuntimeKind, source: string): Promise<GameRuntime> {
  return runtimes[kind].create(source);
}
