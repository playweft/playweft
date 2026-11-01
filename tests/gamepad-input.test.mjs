import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../apps/web/src/features/input/gamepad-input.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
const module = { exports: {} };
vm.runInNewContext(outputText, { module, exports: module.exports });
const { GamepadInput, findNextFocus } = module.exports;
function pad({ index = 0, id = 'pad', buttons = [], axes = [0, 0], mapping = 'standard', connected = true } = {}) {
  return { index, id, mapping, connected, axes, buttons: Array.from({ length: 17 }, (_, index) => ({ pressed: buttons.includes(index) })) };
}
const poll = (input, pads, now = 0) => Array.from(input.poll(pads, now));

test('new devices and reconnects do not activate held controls', () => {
  const input = new GamepadInput();
  assert.deepEqual(poll(input, [pad({ buttons: [0, 15] })]), []);
  assert.deepEqual(poll(input, [pad({ buttons: [0, 15] })], 1000), []);
  poll(input, [pad()], 1001);
  assert.deepEqual(poll(input, [pad({ buttons: [0, 15] })], 1002), ['confirm', 'right']);
  poll(input, [], 1003);
  assert.deepEqual(poll(input, [pad({ buttons: [0, 15] })], 1004), []);
});

test('direction repeats after delay and never catches up after a stall', () => {
  const input = new GamepadInput();
  poll(input, [pad()]);
  const right = pad({ buttons: [15] });
  assert.deepEqual(poll(input, [right], 10), ['right']);
  assert.deepEqual(poll(input, [right], 409), []);
  assert.deepEqual(poll(input, [right], 410), ['right']);
  assert.deepEqual(poll(input, [right], 529), []);
  assert.deepEqual(poll(input, [right], 530), ['right']);
  assert.deepEqual(poll(input, [right], 10000), ['right']);
  assert.deepEqual(poll(input, [right], 10001), []);
});

test('stick deadzone, dominant axis, opposing directions and malformed axes', () => {
  const input = new GamepadInput();
  poll(input, [pad()]);
  assert.deepEqual(poll(input, [pad({ axes: [0.54, -0.54] })], 1), []);
  assert.deepEqual(poll(input, [pad({ axes: [0.8, -0.6] })], 2), ['right']);
  assert.deepEqual(poll(input, [pad({ axes: [0.6, -0.8] })], 3), ['up']);
  assert.deepEqual(poll(input, [pad({ buttons: [12, 13], axes: [NaN, Infinity] })], 4), []);
  assert.deepEqual(poll(input, [pad({ buttons: [14], axes: [0.8, 0] })], 5), []);
});

test('buttons are edge-triggered and mapped to confirm/back/context', () => {
  const input = new GamepadInput();
  poll(input, [pad()]);
  assert.deepEqual(poll(input, [pad({ buttons: [0, 1, 2] })], 1), ['confirm', 'back', 'context']);
  assert.deepEqual(poll(input, [pad({ buttons: [0, 1, 2] })], 10000), []);
});

test('all standard controllers contribute without ownership and duplicates merge', () => {
  const input = new GamepadInput();
  poll(input, [pad(), pad({ index: 1 })]);
  assert.deepEqual(poll(input, [pad(), pad({ index: 1, buttons: [15] })], 1), ['right']);
  poll(input, [pad(), pad({ index: 1 })], 2);
  assert.deepEqual(poll(input, [pad({ buttons: [0] }), pad({ index: 1, buttons: [0] })], 3), ['confirm']);
  poll(input, [pad(), pad({ index: 1 })], 4);
  assert.deepEqual(poll(input, [pad({ buttons: [2] }), pad({ index: 1, buttons: [1] })], 5), ['context', 'back']);
});

test('unmapped and disconnected controllers are ignored; reset baselines held buttons', () => {
  const input = new GamepadInput();
  poll(input, [pad()]);
  assert.deepEqual(poll(input, [null, pad({ mapping: '', buttons: [0] }), pad({ index: 1, connected: false, buttons: [0] })], 1), []);
  poll(input, [pad()], 2);
  input.reset();
  assert.deepEqual(poll(input, [pad({ buttons: [0] })], 3), []);
});

test('menu chord requires a deliberate hold and fires once, suppressing other actions', () => {
  const input = new GamepadInput();
  poll(input, [pad()]);
  const chord = pad({ buttons: [8, 9, 0, 15] });
  assert.deepEqual(poll(input, [chord], 10), []);
  assert.deepEqual(poll(input, [chord], 509), []);
  assert.deepEqual(poll(input, [chord], 510), ['menu']);
  assert.deepEqual(poll(input, [chord], 2000), []);
  assert.deepEqual(poll(input, [pad({ buttons: [0, 15] })], 2001), []);
  poll(input, [pad()], 2002);
  assert.deepEqual(poll(input, [pad({ buttons: [0] })], 2003), ['confirm']);
});

test('menu chord held on connect is ignored and cancelled hold can be retried', () => {
  const input = new GamepadInput();
  const chord = pad({ buttons: [8, 9] });
  poll(input, [chord]);
  assert.deepEqual(poll(input, [chord], 1000), []);
  poll(input, [pad()], 1001);
  poll(input, [chord], 1010);
  poll(input, [pad()], 1200);
  poll(input, [chord], 1300);
  assert.deepEqual(poll(input, [chord], 1799), []);
  assert.deepEqual(poll(input, [chord], 1800), ['menu']);
});

const rect = (x, y, w = 80, h = 60) => ({ left: x, top: y, right: x + w, bottom: y + h });
test('spatial focus follows rows and columns, with no edge wrap', () => {
  const rects = [rect(0, 0), rect(100, 0), rect(0, 100), rect(100, 100)];
  assert.equal(findNextFocus(rects, 0, 'right'), 1);
  assert.equal(findNextFocus(rects, 0, 'down'), 2);
  assert.equal(findNextFocus(rects, 3, 'left'), 2);
  assert.equal(findNextFocus(rects, 3, 'up'), 1);
  assert.equal(findNextFocus(rects, 0, 'left'), 0);
});
test('spatial focus prefers aligned candidates and ignores invalid geometry', () => {
  const rects = [rect(0, 0), rect(100, 100), rect(200, 0), rect(0, 0, 0, 0)];
  assert.equal(findNextFocus(rects, 0, 'right'), 2);
  assert.equal(findNextFocus(rects, -1, 'down'), 0);
  assert.equal(findNextFocus([], -1, 'down'), -1);
});

test('Guide is one menu action per rising edge and suppresses held confirm/direction', () => {
  const input = new GamepadInput();
  poll(input, [pad()]);
  assert.deepEqual(poll(input, [pad({ buttons: [16, 0, 15] })], 1), ['menu']);
  assert.deepEqual(poll(input, [pad({ buttons: [16, 0, 15] })], 1000), []);
  assert.deepEqual(poll(input, [pad({ buttons: [0, 15] })], 1001), []);
  poll(input, [pad()], 1002);
  assert.deepEqual(poll(input, [pad({ buttons: [16] })], 1003), ['menu']);
});

test('Guide held on connect, reconnect or reset is not an opening action', () => {
  const input = new GamepadInput();
  const held = pad({ buttons: [16] });
  assert.deepEqual(poll(input, [held]), []);
  assert.deepEqual(poll(input, [held], 1000), []);
  poll(input, [pad()], 1001);
  assert.deepEqual(poll(input, [held], 1002), ['menu']);
  poll(input, [], 1003);
  assert.deepEqual(poll(input, [held], 1004), []);
  input.reset();
  assert.deepEqual(poll(input, [held], 1005), []);
});

test('missing or newly exposed Guide is safe and fallback chord still works', () => {
  const input = new GamepadInput();
  const withoutGuide = (buttons = []) => { const p = pad({ buttons }); p.buttons.length = 16; return p; };
  poll(input, [withoutGuide()]);
  assert.deepEqual(poll(input, [withoutGuide([8, 9])], 10), []);
  assert.deepEqual(poll(input, [withoutGuide([8, 9])], 510), ['menu']);
  poll(input, [withoutGuide()], 511);
  assert.deepEqual(poll(input, [pad({ buttons: [16] })], 512), []);
  poll(input, [pad()], 513);
  assert.deepEqual(poll(input, [pad({ buttons: [16] })], 514), ['menu']);
  assert.deepEqual(poll(input, [pad({ index: 1, mapping: '', buttons: [16] })], 515), []);
});

test('Guide wins over simultaneous pads and consumes a simultaneous menu chord', () => {
  const input = new GamepadInput();
  poll(input, [pad(), pad({ index: 1 })]);
  assert.deepEqual(poll(input, [pad({ buttons: [0] }), pad({ index: 1, buttons: [16, 8, 9] })], 10), ['menu']);
  assert.deepEqual(poll(input, [pad({ buttons: [0] }), pad({ index: 1, buttons: [8, 9] })], 600), []);
  poll(input, [pad(), pad({ index: 1 })], 601);
  assert.deepEqual(poll(input, [pad(), pad({ index: 1, buttons: [16] })], 602), ['menu']);
});

test('Guide interrupting a partial chord resets the fallback hold timer', () => {
  const input = new GamepadInput();
  poll(input, [pad()]);
  poll(input, [pad({ buttons: [8, 9] })], 10);
  assert.deepEqual(poll(input, [pad({ buttons: [16] })], 100), ['menu']);
  assert.deepEqual(poll(input, [pad({ buttons: [8, 9] })], 600), []);
  assert.deepEqual(poll(input, [pad({ buttons: [8, 9] })], 1099), []);
  assert.deepEqual(poll(input, [pad({ buttons: [8, 9] })], 1100), ['menu']);
});
