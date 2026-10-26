import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {createRoomClient,createRoomsClient} from '../apps/web/public/sdk/room.js';
const root=new URL('../',import.meta.url).pathname;
const json=value=>JSON.parse(JSON.stringify(value));
function modules(extra={}){
  const cache=new Map();
  function load(path){
    path=resolve(root,path);if(cache.has(path))return cache.get(path);
    const module={exports:{}};cache.set(path,module.exports);
    const {outputText}=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}});
    vm.runInNewContext(outputText,{exports:module.exports,module,URL,Error,Response,Headers,TextEncoder,AbortController,DOMException,
      window:{location:new URL('https://platform.example/'),setTimeout,clearTimeout},...extra,
      require(name){
        if(name==='@/platform/platform-api')return {};
        if(name==='@/app/i18n')return {isGameTranslations:()=>true};
        if(name==='@/app/app-load-policy')return {readAppLoadPolicy:()=> 'cache-disabled'};
        if(name==='@playweft/game-protocol')return load('packages/game-protocol/src/index.ts');
        if(name.startsWith('@/'))return load(`apps/web/src/${name.slice(2)}.ts`);
        if(name.startsWith('.'))return load(resolve(dirname(path),name+'.ts'));
        throw Error('Unexpected import '+name);
      }});
    return module.exports;
  }
  return load;
}
const manifest={manifest_version:1,id:'./',version:'1.0.0',protocol:{min:1,max:1},start_url:'./',name:'Mode test',
  modes:{solo:{},room:{players:{min:1,max:2},server:{runtime:'lua',entry:'./game.lua',persistence:'durable'}}}};
test('Manifest accepts auto/solo/choose preferences and requires solo capability for solo preference',()=>{
  const {parseGameManifest}=modules()('packages/game-protocol/src/index.ts');
  assert.equal(parseGameManifest(manifest).launch_mode,undefined);
  for(const value of ['auto','solo','choose'])assert.equal(parseGameManifest({...manifest,launch_mode:value}).launch_mode,value);
  for(const value of ['room','both','solo-first',null,{},true])assert.throws(()=>parseGameManifest({...manifest,launch_mode:value}),/launch_mode/);
  assert.throws(()=>parseGameManifest({...manifest,modes:{room:manifest.modes.room},launch_mode:'solo'}),/requires modes.solo/);
});
test('Manifest preference propagates to discovered and persisted library metadata',async()=>{
  const load=modules({fetch:async()=>new Response(JSON.stringify({...manifest,launch_mode:'solo'}),{headers:{'Content-Type':'application/json'}})});
  const {loadGameManifest,isStoredDiscoveredGame}=load('apps/web/src/features/game/game-manifest.ts');
  const loaded=await loadGameManifest('https://game.example/demo/playweft.json');
  assert.equal(loaded.game.launchMode,'solo');assert.equal(isStoredDiscoveredGame(loaded.game),true);
  const legacy={...loaded.game};delete legacy.launchMode;assert.equal(isStoredDiscoveredGame(legacy),true);
  assert.equal(isStoredDiscoveredGame({...loaded.game,launchMode:'auto'}),true);
  assert.equal(isStoredDiscoveredGame({...loaded.game,modes:['room']}),false);
});
test('disabled application caching still revalidates manifests and loads a changed version',async()=>{
  const requests=[];
  let current=manifest;
  const load=modules({
    caches:{open:()=>assert.fail('disabled application caching must not read or write offline manifests')},
    fetch:async(url,options)=>{requests.push({url,options});return Response.json(current);},
  });
  const {loadGameManifest}=load('apps/web/src/features/game/game-manifest.ts');
  const url='https://game.example/demo/playweft.json';
  assert.equal((await loadGameManifest(url)).game.version,'1.0.0');
  current={...manifest,version:'1.1.0',start_url:'./updated.html'};
  const updated=await loadGameManifest(url);
  assert.equal(updated.game.version,'1.1.0');
  assert.equal(updated.game.url,'https://game.example/demo/updated.html');
  assert.equal(requests.length,2,'each opening must check the network');
  assert.ok(requests.every(request=>request.url===url&&request.options.cache==='no-cache'));
});
test('disabled application caching never falls back to a saved manifest on network failure',async()=>{
  const load=modules({
    caches:{open:()=>assert.fail('disabled application caching must not fall back to an old manifest')},
    fetch:async()=>{throw new TypeError('offline');},
  });
  const {loadGameManifest}=load('apps/web/src/features/game/game-manifest.ts');
  await assert.rejects(loadGameManifest('https://game.example/demo/playweft.json'),/offline/);
});
function creationFixture(overrides={}){
  const timers=new Map();let sequence=0;
  const load=modules({window:{setTimeout:fn=>{timers.set(++sequence,fn);return sequence;},clearTimeout:id=>timers.delete(id)}});
  const {SoloRoomCreation,createGameRoom}=load('apps/web/src/features/game/room-creation.ts');
  const entered=[],calls=[],busy=[];
  const game={manifestUrl:'https://game.example/demo/playweft.json',modes:['solo','room']};
  const api={createGuestSession:async name=>calls.push(['guest',name]),createRoom:async url=>{calls.push(['room',url]);return {roomId:'ROOM',manifestUrl:url};},...overrides};
  const options={waitForIdentity:async()=> 'Player',onEnterRoom:id=>entered.push(id),onPendingChange:value=>busy.push(value),isCancelled:()=>false};
  const creator=new SoloRoomCreation(game,options,api);
  return {creator,createGameRoom,options,api,game,entered,calls,busy,runTimers(){for(const [id,fn]of [...timers]){timers.delete(id);fn();}}};
}
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return {promise,resolve};};
test('concurrent solo RPC calls share one authenticated room and navigate only after an explicit entry',async()=>{
  const f=creationFixture();const first=f.creator.create();assert.equal(first,f.creator.create());
  const room=await first;assert.deepEqual(f.calls,[['guest','Player'],['room',f.game.manifestUrl]]);assert.deepEqual(f.entered,[]);
  assert.equal(await f.creator.create(),room);f.creator.enter('wrong');f.runTimers();assert.deepEqual(f.entered,[]);
  f.creator.enter(room.roomId);f.creator.enter(room.roomId);f.runTimers();assert.deepEqual(f.entered,['ROOM']);
  f.creator.dispose();await assert.rejects(f.creator.create(),error=>error.data.code==='ROOM_CREATION_CANCELLED');
});
test('room-only capability checks and identity cancellation stop requests before creating a room',async()=>{
  const f=creationFixture();
  await assert.rejects(f.createGameRoom({...f.game,modes:['solo']},f.options.waitForIdentity,()=>false,f.api),error=>error.data.code==='ROOM_MODE_UNAVAILABLE');
  assert.deepEqual(f.calls,[]);
  const identity=deferred();f.options.waitForIdentity=()=>identity.promise;
  const pending=f.creator.create();f.creator.dispose();identity.resolve('Late identity');
  await assert.rejects(pending,error=>error.data.code==='ROOM_CREATION_CANCELLED');assert.deepEqual(f.calls,[]);f.runTimers();assert.deepEqual(f.entered,[]);
});
test('network failures can retry; cancellation and late replies cannot navigate over a newer request',async()=>{
  let attempts=0;const gate=deferred(),started=deferred();
  const f=creationFixture({createRoom:async()=>{attempts++;if(attempts===1)throw Error('offline');if(attempts===2){started.resolve();return gate.promise;}return {roomId:'NEW'};}});
  await assert.rejects(f.creator.create(),error=>error.message==='offline'&&error.data.code==='ROOM_CREATION_FAILED'&&error.data.retryable);
  const old=f.creator.create();const cancelled=assert.rejects(old,error=>error.data.code==='ROOM_CREATION_CANCELLED');await started.promise;
  f.creator.cancel();const latest=await f.creator.create();assert.equal(latest.roomId,'NEW');gate.resolve({roomId:'OLD'});
  await cancelled;f.creator.enter('OLD');f.runTimers();assert.deepEqual(f.entered,[]);
  f.creator.enter('NEW');f.runTimers();assert.deepEqual(f.entered,['NEW']);f.creator.dispose();
});
test('RPC posts a successful response before its navigation hook and never enters on failure or a notification',async()=>{
  const load=modules(),{dispatchRpcMessage}=load('apps/web/src/platform/json-rpc.ts'),order=[];
  const port={postMessage:message=>order.push(['reply',message])};
  const handlers={'room.create':{handle:()=>({roomId:'ROOM'}),afterReply:result=>order.push(['enter',result])}};
  await dispatchRpcMessage(port,{jsonrpc:'2.0',id:'create',method:'room.create'},handlers);
  assert.deepEqual(json(order),[['reply',{jsonrpc:'2.0',id:'create',result:{roomId:'ROOM'}}],['enter',{roomId:'ROOM'}]]);
  order.length=0;await dispatchRpcMessage(port,{jsonrpc:'2.0',method:'room.create'},handlers);assert.deepEqual(order,[]);
  handlers['room.create'].handle=()=>{throw Error('offline');};await dispatchRpcMessage(port,{jsonrpc:'2.0',id:'fail',method:'room.create'},handlers);
  assert.equal(order.length,1);assert.equal(order[0][1].error.message,'offline');
});
class Port extends EventTarget{messages=[];start(){}postMessage(value){this.messages.push(value);}reply(data){this.dispatchEvent(new MessageEvent('message',{data:{jsonrpc:'2.0',...data}}));}}
test('room SDK coalesces duplicate clicks, exposes errors, retries, and cleans up on bridge replacement',async()=>{
  const port=new Port(),room=createRoomClient(port),first=room.create();assert.equal(first,room.create());assert.equal(port.messages.length,1);
  assert.equal(port.messages[0].method,'room.create');assert.equal(port.messages[0].params,undefined);
  port.reply({id:port.messages[0].id,error:{code:-32000,message:'No room mode',data:{code:'ROOM_MODE_UNAVAILABLE',retryable:false}}});
  await assert.rejects(first,error=>error.code==='ROOM_MODE_UNAVAILABLE'&&!error.retryable);
  const second=room.create();port.reply({id:port.messages[1].id,result:{roomId:'ROOM'}});assert.deepEqual(await second,{roomId:'ROOM'});
  const pending=room.create();room.destroy();await assert.rejects(pending,error=>error.code==='BRIDGE_CLOSED');
  await assert.rejects(room.create(),error=>error.code==='BRIDGE_CLOSED');
});

test('minimal manifests open directly and declare a room server without modes or player limits', async () => {
  const value = { ...manifest, room: { server: manifest.modes.room.server } }; delete value.modes;
  const load = modules({fetch: async () => Response.json(value)});
  const {parseGameManifest} = load('packages/game-protocol/src/index.ts');
  const parsed = parseGameManifest(value);
  assert.deepEqual(json(parsed.modes), {solo:{}});
  const loaded = await load('apps/web/src/features/game/game-manifest.ts').loadGameManifest('https://game.example/demo/playweft.json');
  assert.equal(loaded.game.embeddedLobby, true); assert.deepEqual(json(loaded.game.modes), ['solo','room']);
  assert.equal(loaded.room.minPlayers, 1); assert.equal(loaded.room.maxPlayers, 32);
  assert.throws(() => parseGameManifest({...value,modes:manifest.modes}), /not both/);
  delete value.room; assert.deepEqual(json(parseGameManifest(value).modes), {solo:{}});
});
const roomState = (revision = 1, changes = {}) => ({roomId:'ROOM',revision,phase:'lobby',ownerId:'self',selfId:'self',
  players:[{id:'self',seat:1,ready:false}],spectators:[],minPlayers:1,maxPlayers:4,lobby:'game',inviteUrl:'https://platform.example/r/ROOM',
  permissions:{setConfiguration:true,setReady:false,setSeat:true,start:true,leave:true},...changes});
test('rooms SDK returns one EventTarget handle, confirmed immutable state, and rejects joining another room', async () => {
  const port=new Port(),rooms=createRoomsClient(port),first=rooms.create({minPlayers:3,maxPlayers:4,lobby:'platform'});
  assert.equal(first,rooms.create());assert.equal(port.messages.length,1);assert.equal(port.messages[0].method,'rooms.create');
  assert.deepEqual(port.messages[0].params,{minPlayers:3,maxPlayers:4,lobby:'platform'});
  port.reply({id:port.messages[0].id,result:roomState()});const room=await first;
  assert.ok(room instanceof EventTarget);assert.equal(rooms.current,room);assert.equal(room.id,'ROOM');
  assert.equal(await rooms.create(),room);assert.equal(await rooms.join('ROOM'),room);
  await assert.rejects(rooms.join('OTHER'),error=>error.code==='ROOM_ALREADY_JOINED');assert.equal(port.messages.length,1);
  let changes=0;room.addEventListener('statechange',()=>changes++);
  const configured=room.setConfiguration({maxPlayers:3});assert.equal(room.getConfiguration().maxPlayers,4);
  port.reply({id:port.messages.at(-1).id,result:roomState(2,{maxPlayers:3})});await configured;
  assert.equal(room.getConfiguration().maxPlayers,3);assert.equal(changes,1);
  assert.throws(()=>{room.state.players[0].seat=9;},TypeError);
  port.reply({method:'room.stateChanged',params:roomState(1)});assert.equal(changes,1);
  port.reply({method:'room.stateChanged',params:roomState(3,{maxPlayers:3,phase:'playing'})});assert.equal(changes,2);
  let closes=0;room.addEventListener('close',()=>closes++);
  const leave=room.leave(),request=port.messages.at(-1);port.reply({method:'room.closed',params:{reason:'left'}});
  port.reply({id:request.id,result:null});await leave;assert.equal(room.closed,true);assert.equal(closes,1);assert.equal(rooms.current,null);
  await assert.rejects(room.start(),error=>error.code==='ROOM_CLOSED');
  const next=rooms.create();port.reply({id:port.messages.at(-1).id,result:roomState()});assert.notEqual(await next,room);
  rooms.destroy();assert.equal(rooms.current,null);
});
test('rooms SDK serializes different openings, retries failures and rejects pending work on bridge teardown', async () => {
  const port=new Port(),rooms=createRoomsClient(port),join=rooms.join('ROOM');
  assert.equal(join,rooms.join('ROOM'));await assert.rejects(rooms.create(),e=>e.code==='ROOM_OPERATION_PENDING');
  port.reply({id:port.messages[0].id,error:{code:-32000,message:'missing',data:{code:'ROOM_NOT_FOUND'}}});
  await assert.rejects(join,e=>e.code==='ROOM_NOT_FOUND');
  const pending=rooms.create();rooms.destroy();await assert.rejects(pending,e=>e.code==='BRIDGE_CLOSED');
});

test('games without a room declaration expose the embedded host and resolve creation servers against the Manifest', async () => {
  const value={...manifest};delete value.modes;
  const load=modules({fetch:async()=>Response.json({...value,start_url:'/client/index.html'})});
  const {loadGameManifest,roomInitializationForServer}=load('apps/web/src/features/game/game-manifest.ts');
  const loaded=await loadGameManifest('https://game.example/packages/demo/playweft.json');
  assert.equal(loaded.room,undefined);assert.equal(loaded.game.embeddedLobby,true);
  const server={runtime:'lua',entry:'./online.lua',persistence:'live'};
  const initialization=roomInitializationForServer(loaded.game,server);
  assert.equal(initialization.serverUrl,'https://game.example/packages/demo/online.lua');assert.equal(initialization.liveRoom,true);
  assert.equal(initialization.gameVersion,loaded.game.version);
  for(const entry of ['https://foreign.example/game.lua','https://user:pass@game.example/game.lua','javascript:alert(1)'])
    assert.throws(()=>roomInitializationForServer(loaded.game,{...server,entry}));
  for(const invalid of [{...server,rules:{}},{...server,runtime:'js'},{...server,persistence:'other'},{...server,entry:''}])
    assert.throws(()=>roomInitializationForServer(loaded.game,invalid));
  const {roomCreateOptionsFromRpcParams,roomConfigurationFromRpcParams}=load('apps/web/src/features/room/room-lobby-bridge.ts');
  assert.deepEqual(json(roomCreateOptionsFromRpcParams({server,maxPlayers:4})),{server,maxPlayers:4});
  assert.throws(()=>roomConfigurationFromRpcParams({server}),error=>error.rpcCode===-32602);
});
