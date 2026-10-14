import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const require = createRequire(import.meta.url);
globalThis.__PLAYWEFT_LUA_WASM_MODULE__ = new WebAssembly.Module(readFileSync(require.resolve('wasmoon/dist/glue.wasm')));
const root = new URL('../', import.meta.url).pathname;
function modules(window, clock = performance) {
  const cache = new Map();
  function load(path) {
    path = resolve(root, path);
    if (cache.has(path)) return cache.get(path);
    const exports = {}; cache.set(path, exports);
    const { outputText } = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
    vm.runInNewContext(outputText, { exports, window, Date, Error, JSON, TextEncoder, WebAssembly, crypto, performance: clock,
      require(specifier) {
        if (specifier === 'wasmoon') return require(specifier);
        if (specifier.startsWith('@playweft/')) return load(`packages/${specifier.slice(10)}/src/index.ts`);
        return load(resolve(dirname(path), specifier + '.ts'));
      } });
    return exports;
  }
  return load;
}
const json = value => JSON.parse(JSON.stringify(value));
const presence = { type: 'room.presence', revision: 1, phase: 'playing', ownerId: 'h', minPlayers: 2, maxPlayers: 2, connectionMode: 'local-relay',
  players: [{id:'h',seat:1,ready:true},{id:'g',seat:2,ready:true}], spectators: [{id:'s'}],
  localHost: {id:'h',instanceId:'instance',matchId:'match',startedAt:Date.now(),players:[{id:'h',seat:1,ready:true},{id:'g',seat:2,ready:true}]} };
const source = readFileSync(new URL('../apps/rps-demo/game.lua', import.meta.url), 'utf8');
async function fixture(mode='local-relay', script=source, clock=performance) {
  const timers=new Map(); let timerId=0;
  const window={setInterval(fn){const id=++timerId;timers.set(id,fn);return id;},clearInterval:id=>timers.delete(id)};
  const load=modules(window, clock), {LocalHostRoom}=load('apps/web/src/features/room/peer/LocalHostRoom.ts');
  const {LuaGameRuntime}=load('packages/runtime-lua/src/index.ts');
  const {setupContext}=load('packages/runtime-core/src/index.ts');
  const boot={matchId:'match',startedAt:presence.localHost.startedAt,scriptHash:'real-lua-hash',script,liveRoom:false,
    context:setupContext({id:'match',startedAt:presence.localHost.startedAt,randomSeed:'seed'},'h',presence.players)};
  const rooms=new Map(), queue=[], snapshots=new Map(), status=new Map(), loads=new Map(), latencies=new Map(), errors=[];
  let initialized;
  const ready=new Promise(resolve=>initialized=resolve);
  const make=(id,instanceId='instance')=>{
    const room=new LocalHostRoom({selfId:id,instanceId,presence:{...presence,connectionMode:mode},
      async loadHost(){loads.set(id,(loads.get(id)??0)+1);return {boot,runtime:await LuaGameRuntime.create(script)};},
      sendRelay(targetId,kind,body){queue.push({targetId,type:'peer',fromId:id,kind,body,matchId:'match'});},
      onSnapshot(snapshot){snapshots.set(id,snapshot);if(id==='h')initialized();},
      onTransport(value){status.set(id,value);},onLatency(value){latencies.set(id,value);},onError(error){errors.push(error);initialized();}});
    rooms.set(id,room);return room;
  };
  const h=make('h'),g=make('g'),s=make('s'); await ready; assert.deepEqual(errors,[]);
  const pump=(drop=()=>false)=>{let limit=0;while(queue.length){assert.ok(limit++<1000);const envelope=queue.shift();if(!drop(envelope))rooms.get(envelope.targetId)?.receive(envelope);}};
  const tick=()=>{for(const room of rooms.values())room.lastTick=0;for(const callback of [...timers.values()])callback();pump();};
  pump();return {make,h,g,s,rooms,queue,pump,tick,snapshots,status,timers,loads,latencies,errors,dispose(){for(const room of rooms.values())room.dispose();}};
}
test('real shared Lua rules execute only on the host and project private state; relay retries do not execute twice',async()=>{
  const f=await fixture();assert.deepEqual([...f.loads],[['h',1]]);
  const first=f.g.action('g1',{type:'choose',choice:'paper'});f.pump(envelope=>envelope.body.type==='result');
  assert.equal(f.snapshots.get('g').version,1);assert.deepEqual(json(f.snapshots.get('g').state.choices),{g:true});
  assert.deepEqual(json(f.snapshots.get('h').state.choices),{});assert.deepEqual(json(f.snapshots.get('s').state.choices),{});
  assert.deepEqual(json(f.snapshots.get('s').events),[]);
  f.tick();assert.equal((await first).accepted,true);assert.equal(f.snapshots.get('g').version,1);
  assert.equal((await f.h.action('h1',{type:'choose',choice:'rock'})).accepted,true);f.pump();
  assert.equal(f.snapshots.get('g').state.round,2);assert.equal(f.snapshots.get('g').state.lastResult.winner,'g');
  assert.equal((await f.h.action('h1',{type:'choose',choice:'rock'})).version,2);f.pump();assert.equal(f.snapshots.get('g').version,2);
  const observer=f.s.action('s1',{type:'choose',choice:'rock'});f.pump();assert.equal((await observer).accepted,false);
  f.dispose();assert.equal(f.timers.size,0);
});
test('missing WebRTC falls back to relay and changed retry payload is rejected',async()=>{
  const f=await fixture('local-host');assert.equal(f.status.get('g'),'relay');
  const action=f.g.action('same',{type:'choose',choice:'scissors'});f.pump();assert.equal((await action).accepted,true);
  const changed=f.g.action('same',{type:'choose',choice:'rock'});f.pump();assert.equal((await changed).error.code,'REQUEST_ID_REUSED');f.dispose();
});
test('host refresh never loads Lua again or creates a second authority',async()=>{
  const f=await fixture();const action=f.g.action('g1',{type:'choose',choice:'paper'});f.pump();await action;
  f.h.dispose();const replacement=f.make('h','new-instance');f.tick();
  assert.equal(f.status.get('h'),'paused');assert.equal(f.status.get('g'),'paused');assert.equal(f.loads.get('h'),1);
  await assert.rejects(replacement.action('h1',{type:'choose',choice:'rock'}),/unavailable/);assert.equal(f.snapshots.get('g').version,1);f.dispose();
});
test('stale and non-host snapshots cannot overwrite clients; losing authority pauses the match',async()=>{
  const f=await fixture(),before=f.snapshots.get('g');
  for(const [fromId,matchId] of [['s','match'],['h','old-match']]) f.g.receive({type:'peer',fromId,matchId,kind:'data',body:{type:'snapshot',snapshot:{matchId,version:99,state:{}}}});
  assert.equal(f.snapshots.get('g'),before);
  f.g.setPresence({...presence,players:[presence.players[1]]});assert.equal(f.status.get('g'),'paused');
  await assert.rejects(f.g.action('g1',{}),/unavailable/);f.dispose();
});
test('another Lua script reuses timers, membership hooks and current owner capabilities',async()=>{
  const script=`function setup(c) return {state={count=0},events={},timerOps={{op='schedule',id='pulse',afterMs=100}}} end
  function on_action(s,a,c) s.owner=c.actor.isOwner; return {accepted=true,state=s,events={}} end
  function view(s,e,c) s.viewer=c.viewer.id; return {state=s,events=e} end
  function on_timer(s,t,c) s.count=s.count+1; return {state=s,events={}} end
  function on_player_left(s,c) s.left=c.actor.id; return {state=s,events={}} end`;
  const f=await fixture('local-relay',script);
  f.h.engine.advance(Date.now()+200);f.h.publish();f.pump();assert.equal(f.snapshots.get('g').state.count,1);
  f.h.setPresence({...presence,ownerId:'s',players:[presence.players[0]],spectators:presence.spectators});f.pump();
  assert.equal(f.snapshots.get('s').state.left,'g');assert.equal(f.snapshots.get('s').state.viewer,'s');
  const action=f.s.action('manage',{});f.pump();assert.equal((await action).accepted,true);assert.equal(f.snapshots.get('s').state.owner,true);f.dispose();
});

test('return-to-room permission executes on the browser authority, including after management transfer',async()=>{
  const script=`function setup(c) return {state={allow=false},events={}} end
  function on_action(s,a,c) s.allow=a.allow; return {accepted=true,state=s,events={}} end
  function view(s,e,c) return {state=s,events=e} end
  function on_return_to_room(s,c) return c.actor.isOwner and s.allow end`;
  const f=await fixture('local-relay',script);
  assert.equal(await f.h.canReturnToRoom(),false);
  await f.h.action('allow',{allow:true});f.pump();assert.equal(await f.h.canReturnToRoom(),true);
  const next={...presence,ownerId:'s'};f.h.setPresence(next);f.s.setPresence(next);
  const query=f.s.canReturnToRoom();f.pump();assert.equal(await query,true);
  assert.equal(await f.h.canReturnToRoom(),false);f.dispose();
});


test('RTT correlates probe IDs and paths, clears on switching, and never reports guest RTT as the host RTT',async()=>{
  let now=1000;const clock={now:()=>now},f=await fixture('local-host',source,clock),packets=[];
  const hp={pc:{close(){}},lastDirect:Date.now(),candidates:[]};
  const gp={pc:{close(){}},lastDirect:Date.now(),candidates:[]};
  const hc={readyState:'open',bufferedAmount:0,send:data=>packets.push({to:'g',data})};
  const gc={readyState:'open',bufferedAmount:0,send:data=>packets.push({to:'h',data})};
  f.h.peers.set('g',hp);f.g.peers.set('h',gp);f.h.channel('g',hp,hc);f.g.channel('h',gp,gc);
  f.h.status();f.g.status();assert.equal(f.latencies.get('g'),undefined);
  const directPump=()=>{while(packets.length){const packet=packets.shift();(packet.to==='h'?hc:gc).onmessage({data:packet.data});}};
  f.g.probe('h','webrtc');const id=JSON.parse(packets[0].data).id;
  f.g.receive({type:'peer',fromId:'h',matchId:'match',kind:'data',body:{type:'pong',id}});
  assert.equal(f.latencies.get('g'),undefined,'relay pong cannot satisfy a direct probe');
  now+=25;const ping=packets.shift();hc.onmessage({data:ping.data});now+=35;directPump();
  assert.equal(f.latencies.get('g'),60);assert.equal(f.latencies.get('h'),undefined);
  f.h.probe('g','webrtc');now+=20;directPump();assert.equal(f.latencies.get('h'),undefined,'host peer probes never publish a local RTT');
  gp.lastDirect=Date.now()-7000;f.g.status();assert.equal(f.status.get('g'),'relay');assert.equal(f.latencies.get('g'),undefined);
  // The host has an open direct channel, yet a relay ping must receive a relay pong.
  f.queue.length=0;f.g.probe('h','relay');const relayPing=f.queue.shift();now+=40;f.h.receive(relayPing);
  assert.equal(packets.length,0);assert.equal(f.queue[0].body.type,'pong');now+=50;f.pump();
  assert.equal(f.latencies.get('g'),90);
  f.g.receive({type:'peer',fromId:'h',matchId:'match',kind:'data',body:{type:'pong',id}});assert.equal(f.latencies.get('g'),90,'late old-path replies are ignored');
  now+=6001;f.g.tick();assert.equal(f.latencies.get('g'),undefined,'expired samples become unknown');
  f.g.setRelayAvailable(false);assert.equal(f.status.get('g'),'paused');assert.equal(f.latencies.get('g'),undefined);
  f.dispose();
});

test('a failed direct pong never silently falls back to relay',async()=>{
  const f=await fixture('local-host');const peer={pc:{close(){}},lastDirect:Date.now(),candidates:[]};
  const channel={readyState:'open',bufferedAmount:0,send(){throw Error('closed during send');}};
  f.h.peers.set('g',peer);f.h.channel('g',peer,channel);f.queue.length=0;
  channel.onmessage({data:JSON.stringify({type:'ping',id:'probe'})});
  assert.equal(f.queue.length,0);f.dispose();
});
