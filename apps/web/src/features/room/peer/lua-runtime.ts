import wasmUrl from "wasmoon/dist/glue.wasm?url";
import { LuaGameRuntime } from "@playweft/runtime-lua";

let modulePromise: Promise<WebAssembly.Module> | undefined;
/** This entire module is a dynamic chunk, requested only by the pinned host. */
export async function createLuaRuntime(source: string) {
  modulePromise ??= fetch(wasmUrl).then(async response => {
    if (!response.ok) throw new Error("Could not load the Lua runtime");
    return WebAssembly.compile(await response.arrayBuffer());
  }).catch(error => { modulePromise = undefined; throw error; });
  globalThis.__PLAYWEFT_LUA_WASM_MODULE__ = await modulePromise;
  return LuaGameRuntime.create(source);
}
