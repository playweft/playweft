import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const game={manifestId:"demo",manifestUrl:"https://games.example/demo/playweft.json",name:"Demo"};
function fixture(sortable=false) {
  const timers=new Map(), listeners=new Map(), cleanups=[];
  const selections=[],menus=[];
  let nextTimer=0;
  const window={
    addEventListener(type,fn,capture){listeners.set(type,{fn,capture});},
    removeEventListener(type){listeners.delete(type);},
    setTimeout(fn){timers.set(++nextTimer,fn);return nextTimer;},
    clearTimeout(id){timers.delete(id);},
  };
  const jsx=(type,props,key)=>({type,props,key});
  const imports={
    "react/jsx-runtime":{jsx,jsxs:jsx},
    react:{useRef:value=>({current:value}),useState:value=>[value,()=>{}],useCallback:fn=>fn,
      useEffect:fn=>{const cleanup=fn();if(cleanup)cleanups.push(cleanup);},useLayoutEffect(){}},
    "@/features/game/game-launch-link":{gameLaunchPath:()=>"/g/demo/"},
    "@/app/i18n":{useI18n:()=>({locale:"en"}),localizeGameName:game=>game.name},
    "@dnd-kit/core":{DndContext:"DndContext",MouseSensor:{},TouchSensor:{},closestCenter(){},useSensor(){},useSensors(){}},
    "@dnd-kit/sortable":{SortableContext:"SortableContext",arrayMove(){},rectSortingStrategy:{},useSortable:()=>({attributes:{role:"button",tabIndex:0},listeners:{},setNodeRef(){},isDragging:false})},
    "@dnd-kit/utilities":{CSS:{Transform:{toString(){}}}},
  };
  const source=readFileSync(new URL('../apps/web/src/features/library/GameShelf.tsx',import.meta.url),'utf8');
  const {outputText}=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}});
  const module={exports:{}};
  vm.runInNewContext(outputText,{module,exports:module.exports,window,require:name=>{assert.ok(name in imports,name);return imports[name];}});
  const tree=module.exports.default({title:"Games",kind:sortable?"favorite":"recommended",games:sortable?[game,{...game,manifestId:"other"}]:[game],onSelect:game=>selections.push(game),onOpenMenu:(...args)=>menus.push(args),...(sortable?{onReorder(){}}:{})});
  const section=sortable?tree.props.children.props.children:tree;
  const target={};section.props.ref.current={contains:value=>value===target};
  let card=section.props.children[1].props.children[0];
  while(typeof card.type==='function')card=card.type(card.props);
  const link=card.props.children;
  function event(extra={}) {
    return {button:0,defaultPrevented:false,stopped:false,target,
      preventDefault(){this.defaultPrevented=true;},stopPropagation(){this.stopped=true;},...extra};
  }
  function click(extra={}) {
    const e=event(extra);listeners.get('click')?.fn(e);
    if(!e.stopped)link.props.onClick(e);
    return e;
  }
  return {tree,section,link,event,click,selections,menus,timers,listeners,destroy:()=>cleanups.forEach(fn=>fn())};
}

test('shelf cards expose real links and intercept only ordinary clicks',()=>{
  const f=fixture();assert.equal(f.link.type,'a');assert.equal(f.link.props.href,'/g/demo/');
  assert.equal(f.link.props.draggable,false);assert.equal(f.link.props.role,'link');
  assert.equal(f.click().defaultPrevented,true);assert.equal(f.selections.length,1);
  for(const extra of [{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true},{button:1}]) {
    assert.equal(f.click(extra).defaultPrevented,false);
  }
  assert.equal(f.selections.length,1);f.destroy();assert.equal(f.listeners.size,0);
});
test('touch long press opens the custom menu and cancels the following link navigation',()=>{
  const f=fixture();
  f.link.props.onTouchStart({touches:[{clientX:10,clientY:20}]});
  [...f.timers.values()][0]();assert.equal(f.menus.length,1);
  f.link.props.onTouchEnd({});
  assert.equal(f.click().defaultPrevented,true);assert.equal(f.selections.length,0);
  f.section.props.onPointerDownCapture();f.click();assert.equal(f.selections.length,1);f.destroy();
});
test('moving a touch before the long-press threshold retains normal activation',()=>{
  const f=fixture();f.link.props.onTouchStart({touches:[{clientX:0,clientY:0}]});
  f.link.props.onTouchMove({touches:[{clientX:20,clientY:20}]});assert.equal(f.timers.size,0);
  f.click();assert.equal(f.selections.length,1);assert.equal(f.menus.length,0);f.destroy();
});
test('sortable anchors keep link semantics and cancel native navigation after a drag',()=>{
  const f=fixture(true);assert.equal(f.link.props.role,'link');
  f.tree.props.onDragStart({activatorEvent:{}});
  assert.equal(f.listeners.get('click').capture,true);
  const click=f.click();assert.equal(click.defaultPrevented,true);assert.equal(click.stopped,true);
  assert.equal(f.selections.length,0);
  // A fresh gesture must not be swallowed, including after a cancelled drag.
  f.tree.props.onDragStart({activatorEvent:{}});f.section.props.onKeyDownCapture();
  f.click();assert.equal(f.selections.length,1);f.destroy();
});
