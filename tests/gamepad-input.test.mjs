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
const poll = (input, pads, now = 0, accelerate = false) => Array.from(input.poll(pads, now, accelerate));

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

test('optional acceleration schedules 120/80/60 ms intervals with a 60 ms cap', () => {
  const input = new GamepadInput();
  const right = pad({ buttons: [15] });
  poll(input, [pad()], 0, true);
  assert.deepEqual(poll(input, [right], 10, true), ['right']);
  assert.deepEqual(poll(input, [right], 409, true), []);
  assert.deepEqual(poll(input, [right], 410, true), ['right']);
  // Each repeat selects its next interval from the hold duration at that step.
  assert.deepEqual(poll(input, [right], 1490, true), ['right']);
  assert.deepEqual(poll(input, [right], 1609, true), []);
  assert.deepEqual(poll(input, [right], 1610, true), ['right']);
  assert.deepEqual(poll(input, [right], 1689, true), []);
  assert.deepEqual(poll(input, [right], 1690, true), ['right']);
  assert.deepEqual(poll(input, [right], 3010, true), ['right']);
  assert.deepEqual(poll(input, [right], 3069, true), []);
  assert.deepEqual(poll(input, [right], 3070, true), ['right']);
  assert.deepEqual(poll(input, [right], 100000, true), ['right']);
  assert.deepEqual(poll(input, [right], 100001, true), []);
  assert.deepEqual(poll(input, [right], 100059, true), []);
  assert.deepEqual(poll(input, [right], 100060, true), ['right']);
});

test('acceleration thresholds include exactly 1500 and 3000 ms', () => {
  for (const [duration, interval] of [[1499, 120], [1500, 80], [2999, 80], [3000, 60]]) {
    const input = new GamepadInput();
    const right = pad({ buttons: [15] });
    poll(input, [pad()], 0, true);
    poll(input, [right], 1, true);
    assert.deepEqual(poll(input, [right], 1 + duration, true), ['right']);
    assert.deepEqual(poll(input, [right], duration + interval, true), []);
    assert.deepEqual(poll(input, [right], 1 + duration + interval, true), ['right']);
  }
});

test('disabled acceleration stays at 120 ms even for a long hold', () => {
  const input = new GamepadInput();
  const right = pad({ buttons: [15] });
  poll(input, [pad()]);
  poll(input, [right], 1);
  assert.deepEqual(poll(input, [right], 5000), ['right']);
  assert.deepEqual(poll(input, [right], 5119), []);
  assert.deepEqual(poll(input, [right], 5120), ['right']);
});

test('direction change and release restart the acceleration and initial delay', () => {
  const input = new GamepadInput();
  const right = pad({ buttons: [15] });
  const left = pad({ buttons: [14] });
  poll(input, [pad()], 0, true);
  poll(input, [right], 1, true);
  poll(input, [right], 5000, true);
  assert.deepEqual(poll(input, [left], 5001, true), ['left']);
  assert.deepEqual(poll(input, [left], 5400, true), []);
  assert.deepEqual(poll(input, [left], 5401, true), ['left']);
  assert.deepEqual(poll(input, [left], 5520, true), []);
  assert.deepEqual(poll(input, [left], 5521, true), ['left']);
  poll(input, [pad()], 9000, true);
  assert.deepEqual(poll(input, [left], 9001, true), ['left']);
  assert.deepEqual(poll(input, [left], 9400, true), []);
  assert.deepEqual(poll(input, [left], 9401, true), ['left']);
});

test('changing acceleration scope restarts delay without an extra navigation step', () => {
  const input = new GamepadInput();
  const right = pad({ buttons: [15] });
  poll(input, [pad()], 0, true);
  poll(input, [right], 1, true);
  poll(input, [right], 5000, true);
  assert.deepEqual(poll(input, [right], 5060, false), []);
  assert.deepEqual(poll(input, [right], 5459, false), []);
  assert.deepEqual(poll(input, [right], 5460, false), ['right']);
  assert.deepEqual(poll(input, [right], 5579, false), []);
  assert.deepEqual(poll(input, [right], 5580, false), ['right']);
  assert.deepEqual(poll(input, [right], 6000, true), []);
  assert.deepEqual(poll(input, [right], 6399, true), []);
  assert.deepEqual(poll(input, [right], 6400, true), ['right']);
  assert.deepEqual(poll(input, [right], 6519, true), []);
  assert.deepEqual(poll(input, [right], 6520, true), ['right']);
});

test('reset, Guide and chord do not resume accelerated held directions', () => {
  for (const openingButtons of [[16], [8, 9]]) {
    const input = new GamepadInput();
    const right = pad({ buttons: [15] });
    poll(input, [pad()], 0, true);
    poll(input, [right], 1, true);
    poll(input, [right], 5000, true);
    poll(input, [pad({ buttons: [15, ...openingButtons] })], 5001, true);
    poll(input, [pad({ buttons: [15, ...openingButtons] })], 5501, true);
    assert.deepEqual(poll(input, [right], 6000, false), []);
    assert.deepEqual(poll(input, [right], 10000, true), []);
    poll(input, [pad()], 10001, true);
    assert.deepEqual(poll(input, [right], 10002, true), ['right']);
    assert.deepEqual(poll(input, [right], 10401, true), []);
    assert.deepEqual(poll(input, [right], 10402, true), ['right']);
    input.reset();
    assert.deepEqual(poll(input, [right], 20000, true), []);
    assert.deepEqual(poll(input, [right], 30000, false), []);
  }
});

test('each controller accelerates independently, and menu clears other pads holds', () => {
  const input = new GamepadInput();
  const one = pad({ buttons: [15] });
  const two = pad({ index: 1, buttons: [13] });
  poll(input, [pad(), pad({ index: 1 })], 0, true);
  poll(input, [one, pad({ index: 1 })], 1, true);
  poll(input, [one, two], 3001, true);
  assert.deepEqual(poll(input, [one, two], 3061, true), ['right']);
  assert.deepEqual(poll(input, [one, two], 3401, true), ['right', 'down']);
  assert.deepEqual(poll(input, [one, two], 3461, true), ['right']);
  assert.deepEqual(poll(input, [one, two], 3521, true), ['right', 'down']);
  assert.deepEqual(poll(input, [one, pad({ index: 1, buttons: [16, 13] })], 3522, true), ['menu']);
  assert.deepEqual(poll(input, [one, two], 10000, false), []);
});
