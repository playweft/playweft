import { LuaFactory, LuaGlobal, LuaLibraries, LuaType } from "wasmoon";
import type LuaWasm from "wasmoon/dist/luawasm";
import {
  assertJson,
  assertJsonSize,
  JSON_MAX_DEPTH,
  type JsonValue,
} from "@playweft/game-protocol";
import {
  GameRuntimeError,
  type GameActionResult,
  type GameRuntime,
  type GameTimerOperation,
  type GameTransitionResult,
} from "@playweft/runtime-core";


const LUA_REGISTRY_INDEX = -1_001_000;
const LUA_MULTRET = -1;
const MAX_DEPTH = JSON_MAX_DEPTH;
const MAX_TABLE_ENTRIES = 2_048;
const MAX_SCRIPT_BYTES = 256 * 1024;
const MAX_VALUE_BYTES = 64 * 1024;
const FUEL_LIMIT = 50_000;
const MAX_TIMER_OPS = 32;
const MAX_TIMER_PAYLOAD_BYTES = 8 * 1024;
const MIN_TIMER_DELAY_MS = 100;
const MAX_TIMER_DELAY_MS = 60 * 60 * 1_000;
const TIMER_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/;

let luaModulePromise: Promise<LuaWasm> | undefined;

function getLuaModule(): Promise<LuaWasm> {
  luaModulePromise ??= new LuaFactory().getLuaModule();
  return luaModulePromise;
}

export class LuaScriptError extends GameRuntimeError {
  constructor(message: string) {
    super(message);
    this.name = "LuaScriptError";
  }
}

/**
 * Lua's debug hook is installed before game code is evaluated, then its only
 * reference stays in a lexical closure. User scripts cannot reset the fuel
 * counter because `debug` is removed before their source runs.
 */
function wrapGameSource(source: string): string {
  return `
local __playweft_fuel = 0
local __playweft_fuel_step = 1000
local __playweft_fuel_limit = ${FUEL_LIMIT}

debug.sethook(function()
  __playweft_fuel = __playweft_fuel + __playweft_fuel_step
  if __playweft_fuel > __playweft_fuel_limit then
    error("instruction quota exceeded", 0)
  end
end, "", __playweft_fuel_step)

debug = nil
collectgarbage = nil
dofile = nil
load = nil
loadfile = nil
print = nil
warn = nil
io = nil
os = nil
package = nil
require = nil
coroutine = nil
math.random = nil
math.randomseed = nil

${source}

if type(setup) ~= "function" or type(on_action) ~= "function" or type(view) ~= "function" then
  error("Lua game must define setup(context), on_action(state, action, context), and view(state, events, context)", 0)
end

local __playweft_has_timer_handler = type(on_timer) == "function"
local function __playweft_transition(result)
  if not __playweft_has_timer_handler and type(result) == "table" and result.timerOps ~= nil then
    error("on_timer must be defined before this game can schedule timers", 0)
  end
  return result
end

return function(kind, state, action, context)
  __playweft_fuel = 0
  if kind == "setup" then
    return __playweft_transition(setup(context))
  end
  if kind == "player_left" then
    if on_player_left == nil then
      return { state = state, events = {} }
    end
    return __playweft_transition(on_player_left(state, context))
  end
  if kind == "view" then
    return view(state, action, context)
  end
  if kind == "return_to_room" then
    if on_return_to_room == nil then
      return false
    end
    return on_return_to_room(state, context)
  end
  if kind == "timer" then
    if not __playweft_has_timer_handler then
      error("on_timer must be defined before this game can schedule timers", 0)
    end
    return __playweft_transition(on_timer(state, action, context))
  end
  return __playweft_transition(on_action(state, action, context))
end
`;
}

class LuaJsonBridge {
  constructor(
    private readonly global: LuaGlobal,
    private readonly module: LuaWasm,
  ) {}

  push(value: JsonValue): void {
    const state = this.global.address;

    if (value === null) {
      this.module.lua_pushnil(state);
      return;
    }
    if (typeof value === "boolean") {
      this.module.lua_pushboolean(state, value ? 1 : 0);
      return;
    }
    if (typeof value === "number") {
      if (Number.isSafeInteger(value)) {
        this.module.lua_pushinteger(state, BigInt(value));
      } else {
        this.module.lua_pushnumber(state, value);
      }
      return;
    }
    if (typeof value === "string") {
      this.module.lua_pushstring(state, value);
      return;
    }
    if (Array.isArray(value)) {
      this.module.lua_createtable(state, value.length, 0);
      for (let index = 0; index < value.length; index += 1) {
        this.push(value[index]!);
        this.module.lua_rawseti(state, -2, BigInt(index + 1));
      }
      return;
    }

    const entries = Object.entries(value);
    this.module.lua_createtable(state, 0, entries.length);
    for (const [key, item] of entries) {
      this.push(item);
      this.module.lua_setfield(state, -2, key);
    }
  }

  read(index: number): JsonValue {
    return this.readInner(index, 0, new Set<number>());
  }

  private readInner(
    index: number,
    depth: number,
    visited: Set<number>,
  ): JsonValue {
    if (depth > MAX_DEPTH) {
      throw new LuaScriptError(
        `Lua result exceeds the ${MAX_DEPTH}-level nesting limit`,
      );
    }

    const state = this.global.address;
    const absoluteIndex = this.module.lua_absindex(state, index);
    const type = this.module.lua_type(state, absoluteIndex);

    switch (type) {
      case LuaType.Nil:
        return null;
      case LuaType.Boolean:
        return Boolean(this.module.lua_toboolean(state, absoluteIndex));
      case LuaType.Number: {
        const number = this.module.lua_tonumberx(state, absoluteIndex, null);
        if (!Number.isFinite(number))
          throw new LuaScriptError("Lua result contains a non-finite number");
        return number;
      }
      case LuaType.String:
        return this.module.lua_tolstring(state, absoluteIndex, null);
      case LuaType.Table:
        return this.readTable(absoluteIndex, depth, visited);
      default:
        throw new LuaScriptError(
          `Lua result contains unsupported ${this.module.lua_typename(state, type)} data`,
        );
    }
  }

  private readTable(
    index: number,
    depth: number,
    visited: Set<number>,
  ): JsonValue {
    const state = this.global.address;
    const pointer = this.module.lua_topointer(state, index);
    if (visited.has(pointer))
      throw new LuaScriptError("Lua result contains a cyclic table");
    visited.add(pointer);

    const object: Record<string, JsonValue> = {};
    const array = new Map<number, JsonValue>();
    let entries = 0;

    this.module.lua_pushnil(state);
    while (this.module.lua_next(state, index) !== 0) {
      entries += 1;
      if (entries > MAX_TABLE_ENTRIES) {
        this.global.pop(1);
        visited.delete(pointer);
        throw new LuaScriptError(
          `Lua table exceeds the ${MAX_TABLE_ENTRIES}-entry limit`,
        );
      }

      const keyType = this.module.lua_type(state, -2);
      const value = this.readInner(-1, depth + 1, visited);

      if (keyType === LuaType.String) {
        object[this.module.lua_tolstring(state, -2, null)] = value;
      } else if (keyType === LuaType.Number) {
        const numericKey = this.module.lua_tonumberx(state, -2, null);
        if (!Number.isInteger(numericKey) || numericKey < 1) {
          this.global.pop(1);
          visited.delete(pointer);
          throw new LuaScriptError(
            "Lua tables may only use positive integer or string keys",
          );
        }
        array.set(numericKey, value);
      } else {
        this.global.pop(1);
        visited.delete(pointer);
        throw new LuaScriptError(
          "Lua tables may only use positive integer or string keys",
        );
      }

      // lua_next keeps the key on the stack; pop only the value.
      this.global.pop(1);
    }

    visited.delete(pointer);
    if (array.size === 0) return object;
    if (Object.keys(object).length > 0) {
      throw new LuaScriptError("Lua tables cannot mix array and object keys");
    }

    const result: JsonValue[] = [];
    for (let index = 1; index <= array.size; index += 1) {
      const item = array.get(index);
      if (item === undefined)
        throw new LuaScriptError("Lua arrays must not be sparse");
      result.push(item);
    }
    return result;
  }
}

export class LuaGameRuntime implements GameRuntime {
  private readonly bridge: LuaJsonBridge;
  private readonly functionRef: number;

  private constructor(
    private readonly global: LuaGlobal,
    private readonly module: LuaWasm,
    functionRef: number,
  ) {
    this.bridge = new LuaJsonBridge(global, module);
    this.functionRef = functionRef;
  }

  static async create(source: string): Promise<LuaGameRuntime> {
    if (new TextEncoder().encode(source).byteLength > MAX_SCRIPT_BYTES) {
      throw new LuaScriptError(
        `Lua source exceeds the ${MAX_SCRIPT_BYTES}-byte limit`,
      );
    }

    const module = await getLuaModule();
    const global = new LuaGlobal(module, false);

    try {
      global.loadLibrary(LuaLibraries.Base);
      global.loadLibrary(LuaLibraries.Table);
      global.loadLibrary(LuaLibraries.String);
      global.loadLibrary(LuaLibraries.Math);
      global.loadLibrary(LuaLibraries.Debug);
      module.lua_setcstacklimit(global.address, 64);

      global.loadString(wrapGameSource(source), "game.lua");
      const status = module.lua_pcallk(global.address, 0, 1, 0, 0, null);
      if (status !== 0) {
        throw readLuaError(global, module);
      }

      if (module.lua_type(global.address, -1) !== LuaType.Function) {
        throw new LuaScriptError(
          "Lua game must define setup(context), on_action(state, action, context), and view(state, events, context)",
        );
      }

      const functionRef = module.luaL_ref(global.address, LUA_REGISTRY_INDEX);
      return new LuaGameRuntime(global, module, functionRef);
    } catch (error) {
      global.close();
      throw error;
    }
  }

  setup(context: JsonValue): GameTransitionResult {
    const result = this.invoke("setup", null, null, context)[0];
    // Keep older games deployable while allowing newer games to opt into
    // transition metadata such as authoritative timer operations.
    if (result === undefined) {
      return this.transitionResult(result, "setup");
    }
    if (!isPlainObject(result) || !("state" in result)) {
      return this.transitionResult({ state: result, events: [] }, "setup");
    }
    return this.transitionResult(result, "setup");
  }

  applyAction(
    state: JsonValue,
    action: JsonValue,
    context: JsonValue,
  ): GameActionResult {
    const result = this.invoke("action", state, action, context)[0];
    if (!isPlainObject(result) || typeof result.accepted !== "boolean") {
      throw new LuaScriptError(
        "on_action must return either { accepted = true, state = ..., events = {...} } or { accepted = false, error = { code = ..., message = ... } }",
      );
    }
    if (!result.accepted) {
      if (
        !isPlainObject(result.error) ||
        typeof result.error.code !== "string" ||
        !/^[A-Z][A-Z0-9_]{0,63}$/.test(result.error.code) ||
        typeof result.error.message !== "string" ||
        result.error.message.length === 0 ||
        result.error.message.length > 500
      ) {
        throw new LuaScriptError(
          "rejected on_action result.error must contain an uppercase code and a 1-500 character message",
        );
      }
      return {
        accepted: false,
        error: {
          code: result.error.code,
          message: result.error.message,
        },
      };
    }
    return {
      accepted: true,
      ...this.transitionResult(result, "on_action"),
    };
  }

  view(
    state: JsonValue,
    events: JsonValue[],
    context: JsonValue,
  ): GameTransitionResult {
    const result = this.invoke("view", state, events, context)[0];
    return this.transitionResult(result, "view", false);
  }

  playerLeft(state: JsonValue, context: JsonValue): GameTransitionResult {
    const result = this.invoke("player_left", state, null, context)[0];
    return this.transitionResult(result, "on_player_left");
  }

  onTimer(
    state: JsonValue,
    timer: JsonValue,
    context: JsonValue,
  ): GameTransitionResult {
    const result = this.invoke("timer", state, timer, context)[0];
    return this.transitionResult(result, "on_timer");
  }

  returnToRoom(state: JsonValue, context: JsonValue): boolean {
    const result = this.invoke("return_to_room", state, null, context)[0];
    if (typeof result !== "boolean")
      throw new LuaScriptError("on_return_to_room must return true or false");
    return result;
  }

  private transitionResult(
    result: JsonValue | undefined,
    handler: string,
    allowTimerOps = true,
  ): GameTransitionResult {
    if (!isPlainObject(result) || !("state" in result)) {
      throw new LuaScriptError(
        `${handler} must return { state = ..., events = {...} }`,
      );
    }

    // Lua has no native distinction between {} and an empty array. In the
    // explicitly array-shaped `events` field, treat an empty table as [].
    const events = isEmptyObject(result.events) ? [] : (result.events ?? []);
    if (!Array.isArray(events))
      throw new LuaScriptError(`${handler} result.events must be an array`);
    assertJson(result.state, `${handler} result.state`);
    assertJson(events, `${handler} result.events`);
    assertJsonSize(result.state, `${handler} result.state`, MAX_VALUE_BYTES);
    assertJsonSize(events, `${handler} result.events`, 16 * 1024);
    if (!allowTimerOps && "timerOps" in result) {
      throw new LuaScriptError(`${handler} must not return timerOps`);
    }
    const timerOps = allowTimerOps
      ? this.timerOps(result.timerOps, handler)
      : undefined;
    return {
      state: result.state,
      events,
      ...(timerOps?.length ? { timerOps } : {}),
    };
  }

  private timerOps(
    value: JsonValue | undefined,
    handler: string,
  ): GameTimerOperation[] {
    if (value === undefined || isEmptyObject(value)) return [];
    if (!Array.isArray(value))
      throw new LuaScriptError(`${handler} result.timerOps must be an array`);
    if (value.length > MAX_TIMER_OPS) {
      throw new LuaScriptError(
        `${handler} result.timerOps exceeds the ${MAX_TIMER_OPS}-operation limit`,
      );
    }
    const ids = new Set<string>();
    return value.map((operation, index) => {
      if (!isPlainObject(operation)) {
        throw new LuaScriptError(
          `${handler} result.timerOps[${index}] must be an object`,
        );
      }
      if (
        typeof operation.id !== "string" ||
        !TIMER_ID_PATTERN.test(operation.id)
      ) {
        throw new LuaScriptError(
          `${handler} result.timerOps[${index}].id is invalid`,
        );
      }
      if (ids.has(operation.id)) {
        throw new LuaScriptError(
          `${handler} result.timerOps must not contain duplicate timer ids`,
        );
      }
      ids.add(operation.id);
      if (operation.op === "cancel") {
        if (Object.keys(operation).some((key) => key !== "op" && key !== "id")) {
          throw new LuaScriptError(
            `${handler} result.timerOps[${index}] cancel accepts only op and id`,
          );
        }
        return { op: "cancel", id: operation.id };
      }
      if (operation.op !== "schedule") {
        throw new LuaScriptError(
          `${handler} result.timerOps[${index}].op must be schedule or cancel`,
        );
      }
      if (
        typeof operation.afterMs !== "number" ||
        !Number.isInteger(operation.afterMs) ||
        operation.afterMs < MIN_TIMER_DELAY_MS ||
        operation.afterMs > MAX_TIMER_DELAY_MS
      ) {
        throw new LuaScriptError(
          `${handler} result.timerOps[${index}].afterMs must be an integer between ${MIN_TIMER_DELAY_MS} and ${MAX_TIMER_DELAY_MS}`,
        );
      }
      if (operation.payload !== undefined) {
        assertJson(operation.payload, `${handler} result.timerOps[${index}].payload`);
        assertJsonSize(
          operation.payload,
          `${handler} result.timerOps[${index}].payload`,
          MAX_TIMER_PAYLOAD_BYTES,
        );
      }
      if (
        Object.keys(operation).some(
          (key) =>
            key !== "op" &&
            key !== "id" &&
            key !== "afterMs" &&
            key !== "payload",
        )
      ) {
        throw new LuaScriptError(
          `${handler} result.timerOps[${index}] contains an unknown field`,
        );
      }
      return {
        op: "schedule",
        id: operation.id,
        afterMs: operation.afterMs,
        ...(operation.payload === undefined ? {} : { payload: operation.payload }),
      };
    });
  }

  dispose(): void {
    this.module.luaL_unref(
      this.global.address,
      LUA_REGISTRY_INDEX,
      this.functionRef,
    );
    this.global.close();
  }

  private invoke(
    kind:
      | "setup"
      | "action"
      | "view"
      | "player_left"
      | "return_to_room"
      | "timer",
    state: JsonValue,
    action: JsonValue,
    context: JsonValue,
  ): JsonValue[] {
    const base = this.global.getTop();
    try {
      this.module.lua_rawgeti(
        this.global.address,
        LUA_REGISTRY_INDEX,
        BigInt(this.functionRef),
      );
      this.bridge.push(kind);
      this.bridge.push(state);
      this.bridge.push(action);
      this.bridge.push(context);

      const status = this.module.lua_pcallk(
        this.global.address,
        4,
        LUA_MULTRET,
        0,
        0,
        null,
      );
      if (status !== 0) throw readLuaError(this.global, this.module);

      const results: JsonValue[] = [];
      for (let index = base + 1; index <= this.global.getTop(); index += 1) {
        results.push(this.bridge.read(index));
      }
      return results;
    } finally {
      this.global.setTop(base);
    }
  }
}

function readLuaError(global: LuaGlobal, module: LuaWasm): LuaScriptError {
  const value = module.lua_tolstring(global.address, -1, null);
  global.pop(1);
  return new LuaScriptError(value || "Lua execution failed");
}

function isPlainObject(
  value: JsonValue | undefined,
): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEmptyObject(value: JsonValue | undefined): boolean {
  return isPlainObject(value) && Object.keys(value).length === 0;
}
