import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Minimal DOM fixture exercises the adapter independently of a physical pad.
function fixture() {
  let callback, time = 0, visible = true, focused = true;
  const all = [];
  class Element {
    constructor(tag='button', options={}) {
      this.tagName=tag.toUpperCase(); this.tabIndex=0; this.dataset={}; this.children=[];
      this.parent=null; this.isConnected=true; this.disabled=false; this.hidden=false;
      this.className=''; this.open=false; this.rect={left:0,top:0,right:40,bottom:40,width:40,height:40};
      this.listeners=new Map(); this.clicks=0; this.scrolls=0; Object.assign(this,options); all.push(this);
    }
    append(...children) { for (const child of children) {child.parent=this;this.children.push(child);} }
    matches(selector) { return selector.split(',').some(raw=>{
      const s=raw.trim();
      if(s===':disabled')return this.disabled;
      if(s==='[aria-disabled="true"]')return this.ariaDisabled;
      if(s==='[class*="backdrop"]')return this.className.includes('backdrop');
      if(s==='[class*="closing"]')return this.className.includes('closing');
      if(s==='[data-gamepad-closing="true"]')return this.dataset.gamepadClosing==='true';
      if(s==='[data-gamepad-library]')return 'gamepadLibrary' in this.dataset;
      if(s==='[data-gamepad-view]')return 'gamepadView' in this.dataset;
      if(s==='[data-gamepad-scope]')return 'gamepadScope' in this.dataset;
      if(s==='[data-gamepad-back]')return 'gamepadBack' in this.dataset;
      if(s==='[data-gamepad-context]')return 'gamepadContext' in this.dataset;
      if(s==='[data-gamepad-focus-id]')return 'gamepadFocusId' in this.dataset;
      if(s==='dialog[open]')return this.tagName==='DIALOG'&&this.open;
      if(s==='[hidden]')return this.hidden;
      if(s==='[inert]')return this.inert;
      if(s==='[aria-hidden="true"]')return this.ariaHidden;
      if(s.startsWith('.'))return this.className.split(' ').includes(s.slice(1));
      if(s==='[tabindex]')return this.tabIndex>=0;
      if(s.startsWith('input:'))return this.tagName==='INPUT';
      if(s==='a[href]')return this.tagName==='A';
      return s.toUpperCase()===this.tagName;
    }); }
    closest(s){return this.matches(s)?this:this.parent?.closest(s);}
    contains(e){return this===e||this.children.some(c=>c.contains(e));}
    querySelectorAll(s){return this.children.flatMap(c=>[...(c.matches(s)?[c]:[]),...c.querySelectorAll(s)]).filter(c=>c.isConnected);}
    getClientRects(){return this.hidden?[]:[this.rect];}
    getBoundingClientRect(){return this.rect;}
    focus(){document.activeElement=this;}
    scrollIntoView(){this.scrolls++;}
    click(){this.clicks++;this.dispatchEvent(new Event('click'));}
    addEventListener(type,fn){this.listeners.set(type,fn);}
    removeEventListener(type){this.listeners.delete(type);}
    dispatchEvent(e){this.listeners.get(e.type)?.(e);return true;}
  }
  class Select extends Element {constructor(options){super('select',options);this.options=[{disabled:false},{disabled:false}];this.selectedIndex=0;}}
  const body=new Element('body',{tabIndex:-1});
  const document={body,activeElement:body,documentElement:{classList:{toggle(){},remove(){}}},get visibilityState(){return visible?'visible':'hidden';},hasFocus:()=>focused,
    querySelectorAll:s=>body.querySelectorAll(s),querySelector:s=>body.querySelectorAll(s)[0]??null,addEventListener(){},removeEventListener(){}};
  const listeners=new Map();const window={addEventListener:(t,f)=>listeners.set(t,f),removeEventListener:t=>listeners.delete(t)};
  const pads=[{id:'pad',index:0,connected:true,mapping:'standard',buttons:Array.from({length:17},()=>({pressed:false})),axes:[0,0]}];
  function load(file, requireFn) {const module={exports:{}};const source=readFileSync(new URL('../apps/web/src/features/input/'+file,import.meta.url),'utf8');const {outputText}=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}});vm.runInNewContext(outputText,{module,exports:module.exports,require:requireFn,document,window,navigator:{getGamepads:()=>pads},HTMLElement:Element,HTMLSelectElement:Select,Event,MouseEvent:Event,getComputedStyle:()=>({visibility:'visible',display:'block'}),requestAnimationFrame:fn=>(callback=fn,1),cancelAnimationFrame(){}});return module.exports;}
  const input=load('gamepad-input.ts');const adapter=load('gamepad-navigation.ts',()=>input);
  const activity=[];const stop=adapter.startGamepadNavigation(v=>activity.push(v));
  const tick=(delta=16)=>{time+=delta;callback(time);};tick();
  const press=(button,pad=0)=>{pads[pad].buttons[button].pressed=true;tick();pads[pad].buttons[button].pressed=false;tick();};
  return {Element,Select,body,document,pads,activity,stop,tick,press,adapter,listeners,setVisible:v=>visible=v,setFocused:v=>focused=v};
}

test('first press focuses without activation; shared pads then confirm the same focus',()=>{
  const f=fixture();const a=new f.Element();f.body.append(a);f.press(0);assert.equal(f.document.activeElement,a);assert.equal(a.clicks,0);
  f.pads.push({...f.pads[0],id:'pad2',index:1,buttons:Array.from({length:17},()=>({pressed:false}))});f.tick();f.press(0,1);assert.equal(a.clicks,1);f.stop();
});
test('modal back dispatches cancel, never invokes background back or confirm',()=>{
  const f=fixture();const background=new f.Element('button',{dataset:{gamepadBack:''}});const dialog=new f.Element('dialog',{open:true,tabIndex:-1});const action=new f.Element();dialog.append(action);f.body.append(background,dialog);let cancels=0;dialog.addEventListener('cancel',()=>cancels++);action.focus();f.tick();f.press(1);assert.equal(cancels,1);assert.equal(background.clicks,0);assert.equal(action.clicks,0);
});
test('loading scope blocks background and exposes only cancel',()=>{
  const f=fixture();const background=new f.Element();const scope=new f.Element('div',{tabIndex:-1,dataset:{gamepadScope:''}});const cancel=new f.Element('button',{dataset:{gamepadBack:''}});scope.append(cancel);f.body.append(background,scope);background.focus();f.tick();f.press(0);assert.equal(f.document.activeElement,cancel);assert.equal(background.clicks,0);f.press(1);assert.equal(cancel.clicks,1);
  cancel.isConnected=false;f.press(0);assert.equal(background.clicks,0);
});
test('closing dialog rejects another controller confirmation',()=>{
  const f=fixture();const dialog=new f.Element('dialog',{open:true,tabIndex:-1,dataset:{gamepadClosing:'true'}});const action=new f.Element();dialog.append(action);f.body.append(dialog);action.focus();f.tick();f.press(0);assert.equal(action.clicks,0);
});
test('context action uses the card context menu and menu back stays scoped',()=>{
  const f=fixture();const card=new f.Element('a',{dataset:{gamepadContext:''}});f.body.append(card);card.focus();let contexts=0;card.addEventListener('contextmenu',()=>contexts++);f.press(2);assert.equal(contexts,1);
  const menu=new f.Element('div',{tabIndex:-1,dataset:{gamepadScope:''},className:'menu'});f.body.append(menu);let backs=0;menu.addEventListener('gamepadback',()=>backs++);f.tick();f.press(1);assert.equal(backs,1);
});
test('game consumes ordinary input; only held chord opens host menu once',()=>{
  const f=fixture();const frame=new f.Element('iframe',{className:'game-frame',tabIndex:-1});const menu=new f.Element('button',{className:'platform-menu-button'});f.body.append(frame,menu);menu.focus();f.press(0);f.press(1);f.press(15);assert.equal(menu.clicks,0);
  f.pads[0].buttons[8].pressed=true;f.pads[0].buttons[9].pressed=true;f.tick();f.tick(500);assert.equal(menu.clicks,1);f.tick(1000);assert.equal(menu.clicks,1);
});
test('select editing changes value; first back finishes editing, second closes dialog',()=>{
  const f=fixture();const dialog=new f.Element('dialog',{open:true,tabIndex:-1});const select=new f.Select();dialog.append(select);f.body.append(dialog);select.focus();f.tick();let changes=0,cancels=0;select.addEventListener('change',()=>changes++);dialog.addEventListener('cancel',()=>cancels++);f.press(0);f.press(13);assert.equal(select.selectedIndex,1);assert.equal(changes,1);f.press(1);assert.equal(cancels,0);f.press(1);assert.equal(cancels,1);
});
test('pointer input hides focus styling and hidden-tab input is not replayed',()=>{
  const f=fixture();const a=new f.Element();f.body.append(a);a.focus();f.press(0);assert.equal(a.clicks,1);f.listeners.get('pointerdown')();assert.deepEqual(f.activity,[true,false]);f.setVisible(false);f.pads[0].buttons[0].pressed=true;f.tick();f.setVisible(true);f.tick();assert.equal(a.clicks,1);f.pads[0].buttons[0].pressed=false;f.tick();f.press(0);assert.equal(a.clicks,2);
});
test('scope closure restores the invoking focus',()=>{
  const f=fixture();const card=new f.Element('a');f.body.append(card);card.focus();f.press(15);const menu=new f.Element('div',{tabIndex:-1,dataset:{gamepadScope:''},className:'menu'});const action=new f.Element();menu.append(action);f.body.append(menu);action.focus();f.tick();menu.isConnected=false;f.body.children=f.body.children.filter(e=>e!==menu);f.document.activeElement=f.body;f.tick();assert.equal(f.document.activeElement,card);
});

test('central Guide opens the host menu, then dismisses the modal without confirming',()=>{
  const f=fixture();const frame=new f.Element('iframe',{className:'game-frame',tabIndex:-1});const menu=new f.Element('button',{className:'platform-menu-button'});f.body.append(frame,menu);f.tick();f.press(16);assert.equal(menu.clicks,1);
  const dialog=new f.Element('dialog',{open:true,tabIndex:-1});const action=new f.Element();dialog.append(action);f.body.append(dialog);action.focus();let cancels=0;dialog.addEventListener('cancel',()=>cancels++);f.tick();f.pads[0].buttons[16].pressed=true;f.pads[0].buttons[0].pressed=true;f.tick();assert.equal(cancels,1);assert.equal(action.clicks,0);f.tick(1000);assert.equal(cancels,1);assert.equal(action.clicks,0);
});

function navigationRow(f, {library=false, modal=false, menu=false}={}) {
  const root=new f.Element(modal?'dialog':'div',{open:modal,tabIndex:-1,dataset:{...(library?{gamepadLibrary:''}:{}),...(menu?{gamepadScope:''}:{}),gamepadView:'test'}});
  const buttons=Array.from({length:100},(_,i)=>new f.Element('button',{rect:{left:i*60,top:0,right:i*60+40,bottom:40,width:40,height:40}}));
  root.append(...buttons);f.body.append(root);buttons[0].focus();f.tick();return {root,buttons};
}

test('only explicit library focus accelerates; dialogs and menus stay at normal speed',()=>{
  const run=(options)=>{const f=fixture();const {buttons}=navigationRow(f,options);f.pads[0].buttons[15].pressed=true;f.tick();for(let i=0;i<175;i++)f.tick(20);return buttons.indexOf(f.document.activeElement);};
  const normal=run({});assert.ok(normal>20);assert.ok(run({library:true})>normal);
  assert.equal(run({library:true,modal:true}),normal);
  assert.equal(run({library:true,menu:true}),normal);
});

test('opening and closing a modal baselines held input instead of carrying fast repeats',()=>{
  const f=fixture();const {buttons}=navigationRow(f,{library:true});f.pads[0].buttons[15].pressed=true;f.tick();for(let i=0;i<175;i++)f.tick(20);
  const dialog=new f.Element('dialog',{open:true,tabIndex:-1});const first=new f.Element();const second=new f.Element('button',{rect:{left:60,top:0,right:100,bottom:40,width:40,height:40}});dialog.append(first,second);f.body.append(dialog);first.focus();f.tick();f.tick(1000);assert.equal(f.document.activeElement,first);
  f.pads[0].buttons[15].pressed=false;f.tick();f.press(15);assert.equal(f.document.activeElement,second);
  // Start another hold, then remove the modal while the stick stays pushed.
  f.pads[0].buttons[15].pressed=true;f.tick();dialog.isConnected=false;f.body.children=f.body.children.filter(e=>e!==dialog);buttons[0].focus();f.tick();const restored=f.document.activeElement;f.tick(1000);assert.equal(f.document.activeElement,restored);
});

test('view replacement and state transitions discard held confirmation and movement',()=>{
  const f=fixture();const {root,buttons}=navigationRow(f,{library:true});f.pads[0].buttons[15].pressed=true;f.tick();for(let i=0;i<175;i++)f.tick(20);
  root.dataset.gamepadView='next-screen';buttons[0].focus();f.pads[0].buttons[0].pressed=true;f.tick();f.tick(1000);assert.equal(f.document.activeElement,buttons[0]);assert.equal(buttons[0].clicks,0);
  root.isConnected=false;f.body.children=[];const next=navigationRow(f,{library:true});f.tick(1000);assert.equal(f.document.activeElement,next.buttons[0]);assert.equal(next.buttons[0].clicks,0);
  f.pads[0].buttons[0].pressed=false;f.pads[0].buttons[15].pressed=false;f.tick();f.press(0);assert.equal(next.buttons[0].clicks,1);
});
