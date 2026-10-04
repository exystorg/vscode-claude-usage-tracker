'use strict';
// Plain `node --test` against the compiled module (run `npm test`, which compiles first).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const u = require('../out/usage.js');

const FIXTURES = path.join(__dirname, 'fixtures', 'projects');
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

function load() {
  const cache = new u.TranscriptCache(FIXTURES, { maxAgeMs: Infinity });
  cache.refresh();
  return cache;
}

test('discovers top-level and subagent transcripts, .jsonl only', () => {
  const files = u.findJsonlFiles(FIXTURES).map(f => path.relative(FIXTURES, f)).sort();
  assert.deepEqual(files, [
    path.join('proj-a', 'sess1', 'subagents', 'agent-1.jsonl'),
    path.join('proj-a', 'sess1.jsonl'),
    path.join('proj-b', 'sess2.jsonl'),
  ].sort());
  assert.deepEqual(u.findJsonlFiles(path.join(FIXTURES, 'does-not-exist')), []);
});

test('dedupes by message.id (falls back to requestId), within and across files', () => {
  const content = fs.readFileSync(path.join(FIXTURES, 'proj-a', 'sess1.jsonl'), 'utf-8');
  const perFile = u.parseJsonl(content, 'sess1');
  // msg_A x3 -> 1, msg_B, msg_S, req_X x2 -> 1; malformed / no-timestamp / no-usage / user lines skipped
  assert.deepEqual(perFile.map(e => e.key).sort(), ['msg_A', 'msg_B', 'msg_S', 'req_X']);
  // streaming partial line (output 2) merged by max, not summed
  assert.equal(perFile.find(e => e.key === 'msg_A').output, 100);

  const all = load().entries();
  // + msg_C (subagent) + msg_D; msg_A repeated in proj-b is not counted twice
  assert.deepEqual(all.map(e => e.key).sort(), ['msg_A', 'msg_B', 'msg_C', 'msg_D', 'msg_S', 'req_X']);
  assert.equal(u.summarize(all, u.DEFAULT_PRICING).total.responses, 6);
});

test('subagent usage is included', () => {
  const b = u.summarize(load().entries(), u.DEFAULT_PRICING);
  const haiku = b.byModel.get('claude-haiku-4-5-20251001');
  assert.ok(haiku, 'subagent model bucket present');
  assert.equal(haiku.input, 1000);
  assert.equal(haiku.output, 1000);
  close(haiku.cost, 0.006);
});

test('per-model cost math (longest prefix, cache multipliers, TTL split)', () => {
  const b = u.summarize(load().entries(), u.DEFAULT_PRICING);
  // msg_A opus-5-5 (4/20): 10*4 + 1000*4*1.25 + 20000*4*0.1 + 100*20 = 15040
  // req_X opus-5-5: 100*4 = 400
  const opus = b.byModel.get('claude-opus-5-5');
  assert.equal(opus.responses, 2);
  close(opus.cost, 15440 / 1e6);
  // msg_B sonnet-5 (2/10): 5*2 + 1000*2*1.25 + 2000*2*2 + 50*10 = 11010
  const sonnet = b.byModel.get('claude-sonnet-5');
  close(sonnet.cost, 11010 / 1e6);
  assert.equal(sonnet.cacheWrite, 3000);
  // msg_D fable (10/50): 1e6 cache read * 10 * 0.1 = $1.00
  close(b.byModel.get('claude-fable-5-1').cost, 1);
  // <synthetic> -> unknown bucket: tokens counted, $0, flagged
  const unk = b.byModel.get('unknown');
  assert.equal(unk.input + unk.output, 2);
  assert.equal(unk.cost, 0);
  assert.equal(unk.unpriced, true);
  assert.equal(b.total.unpriced, true);
  close(b.total.cost, (15440 + 11010 + 6000 + 1000000) / 1e6);
});

test('effort grouping: effort, else perTurnEffort, else unspecified', () => {
  const b = u.summarize(load().entries(), u.DEFAULT_PRICING);
  assert.deepEqual([...b.byEffort.keys()].sort(), ['high', 'low', 'medium', 'unspecified']);
  assert.equal(b.byEffort.get('high').responses, 2); // msg_A + msg_D
  close(b.byEffort.get('high').cost, (15040 + 1000000) / 1e6);
  assert.equal(b.byEffort.get('medium').responses, 1); // msg_B via perTurnEffort
  assert.equal(b.byEffort.get('low').responses, 1); // req_X
  assert.equal(b.byEffort.get('unspecified').responses, 2); // msg_C + msg_S
  assert.ok(b.byModelEffort.has('claude-opus-5-5\u0000low'));
});

test('time window filter', () => {
  const b = u.summarize(load().entries(), u.DEFAULT_PRICING, Date.parse('2026-10-02T00:00:00Z'));
  assert.equal(b.total.responses, 1);
  assert.deepEqual([...b.byModel.keys()], ['claude-fable-5-1']);
  assert.equal(u.lastEntry(load().entries()).key, 'msg_D');
});

test('pricing setting overrides and extends defaults; malformed entries ignored', () => {
  const t = u.mergePricing({
    'claude-sonnet-5-5': { input: 3, output: 15 },
    'claude-opus-5-5': { input: 1, output: 1 },
    bad: { input: 'x', output: 1 },
    alsoBad: 7,
  });
  assert.deepEqual(u.resolvePrice('claude-sonnet-5-5-20261001', t), { input: 3, output: 15 });
  assert.deepEqual(u.resolvePrice('claude-sonnet-5', t), { input: 2, output: 10 });
  assert.deepEqual(u.resolvePrice('claude-opus-5-5', t), { input: 1, output: 1 });
  assert.deepEqual(u.resolvePrice('claude-opus-5-1', t), { input: 5, output: 25 });
  assert.equal(u.resolvePrice('gpt-whatever', t), undefined);
  assert.equal(t.bad, undefined);
  assert.equal(t.alsoBad, undefined);
});

test('cache re-parses only changed files and drops deleted ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-'));
  try {
    fs.cpSync(FIXTURES, dir, { recursive: true });
    const cache = new u.TranscriptCache(dir, { maxAgeMs: Infinity });
    cache.refresh();
    assert.equal(cache.parseCount, 3);
    assert.equal(cache.refresh(), false);
    assert.equal(cache.parseCount, 3);

    const f = path.join(dir, 'proj-b', 'sess2.jsonl');
    fs.appendFileSync(f, JSON.stringify({
      type: 'assistant', timestamp: '2026-10-03T00:00:00Z', effort: 'max',
      message: { id: 'msg_E', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 } },
    }) + '\n');
    assert.equal(cache.refresh(), true);
    assert.equal(cache.parseCount, 4);
    assert.ok(cache.entries().some(e => e.key === 'msg_E'));

    fs.rmSync(path.join(dir, 'proj-a', 'sess1', 'subagents', 'agent-1.jsonl'));
    assert.equal(cache.refresh(), true);
    assert.ok(!cache.entries().some(e => e.key === 'msg_C'));

    // files older than maxAgeMs are not parsed
    const old = new Date(Date.now() - 30 * 864e5);
    fs.utimesSync(f, old, old);
    const aged = new u.TranscriptCache(dir, { maxAgeMs: 8 * 864e5 });
    aged.refresh();
    assert.ok(!aged.entries().some(e => e.key === 'msg_D'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
