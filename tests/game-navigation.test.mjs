import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const sourceRoot = new URL("../apps/web/src/", import.meta.url);
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const jsx = (type, props, key) => ({ type, props, key });
function load(path, imports, window) {
  const source = readFileSync(new URL(path, sourceRoot), "utf8");
  const { outputText } = ts.transpileModule(source, { fileName: path,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } });
  const module = { exports: {} };
  vm.runInNewContext(outputText, { module, exports: module.exports, URL, Error, window,
    require: name => imports[name] ?? { __esModule: true, default: name.split("/").at(-1) },
  });
  return module.exports;
}
// Render the real App and Home hooks independently; child UI stays as JSX data.
function renderer() {
  let index = 0, pending = [], slots = [], dirty = true;
  const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial) {
      const i = index++;
      if (!slots[i]) slots[i] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[i].value, value => {
        const next = typeof value === "function" ? value(slots[i].value) : value;
        if (!Object.is(next, slots[i].value)) { slots[i].value = next; dirty = true; }
      }];
    },
    useRef(value) { const i = index++; return (slots[i] ??= { current: value }); },
    useMemo(f, deps) { const i = index++; if (!slots[i] || !equal(slots[i].deps, deps)) slots[i] = { value: f(), deps }; return slots[i].value; },
    useCallback(f, deps) { return react.useMemo(() => f, deps); },
    useEffect(f, deps) {
      const i = index++;
      if (!slots[i] || !equal(slots[i].deps, deps)) {
        const previous = slots[i]; slots[i] = { deps };
        pending.push(() => { previous?.cleanup?.(); slots[i].cleanup = f(); });
      }
    },
  };
  return {
    react,
    get dirty() { return dirty; },
    render(f, props) { index = 0; dirty = false; const tree = f(props); const effects = pending; pending = []; effects.forEach(f => f()); return tree; },
    dispose() { slots.forEach(s => s?.cleanup?.()); },
  };
}
function find(tree, type) {
  if (!tree || typeof tree !== "object") return;
  if (Array.isArray(tree)) { for (const child of tree) { const result = find(child, type); if (result) return result; } }
  if (tree.type === type) return tree;
  return find(tree.props?.children, type);
}
const game = { manifestUrl: "https://game.example/demo/playweft.json", url: "https://game.example/demo/index.html",
  manifestId: "https://game.example/demo/", name: "Demo", modes: ["solo", "room"] };
function fixture(initial = "/", selectedGame = game, overrides = {}) {
  const history = ["https://platform.example/", new URL(initial, "https://platform.example").href];
  let cursor = 1, pops = new Set(), homeKey, homeRenderer, homeModule, tree, homeTree;
  const window = {
    location: new URL(history[cursor]),
    history: {
      pushState(_state, _title, path) { history.splice(cursor + 1); history.push(new URL(path, window.location).href); cursor++; window.location = new URL(history[cursor]); },
      replaceState(_state, _title, path) { history[cursor] = new URL(path, window.location).href; window.location = new URL(history[cursor]); },
    },
    addEventListener: (_type, listener) => pops.add(listener),
    removeEventListener: (_type, listener) => pops.delete(listener),
    matchMedia: () => ({ matches: true }), setTimeout, clearTimeout,
  };
  const appRenderer = renderer();
  const links = load("features/game/game-launch-link.ts", {}, window);
  const common = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@/app/i18n": { useI18n: () => ({ locale: "en", t: key => key }) },
    "@/features/game/game-launch-link": links,
    "@/features/library/recent-games": { readRecentGames: () => [], persistRecentGames: () => [], saveRecentGame() {} },
    "@/platform/platform-api": { getPlatformSession: async () => ({}), createGuestSession: async () => {}, createRoom: overrides.createRoom ?? (async () => ({ roomId: "FZCC" })) },
  };
  const App = load("app/App.tsx", { ...common, react: appRenderer.react,
    "@/app/use-pwa-update": { usePwaUpdate: () => ({}) },
    "@/features/account/player-profile": { readGuestPlayerNickname: () => "Player" },
    "@/features/game/use-game-viewport": { prepareGameOrientation() {} },
  }, window).default;
  function createHome() {
    homeRenderer?.dispose(); homeRenderer = renderer();
    homeModule = load("features/home/Home.tsx", { ...common, react: homeRenderer.react,
      "@/features/library/featured-games": { useFeaturedGames: () => [selectedGame] },
      "@/features/library/favorite-games": { readFavoriteGames: () => [] },
      "@/features/library/library-game": { normalizeLibraryGame: game => game },
      "@/features/room/room-code": { roomIdFromInput: value => value.trim().toUpperCase() === "FZCC" ? "FZCC" : undefined },
      "@/features/game/game-discovery": { probeGame: overrides.probeGame ?? (async () => selectedGame), UnsupportedGameUrlError: class extends Error {} },
    }, window).default;
  }
  const f = {
    window, links, history,
    get tree() { return tree; }, get home() { return homeTree; },
    async settle() {
      for (let i = 0; i < 12; i++) {
        tree = appRenderer.render(App);
        const home = find(tree, "Home");
        if (home && home.key !== homeKey) { homeKey = home.key; createHome(); }
        if (home) homeTree = homeRenderer.render(homeModule, home.props);
        else { homeRenderer?.dispose(); homeRenderer = undefined; homeKey = undefined; homeTree = undefined; }
        await flush();
        if (!appRenderer.dirty && !homeRenderer?.dirty) return;
      }
      throw new Error("Navigation did not settle");
    },
    async back() { cursor--; window.location = new URL(history[cursor]); pops.forEach(f => f()); await new Promise(r => setTimeout(r, 1)); await f.settle(); },
    async forward() { cursor++; window.location = new URL(history[cursor]); pops.forEach(f => f()); await f.settle(); },
    dispose() { appRenderer.dispose(); homeRenderer?.dispose(); },
  };
  return f;
}

test("share links omit mode; solo links preserve manifest query and localhost protocol", () => {
  const f = fixture();
  assert.equal(f.links.gameLaunchLink(game.manifestUrl), "https://platform.example/?game=game.example/demo/");
  const path = f.links.gameLaunchPath("http://localhost:9139/demo/playweft.json", "solo");
  assert.equal(f.links.gameUrlFromExternalLaunch(path), "http://localhost:9139/demo/");
  assert.equal(f.links.gameModeFromExternalLaunch(path), "solo");
  const queryManifest = "https://game.example/manifest.json?token=a%26b";
  assert.equal(f.links.gameUrlFromExternalLaunch(f.links.gameLaunchPath(queryManifest, "solo")), queryManifest);
  assert.equal(f.links.gameModeFromExternalLaunch("/r/FZCC?mode=solo"), undefined);
  f.dispose();
});
test("homepage game selection pushes one entry; solo selection replaces it and back/forward restore the correct view", async () => {
  const f = fixture(); await f.settle();
  find(f.home, "GameShelf").props.onSelect(game); await f.settle();
  assert.equal(f.history.length, 3); assert.ok(find(f.home, "LaunchChoiceDialog")); assert.equal(find(f.tree, "SoloHost"), undefined);
  find(f.home, "LaunchChoiceDialog").props.onPlaySolo(); await f.settle();
  assert.equal(f.history.length, 3); assert.equal(f.window.location.search, "?game=game.example/demo/&mode=solo"); assert.ok(find(f.tree, "SoloHost"));
  await f.back(); assert.equal(f.window.location.pathname + f.window.location.search, "/"); assert.equal(find(f.tree, "SoloHost"), undefined);
  await f.forward(); assert.ok(find(f.tree, "SoloHost")); f.dispose();
});
test("fresh solo URL restores solo without a choice or new history entry; exit replaces with homepage", async () => {
  const f = fixture("/?game=game.example/demo/&mode=solo"); await f.settle();
  const solo = find(f.tree, "SoloHost"); assert.ok(solo); assert.equal(find(f.home, "LaunchChoiceDialog"), undefined); assert.equal(f.history.length, 2);
  solo.props.onBack(); await f.settle(); assert.equal(f.window.location.pathname + f.window.location.search, "/"); assert.equal(f.history.length, 2); f.dispose();
});
test("direct shared link keeps the choice; creating or joining a room replaces that entry", async () => {
  for (const action of ["onCreateRoom", "onJoinRoom"]) {
    const f = fixture("/?game=game.example/demo/"); await f.settle();
    assert.ok(find(f.home, "LaunchChoiceDialog")); assert.equal(find(f.tree, "SoloHost"), undefined);
    find(f.home, "LaunchChoiceDialog").props[action]("FZCC"); await f.settle();
    assert.equal(f.window.location.pathname, "/r/FZCC"); assert.equal(f.history.length, 2);
    find(f.tree, "RoomHost").props.onBack(); await f.settle(); assert.equal(f.window.location.pathname, "/"); assert.equal(f.history.length, 2); f.dispose();
  }
});
test("homepage room-code entry pushes history instead of replacing homepage", async () => {
  const f = fixture(); await f.settle();
  find(f.home, "input").props.onChange({ target: { value: "fzcc" } }); await f.settle();
  find(f.home, "form").props.onSubmit({ preventDefault() {} }); await f.settle();
  assert.equal(f.window.location.pathname, "/r/FZCC"); assert.equal(f.history.length, 3); f.dispose();
});
test("solo-only shared links auto-replace; unsupported explicit solo mode never mounts a game", async () => {
  const solo = fixture("/?game=game.example/demo/", { ...game, modes: ["solo"] }); await solo.settle();
  assert.ok(find(solo.tree, "SoloHost")); assert.equal(solo.history.length, 2); solo.dispose();
  const room = fixture("/?game=game.example/demo/&mode=solo", { ...game, modes: ["room"] }); await room.settle();
  assert.equal(find(room.tree, "SoloHost"), undefined); assert.ok(find(room.home, "LaunchChoiceDialog"));
  assert.equal(find(room.home, "ErrorToast").props.message, "gameModeUnavailable"); assert.equal(room.window.location.pathname, "/"); room.dispose();
});

test("Back invalidates a pending Manifest result instead of launching the previous game", async () => {
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const f = fixture("/?game=game.example/demo/&mode=solo", game, { probeGame: () => pending });
  await f.settle(); await f.back(); resolve(game); await f.settle();
  assert.equal(f.window.location.pathname + f.window.location.search, "/");
  assert.equal(find(f.tree, "SoloHost"), undefined); assert.equal(f.history.length, 2); f.dispose();
});
test("room creation failures retain the shared entry and choice for retry", async () => {
  let attempts = 0;
  const f = fixture("/?game=game.example/demo/", game, { createRoom: async () => {
    if (++attempts === 1) throw new Error("network unavailable");
    return { roomId: "FZCC" };
  } });
  await f.settle(); find(f.home, "LaunchChoiceDialog").props.onCreateRoom(); await f.settle();
  assert.equal(f.window.location.search, "?game=game.example/demo/"); assert.ok(find(f.home, "LaunchChoiceDialog"));
  assert.equal(find(f.home, "ErrorToast").props.message, "network unavailable");
  find(f.home, "LaunchChoiceDialog").props.onCreateRoom(); await f.settle();
  assert.equal(f.window.location.pathname, "/r/FZCC"); assert.equal(f.history.length, 2); f.dispose();
});
