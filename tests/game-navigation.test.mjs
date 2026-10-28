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
  manifestId: "https://game.example/demo/", name: "Demo", launchMode: "choose", modes: ["solo", "room"] };
function fixture(initial = "/", selectedGame = game, overrides = {}) {
  const origin = overrides.origin ?? "https://platform.example";
  const history = [`${origin}/`, new URL(initial, origin).href];
  const states = [null, overrides.historyState ?? null];
  let cursor = 1, pops = new Set(), homeKey, homeRenderer, homeModule, tree, homeTree;
  const window = {
    location: new URL(history[cursor]),
    history: {
      get state() { return states[cursor]; },
      pushState(state, _title, path) { history.splice(cursor + 1); states.splice(cursor + 1); history.push(new URL(path, window.location).href); states.push(state); cursor++; window.location = new URL(history[cursor]); },
      replaceState(state, _title, path) { history[cursor] = new URL(path, window.location).href; states[cursor] = state; window.location = new URL(history[cursor]); },
    },
    addEventListener: (_type, listener) => pops.add(listener),
    removeEventListener: (_type, listener) => pops.delete(listener),
    matchMedia: () => ({ matches: true }), setTimeout, clearTimeout,
  };
  const appRenderer = renderer();
  const mappings = overrides.urlMappings ?? [];
  const links = load("features/game/game-launch-link.ts", {
    "@/app/site-config": { siteConfig: { urlMappings: mappings } },
    "@/app/url-mapping": load("app/url-mapping.ts", {}, window),
    "./game-launch-mode": load("features/game/game-launch-mode.ts", {}, window),
  }, window);
  const common = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@/app/i18n": { useI18n: () => ({ locale: "en", t: key => key }) },
    "@/features/game/game-launch-link": links,
    "@/features/room/room-code": { roomIdFromInput: value => value.trim().toUpperCase() === "FZCC" ? "FZCC" : undefined },
    "@/features/library/recent-games": { readRecentGames: () => [], persistRecentGames: () => [], saveRecentGame() {} },
    "@/platform/platform-api": { getPlatformSession: async () => ({}), createGuestSession: async () => {}, createRoom: overrides.createRoom ?? (async () => ({ roomId: "FZCC" })) },
  };
  common["@playweft/game-protocol"] = load("../../../packages/game-protocol/src/index.ts", {}, window);
  common["@/platform/json-rpc"] = load("platform/json-rpc.ts", common, window);
  common["@/features/game/room-creation"] = load("features/game/room-creation.ts", common, window);
  common["@/features/game/game-launch-mode"] = load("features/game/game-launch-mode.ts", common, window);
  common["./launch-input"] = load("features/home/launch-input.ts", common, window);
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
test("solo-only shared links open directly; unsupported explicit solo mode never mounts a game", async () => {
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

test("pasted room links join directly using the current origin and push one history entry", async () => {
  for (const origin of ["https://preview.example", "http://localhost:9133"]) {
    const f = fixture("/", game, { origin, probeGame: () => { throw new Error("Room links must not probe a Manifest"); } });
    await f.settle();
    find(f.home, "input").props.onChange({ target: { value: ` ${origin}/r/fzcc/?invite=1 ` } }); await f.settle();
    const form = find(f.home, "form");
    assert.equal(find(form, "button").props["aria-label"], "openGameOrRoom");
    form.props.onSubmit({ preventDefault() {} }); await f.settle();
    assert.ok(find(f.tree, "RoomHost")); assert.equal(f.window.location.pathname, "/r/FZCC"); assert.equal(f.history.length, 3);
    await f.back(); assert.equal(f.window.location.pathname, "/"); f.dispose();
  }
});

test("pasted game share and solo links preserve mode and load the embedded game source", async () => {
  for (const mode of [undefined, "solo"]) {
    const probed = [];
    const f = fixture("/", game, { origin: "https://preview.example", probeGame: async value => { probed.push(value); return game; } });
    await f.settle();
    const path = f.links.gameLaunchPath(game.manifestUrl, mode);
    find(f.home, "input").props.onChange({ target: { value: `${f.window.location.origin}${path}` } }); await f.settle();
    find(f.home, "form").props.onSubmit({ preventDefault() {} }); await f.settle();
    assert.deepEqual(probed, ["https://game.example/demo/"]);
    assert.equal(f.history.length, 3);
    if (mode === "solo") assert.ok(find(f.tree, "SoloHost"));
    else {
      assert.ok(find(f.home, "LaunchChoiceDialog")); assert.equal(find(f.tree, "SoloHost"), undefined);
      find(f.home, "LaunchChoiceDialog").props.onPlaySolo(); await f.settle();
      assert.ok(find(f.tree, "SoloHost")); assert.equal(f.history.length, 3);
    }
    await f.back(); assert.equal(f.window.location.pathname + f.window.location.search, "/"); f.dispose();
  }
});

test("foreign URLs and ordinary game sources are not mistaken for platform links", async () => {
  for (const value of [
    "https://foreign.example/r/FZCC",
    "https://foreign.example/?game=game.example/demo/&mode=solo",
    "https://game.example/demo/",
    "https://game.example/demo/custom.json?token=a%26b",
  ]) {
    const probed = [];
    const f = fixture("/", game, { probeGame: async source => { probed.push(source); return game; } }); await f.settle();
    find(f.home, "input").props.onChange({ target: { value } }); await f.settle();
    find(f.home, "form").props.onSubmit({ preventDefault() {} }); await f.settle();
    assert.equal(probed[0], value); assert.ok(find(f.home, "LaunchChoiceDialog"));
    assert.equal(find(f.tree, "RoomHost"), undefined); assert.equal(find(f.tree, "SoloHost"), undefined); f.dispose();
  }
});

test("pasted share links preserve encoded Manifest query parameters and validate unsupported modes", async () => {
  const queryGame = { ...game, manifestUrl: "https://game.example/custom.json?token=a%26b" };
  const probed = [];
  const f = fixture("/", queryGame, { probeGame: async source => { probed.push(source); return queryGame; } }); await f.settle();
  const path = `${f.links.gameLaunchPath(queryGame.manifestUrl)}&mode=unknown`;
  find(f.home, "input").props.onChange({ target: { value: `${f.window.location.origin}${path}` } }); await f.settle();
  find(f.home, "form").props.onSubmit({ preventDefault() {} }); await f.settle();
  assert.deepEqual(probed, [queryGame.manifestUrl]); assert.equal(f.history.length, 3);
  assert.ok(find(f.home, "LaunchChoiceDialog")); assert.equal(find(f.tree, "SoloHost"), undefined);
  assert.equal(find(f.home, "ErrorToast").props.message, "gameModeUnavailable"); f.dispose();
});


test('auto and omitted launch_mode open games directly without a mode picker',async()=>{
  for(const launchMode of [undefined,'auto'])for(const modes of [['solo'],['room'],['solo','room']]){
    const f=fixture('/?game=game.example/demo/',{...game,modes,launchMode});await f.settle();
    assert.equal(Boolean(find(f.tree,'SoloHost')),modes.includes('solo'));
    assert.equal(Boolean(find(f.tree,'RoomHost')),modes.length===1&&modes[0]==='room');
    assert.equal(Boolean(find(f.home,'LaunchChoiceDialog')),false);f.dispose();
  }
});
test('solo preference bypasses selection for cards and share links, replaces the shared entry and restores on refresh',async()=>{
  const preferred={...game,launchMode:'solo'};
  const f=fixture('/',preferred);await f.settle();find(f.home,'GameShelf').props.onSelect(preferred);await f.settle();
  assert.ok(find(f.tree,'SoloHost'));assert.equal(f.history.length,3);assert.equal(find(f.home,'LaunchChoiceDialog'),undefined);
  const soloUrl=f.window.location.pathname+f.window.location.search;
  const refreshed=fixture(soloUrl,preferred);await refreshed.settle();assert.ok(find(refreshed.tree,'SoloHost'));refreshed.dispose();
  find(f.tree,'SoloHost').props.onEnterRoom('FZCC');await f.settle();assert.ok(find(f.tree,'RoomHost'));assert.equal(f.history.length,3);
  await f.back();assert.equal(f.window.location.pathname+f.window.location.search,'/');f.dispose();
  const shared=fixture('/?game=game.example/demo/',preferred);await shared.settle();assert.ok(find(shared.tree,'SoloHost'));assert.equal(shared.history.length,2);shared.dispose();
});
test('explicit room links and room invitations override solo preference; invalid modes still fail',async()=>{
  const preferred={...game,launchMode:'solo'};
  for(const path of ['/?game=game.example/demo/&mode=room','/r/FZCC']){
    const f=fixture(path,preferred);await f.settle();assert.ok(find(f.tree,'RoomHost'));assert.equal(find(f.tree,'SoloHost'),undefined);assert.equal(f.history.length,2);f.dispose();
  }
  const invalid=fixture('/?game=game.example/demo/&mode=unknown',preferred);await invalid.settle();assert.equal(find(invalid.tree,'SoloHost'),undefined);assert.ok(find(invalid.home,'ErrorToast'));invalid.dispose();
});

test('mobile search shares input with the desktop form and submits room links through the same entry flow', async () => {
  const f = fixture('/'); await f.settle();
  find(f.home, 'MobileSearch').props.onChange('https://platform.example/r/FZCC/'); await f.settle();
  assert.equal(find(f.home, 'input').props.value, 'https://platform.example/r/FZCC/');
  find(f.home, 'MobileSearch').props.onSubmit(); await f.settle();
  assert.equal(f.window.location.pathname, '/r/FZCC');
  assert.ok(find(f.tree, 'RoomHost')); f.dispose();
});

test('embedded room URL changes retain the same game host and replace the current history entry', async () => {
  const embedded={...game,embeddedLobby:true,launchMode:'auto'};
  const f=fixture('/?game=game.example/demo/',embedded);await f.settle();
  const first=find(f.tree,'SoloHost');assert.ok(first);const entries=f.history.length;
  first.props.onRoomChange('FZCC');await f.settle();
  const joined=find(f.tree,'SoloHost');assert.ok(joined);assert.equal(joined.key,first.key);
  assert.equal(find(f.tree,'RoomHost'),undefined);assert.equal(f.window.location.pathname,'/r/FZCC');assert.equal(f.history.length,entries);
  joined.props.onRoomChange();await f.settle();assert.ok(find(f.tree,'SoloHost'));
  assert.equal(f.window.location.pathname+f.window.location.search,'/?game=game.example/demo/');assert.equal(f.history.length,entries);
  f.dispose();
});

test('room invitations for embedded games open the same persistent host used by direct game launches',async()=>{
  const f=fixture('/r/FZCC');await f.settle();const room=find(f.tree,'RoomHost');assert.ok(room);
  room.props.onGameDiscovered({...game,embeddedLobby:true});await f.settle();
  const host=find(f.tree,'SoloHost');assert.ok(host);assert.equal(host.props.initialRoomId,'FZCC');
  assert.equal(find(f.tree,'RoomHost'),undefined);assert.equal(f.window.location.pathname,'/r/FZCC');
  host.props.onRoomChange();await f.settle();assert.ok(find(f.tree,'SoloHost'));
  assert.equal(f.window.location.pathname+f.window.location.search,'/?game=game.example/demo/&mode=solo');f.dispose();
});


test("API-created rooms return to the source game when dissolved or left, including after refresh", async () => {
  const f = fixture("/?game=game.example/demo/&mode=solo"); await f.settle();
  const count = f.history.length;
  find(f.tree, "SoloHost").props.onEnterRoom("FZCC"); await f.settle();
  assert.equal(f.window.location.pathname, "/r/FZCC");
  assert.equal(f.history.length, count);
  assert.equal(f.window.history.state.roomReturn.manifestUrl, game.manifestUrl);
  const fresh = fixture("/r/FZCC", game, { historyState: structuredClone(f.window.history.state) });
  await fresh.settle();
  find(fresh.tree, "RoomHost").props.onBack(); await fresh.settle();
  assert.ok(find(fresh.tree, "SoloHost"));
  assert.equal(fresh.window.location.pathname + fresh.window.location.search, f.links.gameLaunchPath(game.manifestUrl, "solo"));
  find(f.tree, "RoomHost").props.onBack(); await f.settle();
  assert.ok(find(f.tree, "SoloHost"));
  assert.equal(f.history.length, count);
  assert.equal(f.window.history.state.roomReturn, undefined);
  fresh.dispose(); f.dispose();
});

test("ordinary invitations and unrelated or invalid return targets still exit to the game list", async () => {
  for (const state of [null, { roomReturn: { roomId: "OTHER", manifestUrl: game.manifestUrl } },
    { roomReturn: { roomId: "FZCC", manifestUrl: "javascript:alert(1)" } },
    { roomReturn: { roomId: "FZCC", manifestUrl: "invalid" } }]) {
    const f = fixture("/r/FZCC", game, { historyState: state }); await f.settle();
    find(f.tree, "RoomHost").props.onBack(); await f.settle();
    assert.equal(f.window.location.pathname + f.window.location.search, "/");
    assert.equal(find(f.tree, "SoloHost"), undefined); f.dispose();
  }
});

test("mapped share links stay on the alias and mode changes retain normal back navigation", async () => {
  const urlMappings=[{prefix:"abc",target:"https://game.example/"}];
  const f=fixture("/abc/demo/",game,{urlMappings});
  await f.settle();
  assert.equal(f.window.location.pathname,"/abc/demo/");
  assert.equal(f.window.location.search,"");
  assert.equal(f.history.length,2);
  assert.ok(find(f.home,"LaunchChoiceDialog"));
  assert.equal(f.links.gameLaunchLink(game.manifestUrl),"https://platform.example/abc/demo/");
  find(f.home,"LaunchChoiceDialog").props.onPlaySolo();await f.settle();
  assert.equal(f.window.location.pathname+f.window.location.search,"/abc/demo/?mode=solo");
  assert.equal(f.history.length,2);
  assert.ok(find(f.tree,"SoloHost"));
  await f.back();assert.equal(f.window.location.pathname,"/");
  await f.forward();assert.ok(find(f.tree,"SoloHost"));
  f.dispose();
});
test("fresh alias solo links restore directly and shelf selection generates aliases",async()=>{
  const urlMappings=[{prefix:"abc",target:"https://game.example/"}];
  const f=fixture("/abc/demo/?mode=solo",game,{urlMappings});await f.settle();
  assert.ok(find(f.tree,"SoloHost"));assert.equal(f.history.length,2);
  assert.equal(f.window.location.pathname+f.window.location.search,"/abc/demo/?mode=solo");
  f.dispose();
  const home=fixture("/",game,{urlMappings});await home.settle();
  find(home.home,"GameShelf").props.onSelect(game);await home.settle();
  assert.equal(home.window.location.pathname,"/abc/demo/");
  assert.equal(home.window.location.search,"");assert.equal(home.history.length,3);
  home.dispose();
});

test("direct-launch entries omit mode through selection, refresh and back/forward, including aliases", async () => {
  for (const launchMode of [undefined,"auto","solo"]) for (const aliases of [false,true]) {
    const direct={...game,launchMode};
    const urlMappings=aliases?[{prefix:"g",target:"https://game.example/"}]:[];
    const expected=aliases?"/g/demo/":"/?game=game.example/demo/";
    const f=fixture("/",direct,{urlMappings});await f.settle();
    find(f.home,"GameShelf").props.onSelect(direct);await f.settle();
    assert.ok(find(f.tree,"SoloHost"));
    assert.equal(f.window.location.pathname+f.window.location.search,expected);
    assert.equal(f.history.length,3);
    const refreshed=fixture(expected,direct,{urlMappings});await refreshed.settle();
    assert.ok(find(refreshed.tree,"SoloHost"));assert.equal(refreshed.history.length,2);
    assert.equal(refreshed.window.location.pathname+refreshed.window.location.search,expected);
    refreshed.dispose();
    await f.back();assert.equal(f.window.location.pathname,"/");assert.equal(find(f.tree,"SoloHost"),undefined);
    await f.forward();assert.ok(find(f.tree,"SoloHost"));
    assert.equal(f.window.location.pathname+f.window.location.search,expected);f.dispose();
  }
});
test("older explicit solo links remain valid without rewriting their address", async () => {
  const direct={...game,launchMode:"auto"};
  for (const [path,urlMappings] of [
    ["/?game=game.example/demo/&mode=solo",[]],
    ["/g/demo/?mode=solo",[{prefix:"g",target:"https://game.example/"}]],
  ]) {
    const f=fixture(path,direct,{urlMappings});await f.settle();
    assert.ok(find(f.tree,"SoloHost"));
    assert.equal(f.window.location.pathname+f.window.location.search,path);
    assert.equal(f.history.length,2);f.dispose();
  }
});
test("solo-only games omit mode even when launch_mode is choose",async()=>{
  const direct={...game,modes:["solo"]};
  const f=fixture('/?game=game.example/demo/',direct);await f.settle();
  assert.ok(find(f.tree,'SoloHost'));
  assert.equal(f.window.location.search,'?game=game.example/demo/');f.dispose();
});
test("direct games return from API-created rooms without adding a solo override, including refresh", async () => {
  const direct={...game,launchMode:"auto"};
  const f=fixture('/?game=game.example/demo/',direct);await f.settle();
  find(f.tree,"SoloHost").props.onEnterRoom("FZCC");await f.settle();
  const fresh=fixture('/r/FZCC',direct,{historyState:f.window.history.state});await fresh.settle();
  for (const page of [f,fresh]) {
    find(page.tree,"RoomHost").props.onBack();await page.settle();
    assert.ok(find(page.tree,"SoloHost"));
    assert.equal(page.window.location.search,'?game=game.example/demo/');
    assert.equal(page.history.length,2);page.dispose();
  }
});
