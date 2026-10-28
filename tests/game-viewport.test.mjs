import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function fixture({mobile=true}={}) {
  const effects=[],locks=[],unlocks=[],fullscreen=[],listeners=new Map();let exits=0;
  const query={matches:false,addEventListener(){},removeEventListener(){}};
  const orientation={lock(value){let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});locks.push({value,resolve,reject});return promise;},unlock(){unlocks.push(true);},addEventListener(){},removeEventListener(){}};
  const document={documentElement:{requestFullscreen(){let resolve;const promise=new Promise(done=>resolve=done);fullscreen.push({resolve(){document.fullscreenElement=document.documentElement;resolve();}});return promise;}},visibilityState:'visible',fullscreenElement:null,
    exitFullscreen:async()=>{exits++;document.fullscreenElement=null;},addEventListener(type,fn){listeners.set(type,fn);},removeEventListener(type){listeners.delete(type);}};
  const window={matchMedia:()=>query,setTimeout,clearTimeout};
  const react={useCallback:fn=>fn,useRef:value=>({current:value}),useState:value=>[typeof value==='function'?value():value,()=>{}],useEffect:fn=>effects.push(fn)};
  const source=readFileSync(new URL('../apps/web/src/features/game/use-game-viewport.ts',import.meta.url),'utf8');
  const {outputText}=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}});
  const module={exports:{}};
  vm.runInNewContext(outputText,{module,exports:module.exports,window,document,screen:{orientation},navigator:{maxTouchPoints:mobile?1:0,userAgent:'test'},console:{warn(){}},require:name=>{assert.equal(name,'react');return react;}});
  const mount=()=>{const controller=module.exports.useGameViewport(true,{orientation:'landscape'});return {controller,start:effects.at(-1)};};
  return {...mount(),mount,locks,unlocks,fullscreen,document,orientation,listeners,api:module.exports,get exits(){return exits;}};
}
test('exiting before a hook-started orientation lock resolves still unlocks the screen',async()=>{
  const f=fixture();const cleanup=f.start();assert.equal(f.locks.length,1);
  cleanup();await flush();
  assert.equal(f.unlocks.length,1,"unlock must not wait for the native promise");
  f.locks[0].resolve();await flush();
  assert.equal(f.unlocks.length,2,"a late successful lock must also be released");
});
test('an immediately restarted effect retains the lock for the replacement session',async()=>{
  const f=fixture();const first=f.start();first();const second=f.start();
  f.locks[0].resolve();f.locks[1].resolve();await flush();
  assert.equal(f.unlocks.length,0);
  second();await flush();assert.equal(f.unlocks.length,1);
});

test('cleanup of a previous component cannot unlock a newer game component',async()=>{
  const f=fixture();const old=f.start();old();const fresh=f.mount().start();
  f.locks[1].resolve();await flush();
  f.locks[0].resolve();await flush();assert.equal(f.unlocks.length,0);
  fresh();await flush();assert.equal(f.unlocks.length,1);
});
test('fullscreen requests completing after game exit are also retired',async()=>{
  const f=fixture({mobile:false});const cleanup=f.start();
  const pending=f.controller.enterPreferredOrientation();assert.equal(f.fullscreen.length,1);
  cleanup();await flush();f.fullscreen[0].resolve();await pending;await flush();
  assert.equal(f.exits,1);assert.equal(f.document.fullscreenElement,null);
});
test('fullscreenchange does not make retirement skip orientation unlock',async()=>{
  const f=fixture();const cleanup=f.start();f.locks[0].resolve();await flush();
  f.listeners.get('fullscreenchange')();cleanup();await flush();
  assert.equal(f.unlocks.length,1);
});
test('unlock errors do not prevent owned fullscreen from being released',async()=>{
  const f=fixture();const pending=f.api.prepareGameOrientation('landscape');
  f.locks[0].reject({name:'SecurityError'});await flush();f.fullscreen[0].resolve();await flush();
  f.locks[1].resolve();await pending;
  f.orientation.unlock=()=>{throw new Error('hidden document');};
  await f.api.releaseGameFullscreen();assert.equal(f.exits,1);assert.equal(f.document.fullscreenElement,null);
});

test('a native orientation lock that never settles cannot prevent fullscreen cleanup',async()=>{
  const f=fixture();const pending=f.api.prepareGameOrientation('landscape');
  f.locks[0].reject({name:'SecurityError'});await flush();f.fullscreen[0].resolve();await flush();
  assert.equal(f.locks.length,2);
  // Android Chrome can rotate successfully while this second promise hangs.
  const cleanup=f.start();cleanup();await flush();
  assert.equal(f.unlocks.length,1);
  assert.equal(f.exits,1);assert.equal(f.document.fullscreenElement,null);
  void pending;
});

test('a stuck lock cannot delay cleanup of a separately completed fullscreen request',async()=>{
  const f=fixture();const cleanup=f.start(); // First hook lock never settles.
  void f.controller.enterPreferredOrientation();
  f.locks[1].reject({name:'SecurityError'});await flush();
  assert.equal(f.fullscreen.length,1);
  cleanup();await flush();assert.equal(f.unlocks.length,1);
  f.fullscreen[0].resolve();await flush();
  assert.equal(f.exits,1);assert.equal(f.document.fullscreenElement,null);
});
