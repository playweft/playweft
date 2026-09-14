import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { createLanguageModelClient } from '../apps/web/public/sdk/language-model.js';

class Port extends EventTarget {
  messages = [];
  start() {}
  postMessage(message) { this.messages.push(structuredClone(message)); }
  reply(id, result) { this.dispatchEvent(new MessageEvent('message', { data: { jsonrpc: '2.0', id, result } })); }
}
async function moduleAt(path, imports = {}) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { fileName: path, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const module = { exports: {} };
  vm.runInNewContext(outputText, { module, exports: module.exports, AbortController, DOMException,
    require: name => imports[name] ?? {}, window: { setTimeout, clearTimeout } });
  return module.exports;
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const fault = (code, message) => Object.assign(new Error(message), { code });

 test('SDK sends no pre-aborted request and preserves custom reason', async () => {
  const port = new Port(), client = createLanguageModelClient(port), controller = new AbortController();
  const reason = new Error('stop'); controller.abort(reason);
  await assert.rejects(client.prompt('hello', { signal: controller.signal }), e => e === reason);
  assert.equal(port.messages.length, 0); client.destroy();
});
test('SDK cancels once, omits signal, ignores late results, and cleans listeners after success', async () => {
  const port = new Port(), client = createLanguageModelClient(port), controller = new AbortController();
  const result = client.prompt('hello', { signal: controller.signal, maxOutputTokens: 10 });
  assert.deepEqual(port.messages[0].params.options, { maxOutputTokens: 10 });
  controller.abort(); controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(port.messages.length, 2);
  assert.equal(port.messages[1].params.requestId, port.messages[0].id);
  port.reply(port.messages[0].id, 'late');
  const next = new AbortController();
  const completed = client.prompt('next', { signal: next.signal });
  port.reply(port.messages[2].id, 'done');
  assert.equal(await completed, 'done'); next.abort();
  assert.equal(port.messages.length, 3); client.destroy();
});
test('SDK destroy cancels all outstanding requests', async () => {
  const port = new Port(), client = createLanguageModelClient(port);
  const a = client.prompt('a'), b = client.prompt('b'); client.destroy();
  await assert.rejects(a, { name: 'AbortError' }); await assert.rejects(b, { name: 'AbortError' });
  assert.equal(port.messages.filter(m => m.method === 'languageModel.cancel').length, 2);
});
test('queued cancellation rejects promptly and never runs, queue survives', async () => {
  const { enqueueLanguageModelRequest: enqueue } = await moduleAt('../apps/web/src/features/permissions/language-model.ts');
  const gate = deferred(), controller = new AbortController(); let called = false;
  const first = enqueue(() => gate.promise);
  const second = enqueue(() => { called = true; }, controller.signal);
  controller.abort(); await assert.rejects(second, { name: 'AbortError' });
  gate.resolve('first'); await first;
  assert.equal(await enqueue(() => Promise.resolve('third')), 'third');
  assert.equal(called, false);
});
test('connection cancellation reaches active work and cannot cross connections', async () => {
  const { cancellableLanguageModelHandlers: wrap } = await moduleAt('../apps/web/src/features/game/language-model-requests.ts', {
    '@/platform/json-rpc': { rpcPlatformFault: fault },
  });
  const signals = [];
  const handlers = { 'languageModel.prompt': { handle(_params, _id, signal) {
    signals.push(signal);
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } } };
  const a = wrap(handlers), b = wrap(handlers);
  const first = a.handlers['languageModel.prompt'].handle({}, 'same');
  const second = b.handlers['languageModel.prompt'].handle({}, 'same');
  a.handlers['languageModel.cancel'].handle({ requestId: 'unknown' });
  a.handlers['languageModel.cancel'].handle({ requestId: 'same' });
  await assert.rejects(first, { code: 'REQUEST_CANCELLED' });
  assert.equal(signals[1].aborted, false);
  b.cancel(); await assert.rejects(second, { code: 'REQUEST_CANCELLED' });
  await assert.rejects(b.handlers['languageModel.prompt'].handle({}, 'late'), { code: 'REQUEST_CANCELLED' });
});
test('permission cancellation dismisses prompt without remembering consent', async () => {
  const cleanups = [], states = []; let grants = 0;
  const { useLanguageModelPermission } = await moduleAt('../apps/web/src/features/permissions/LanguageModelPermission.tsx', {
    react: { useCallback: f => f, useRef: current => ({ current }), useState: () => [undefined, value => states.push(value)], useEffect: f => cleanups.push(f()) },
    '@/features/permissions/permission-grants': { hasPermissionGrant: () => false, rememberPermissionGrant: () => grants++ },
    '@playweft/game-protocol': { JsonRpcErrorCode: { PlatformError: -32000 } },
    '@/platform/json-rpc': { RpcFault: class extends Error { constructor(code, message, data) { super(message); this.data = data; } } },
  });
  const permission = useLanguageModelPermission('game', 'https://game.example', 'game-id');
  const controller = new AbortController(); const result = permission.requestPermission(controller.signal);
  controller.abort();
  await assert.rejects(result, e => e.data.code === 'REQUEST_CANCELLED');
  permission.allow(); assert.equal(grants, 0); assert.equal(states.at(-1), undefined);
  cleanups.forEach(f => f?.());
});
