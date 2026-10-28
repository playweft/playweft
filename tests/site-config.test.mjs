import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function load(path, imports = {}, extras = {}) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  }});
  const module = { exports: {} };
  vm.runInNewContext(outputText, { module, exports: module.exports, URL, Error,
    require: name => { assert.ok(name in imports, name); return imports[name]; }, ...extras });
  return module.exports;
}
const { parseSiteConfig } = load('../apps/web/src/app/site-config-schema.ts');
const plain = value => JSON.parse(JSON.stringify(value));
test('defaults, explicit empty lists and the checked-in example parse', () => {
  assert.deepEqual(plain(parseSiteConfig({})), { featuredGames: [{manifestUrl:'/games/rps/playweft.json'}], banners: [], urlMappings: [] });
  assert.deepEqual(plain(parseSiteConfig({featuredGames:[], banners:[]})), {featuredGames:[],banners:[],urlMappings:[]});
  parseSiteConfig(JSON.parse(readFileSync(new URL('../apps/web/site.config.example.json',import.meta.url),'utf8')));
});
test('sources and banners preserve order and accept relative and HTTP(S) URLs', () => {
  const config = { featuredGames: [{listUrl:'https://games.example/list.json'},{manifestUrl:'/games/demo/playweft.json'}],
    banners: [{image:'/event.webp',alt:'Event',href:'/?game=games.example/demo/'},{image:'https://cdn.example/image.webp',alt:'Second',href:'https://example.com/'}] };
  assert.deepEqual(plain(parseSiteConfig(config)), {...config,urlMappings:[]});
});
test('invalid structure, ambiguous sources, typos and unsafe URLs fail with field paths', () => {
  for (const value of [[],null,{featuredGames:null},{banners:null},{banner:[]},{featuredGames:[{}]},
    {featuredGames:[{manifestUrl:'/a',listUrl:'/b'}]},{featuredGames:[{manifestUrl:'javascript:alert(1)'}]},
    {banners:[{image:'/a',alt:'',href:'/b'}]},{banners:[{image:'/a',alt:'A'}]},
    {banners:[{image:'data:image/png;base64,a',alt:'A',href:'/b'}]},
    {banners:[{image:'/a',alt:'A',href:'https://user:pass@example.com'}]},
    {banners:[{image:'/a',alt:'A',href:'javascript:alert(1)'}]}]) {
    assert.throws(()=>parseSiteConfig(value),/Invalid site config:/);
  }
});
test('banner rendering exposes links, hides failed images and keeps the loop clone out of keyboard and screen-reader navigation', () => {
  const config = parseSiteConfig({banners:[{image:'/a.webp',alt:'First event',href:'/a'},{image:'/b.webp',alt:'Second event',href:'/b'}]});
  const jsx = (type, props, key) => ({type,props,key});
  let index=0; const slots=[];
  const { default: SiteBanners } = load('../apps/web/src/features/home/SiteBanners.tsx', {
    '@/app/site-config': {siteConfig:config},
    '@/app/i18n':{useI18n:()=>({t:key=>key})},
    './banner-rotation':{attachBannerRotation(){}},
    'lucide-react':{Pause:'Pause',Play:'Play'},
    react: {useState:initial=>{ const i=index++; if(!(i in slots)) slots[i]=typeof initial==='function'?initial():initial;
      return [slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}]; }, useRef:()=>({current:null}),useLayoutEffect(){}},
    'react/jsx-runtime':{jsx,jsxs:jsx},
  });
  const render=()=>{index=0;return SiteBanners();};
  let tree=render();
  let strip=tree.props.children;
  assert.equal(strip.props.children.length,6);
  assert.equal(strip.props.children[2].props.href,'/a');
  assert.equal(strip.props.children[2].props.children.props.alt,'First event');
  const clone=strip.props.children[0];
  assert.equal(clone.props.href,'/a');
  assert.equal(clone.props['data-banner-clone'],'true');
  assert.equal(clone.props['aria-hidden'],true);
  assert.equal(clone.props.tabIndex,-1);
  strip.props.children[0].props.children.props.onError();
  tree=render();
  assert.equal(tree.props.children.props.children.length,1);
  tree.props.children.props.children[0].props.children.props.onError();
  assert.equal(render(),null);
});

function rotationFixture(observeVisibility = false) {
  function events(extra={}) {
    const listeners=new Map();
    return {...extra,addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);},
      removeEventListener(type,fn){listeners.get(type)?.delete(fn);},
      emit(type,event={}){for(const fn of listeners.get(type)??[])fn(event);},
      listenerCount(){return [...listeners.values()].reduce((sum,set)=>sum+set.size,0);}};
  }
  const timers=new Map();let next=0;
  const media=events({matches:false});
  const doc=events({hidden:false,activeElement:null});
  const win={matchMedia:()=>media,setTimeout(fn,delay){timers.set(++next,{fn,delay});return next;},clearTimeout(id){timers.delete(id);}};
  const surface=events({contains:element=>element==='focused'});
  const positions=[0,1016,2032,3048,4064,5080];const calls=[];const motions=[];
  const slides=positions.map((left,index)=>({getBoundingClientRect:()=>({left:left-viewport.scrollLeft}),
    hasAttribute:()=>index<2||index>=4}));
  const viewport=events({scrollLeft:0,getBoundingClientRect:()=>({left:0}),
    querySelectorAll:()=>slides,
    scrollTo(options){calls.push(options.left);motions.push(options.behavior);viewport.scrollLeft=options.left;}});
  let visibilityCallback, disconnected=false;
  class Observer {
    constructor(callback){visibilityCallback=callback;}
    observe(){}
    disconnect(){disconnected=true;}
  }
  const {attachBannerRotation}=load('../apps/web/src/features/home/banner-rotation.ts',{}, {window:win,document:doc,...(observeVisibility?{IntersectionObserver:Observer}:{})});
  const cleanup=attachBannerRotation(viewport,surface);
  return {surface,viewport,doc,media,timers,calls,motions,cleanup,visibility(value){visibilityCallback([{isIntersecting:value,intersectionRatio:value?1:0}]);},get disconnected(){return disconnected;},tick(){assert.ok(timers.size>0);const [id,{fn}]=[...timers].sort((a,b)=>a[1].delay-b[1].delay)[0];timers.delete(id);fn();}};
}
test('automatic rotation advances into the trailing clone and resets without reversing its animation',()=>{
 const f=rotationFixture();
 assert.equal(f.viewport.scrollLeft,2032);
 assert.equal([...f.timers.values()][0].delay,5000);
 f.tick();assert.equal(f.calls.at(-1),3048);
 f.tick();assert.equal(f.calls.at(-1),4064);
 assert.deepEqual(f.motions,['instant','smooth','smooth']);
 f.viewport.emit('scroll');f.tick();assert.equal(f.calls.at(-1),2032);assert.equal(f.motions.at(-1),'instant');
 f.cleanup();assert.equal(f.timers.size,0);
 assert.equal(f.surface.listenerCount()+f.viewport.listenerCount()+f.doc.listenerCount()+f.media.listenerCount(),0);
});
test('swiping backward from the first banner wraps to the last and subsequent auto play moves forward',()=>{
 const f=rotationFixture();
 f.surface.emit('pointerdown');f.viewport.scrollLeft=1016;f.viewport.emit('scroll');
 f.tick();assert.equal(f.viewport.scrollLeft,1016); // Do not reset beneath a finger.
 f.doc.emit('pointerup');assert.equal(f.viewport.scrollLeft,3048);
 f.tick();assert.equal(f.calls.at(-1),4064);assert.equal(f.motions.at(-1),'smooth');
 f.cleanup();
});
test('offscreen carousels pause, becoming visible restarts a full interval, and observers are cleaned up',()=>{
 const f=rotationFixture(true);
 assert.equal(f.timers.size,0);
 f.visibility(true);assert.equal([...f.timers.values()][0].delay,5000);
 f.tick();assert.equal(f.calls.at(-1),3048);
 f.visibility(false);assert.equal(f.timers.size,0);
 f.visibility(true);assert.equal([...f.timers.values()][0].delay,5000);
 f.cleanup();assert.equal(f.disconnected,true);assert.equal(f.timers.size,0);
});
test('hover, dragging, focus, hidden tabs and reduced motion suspend rotation; resuming waits a full interval',()=>{
 const f=rotationFixture();
 f.surface.emit('pointerenter',{pointerType:'mouse'});assert.equal(f.timers.size,0);
 f.surface.emit('pointerleave');assert.equal(f.timers.size,1);
 f.surface.emit('pointerdown');assert.equal(f.timers.size,0);
 f.doc.emit('pointerup');assert.equal(f.timers.size,1);
 f.doc.activeElement='focused';f.surface.emit('focusin');assert.equal(f.timers.size,0);
 f.surface.emit('focusout');f.doc.activeElement=null;f.tick();assert.equal([...f.timers.values()][0].delay,5000);
 f.doc.hidden=true;f.doc.emit('visibilitychange');assert.equal(f.timers.size,0);
 f.doc.hidden=false;f.doc.emit('visibilitychange');assert.equal(f.timers.size,1);
 f.media.matches=true;f.media.emit('change');assert.equal(f.timers.size,0);
 f.media.matches=false;f.media.emit('change');assert.equal(f.timers.size,1);
 f.cleanup();
});

const { gameUrlFromMappedPath, mappedPathFromGameUrl } = load('../apps/web/src/app/url-mapping.ts');
test('aliases resolve internally and generated game URLs map back to the shortest configured path', () => {
  const mappings = parseSiteConfig({ urlMappings: [
    {prefix:'/abc/',target:'https://games.example/base/'},
    {prefix:'special',target:'https://games.example/base/special/'},
    {prefix:'local',target:'/bundled/'},
  ] }).urlMappings;
  const origin='https://platform.example';
  assert.equal(gameUrlFromMappedPath('/abc/xxx?mode=solo',mappings,origin),'https://games.example/base/xxx');
  assert.equal(gameUrlFromMappedPath('/abc',mappings,origin),'https://games.example/base/');
  assert.equal(gameUrlFromMappedPath('/local/demo',mappings,origin),'https://platform.example/bundled/demo');
  assert.equal(gameUrlFromMappedPath('/abcdef/xxx',mappings,origin),undefined);
  assert.equal(gameUrlFromMappedPath('/r/room',mappings,origin),undefined);
  assert.equal(gameUrlFromMappedPath('https://other.example/abc/x',mappings,origin),undefined);
  assert.equal(gameUrlFromMappedPath('/abc//evil.example/x',mappings,origin),'https://games.example/base/evil.example/x');
  assert.equal(mappedPathFromGameUrl('https://games.example/base/xxx',mappings,origin),'/abc/xxx');
  assert.equal(mappedPathFromGameUrl('https://games.example/base/special/demo/',mappings,origin),'/special/demo/');
  assert.equal(mappedPathFromGameUrl('https://games.example/base/a%20b/',mappings,origin),'/abc/a%20b/');
  assert.equal(mappedPathFromGameUrl('https://games.example/baseball/x',mappings,origin),undefined);
  assert.equal(mappedPathFromGameUrl('https://games.example/base/x?token=1',mappings,origin),undefined);
  assert.equal(mappedPathFromGameUrl('https://other.example/base/x',mappings,origin),undefined);
  const shadowed=[{prefix:'abc',target:'https://games.example/'},{prefix:'abc/special',target:'https://other.example/'}];
  assert.equal(mappedPathFromGameUrl('https://games.example/special/demo',shadowed,origin),undefined);
});
test('invalid URL mappings fail at build time', () => {
  for (const urlMappings of [null,false,{},[{}],[{prefix:'/',target:'/x'}],
    [{prefix:'api',target:'/x'}],[{prefix:'r/x',target:'/x'}],
    [{prefix:'a/../b',target:'/x'}],[{prefix:'a',target:'javascript:alert(1)'}],
    [{prefix:'a',target:'//other.example'}],[{prefix:'a',target:'https://games.example/?game=x'}],
    [{prefix:'a',target:'/x#hash'}],[{prefix:'a',target:'relative/path'}],
    [{prefix:'a',target:'/x'},{prefix:'/a/',target:'/y'}]]) {
    assert.throws(()=>parseSiteConfig({urlMappings}),/Invalid site config:/);
  }
});

test('mapping prefixes trim surrounding whitespace and slashes', () => {
  for (const prefix of ['abc','/abc','abc/','/abc/','  ///abc///  ']) {
    assert.equal(parseSiteConfig({urlMappings:[{prefix,target:'/bundled/'}]}).urlMappings[0].prefix,'abc');
  }
  assert.equal(parseSiteConfig({urlMappings:[{prefix:'/abc/sub/',target:'/bundled/'}]}).urlMappings[0].prefix,'abc/sub');
});
