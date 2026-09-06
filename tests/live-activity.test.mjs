import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../apps/worker/src/room.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
function fixture(liveRoom) {
  let now = 1000, alarm = null, puts = 0, alarms = 0;
  const stored = new Map([['roomMeta', { roomId:'room', manifestUrl:'https://example.com/game.json', ownerPlayerId:'p1', phase:'playing', presenceRevision:0,
    members:{p1:{actorId:'p1',joinedAt:1000,seat:1}}, config:{liveRoom}, lastActivity:1000, ownerLastSeenAt:1000 }], ['gameState', {timers:[]}] ]);
  const ctx = { getWebSockets: () => [], storage: {
    async get(key) { return structuredClone(stored.get(key)); },
    async put(key, value) { puts++; stored.set(key, structuredClone(value)); },
    async getAlarm() { return alarm; }, async setAlarm(at) { alarms++; alarm = at; },
    async deleteAll() { stored.clear(); },
  } };
  const module = { exports:{} };
  vm.runInNewContext(outputText, {
    exports: module.exports, module, structuredClone,
    Date: class extends Date { static now() { return now; } },
    require(name) {
      if (name === 'cloudflare:workers') return { DurableObject: class { constructor(ctx) { this.ctx = ctx; } } };
      // These game-runtime imports are unused by presence and storage paths under test.
      return {};
    },
  });
  const room = new module.exports.GameRoom(ctx, {});
  return {room, stored, now: at => {now = at;}, counts: () => ({puts, alarms}), alarm: () => alarm};
}

test('live activity writes are coalesced while presence reads stay current and alarms are not postponed', async () => {
  const f = fixture(true);
  for (let at = 1000; at < 3000; at += 50) {
    f.now(at);
    await f.room.recordOwnerSeen(at);
    await f.room.touch();
    assert.equal((await f.room.meta()).ownerLastSeenAt, at);
    assert.equal((await f.room.meta()).lastActivity, at);
  }
  assert.equal(f.counts().puts, 2);
  assert.equal(f.counts().alarms, 1);
  assert.equal(f.alarm(), 46000);
  assert.equal(f.stored.get('roomMeta').ownerLastSeenAt, 2000);
  const copy = await f.room.meta(); copy.members.p1.ready = true;
  assert.equal((await f.room.meta()).members.p1.ready, undefined, 'unsaved mutations cannot leak through cache');
  await f.room.saveMeta(copy);
  assert.equal(f.stored.get('roomMeta').members.p1.ready, true, 'membership/lifecycle writes remain immediate');
  assert.equal(f.stored.get('roomMeta').ownerLastSeenAt, 2950, 'structural saves include fresh timestamps');
  const earlier = await f.room.meta(); earlier.ownerLastSeenAt = 500;
  await f.room.saveMeta(earlier);
  await f.room.scheduleAlarm(undefined, 500, true);
  assert.equal(f.alarm(), 45500, 'earlier deadlines are never delayed by coalescing');
});

test('durable activity retains immediate persistence', async () => {
  const f = fixture(false);
  for (let at = 1050; at <= 1250; at += 50) {
    f.now(at); await f.room.recordOwnerSeen(at); await f.room.touch();
    assert.equal(f.stored.get('roomMeta').lastActivity, at);
  }
  assert.equal(f.counts().puts, 10);
});

test('expired live rooms clear cached metadata as well as storage', async () => {
  const f = fixture(true);
  await f.room.touch();
  f.now(1000 + 3600001);
  await f.room.alarm();
  assert.equal(f.stored.size, 0);
  await assert.rejects(() => f.room.meta(), /room does not exist/);
});
