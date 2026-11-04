import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSender, isRefusedPort } from '../src/send.js';

const GAP = 454.2;

/** A fake clock and timers; advance() moves time in steps, running the interval at each one. */
function harness({ count = 313, failAt = -1, lookaheadMs } = {}) {
  const h = { now: 1000, tick: null, sent: [], logs: [], progress: [] };
  h.clock = { now: () => h.now };
  h.timers = { setInterval: fn => { h.tick = fn; return 1; }, clearInterval: () => { h.tick = null; } };
  h.output = { send(bytes, when) {
    if (h.sent.length === failAt) throw new Error('port gone');
    h.sent.push({ bytes, when, queuedAt: h.now });
  } };
  h.sender = createSender({
    output: h.output, messages: Array.from({ length: count }, (_, i) => [i]), due: Array.from({ length: count }, (_, i) => i * GAP / 1000),
    clock: h.clock, timers: h.timers, lookaheadMs, onLog: m => h.logs.push(m), onProgress: p => h.progress.push(p),
  });
  h.advance = (ms, step = 50) => { for (let t = 0; t < ms && h.tick; t += step) { h.now += step; h.tick(); } };
  h.gaps = () => h.sent.slice(1).map((m, i) => m.when - h.sent[i].when);
  return h;
}

test('a normal run sends everything on schedule and within the look-ahead', async () => {
  const h = harness();
  const result = h.sender.start();
  h.advance(150000);
  assert.equal(await result, 'done');
  assert.equal(h.sent.length, 313);
  assert.ok(h.gaps().every(g => Math.abs(g - GAP) < 1));
  assert.ok(h.sent.every(m => m.when - m.queuedAt <= 60000));
});

test('messages go in order', () => {
  const h = harness();
  h.sender.start();
  h.advance(150000);
  assert.deepEqual(h.sent.map(m => m.bytes[0]), Array.from({ length: 313 }, (_, i) => i));
});

test('a stalled page pushes the schedule back and never shortens a gap', async () => {
  const h = harness({ lookaheadMs: 3000 });
  const result = h.sender.start();
  h.advance(5000);
  h.now += 22000;  // the page's timer stopped
  h.advance(160000);
  assert.equal(await result, 'done');
  assert.equal(h.sent.length, 313);
  assert.ok(h.gaps().every(g => g >= GAP - 0.01), `shortest gap ${Math.min(...h.gaps())}`);
  assert.ok(h.sent.every(m => m.when >= m.queuedAt));
  assert.ok(h.logs.some(l => /late/i.test(l)));
});

test('progress counts messages that have gone out, not messages queued', () => {
  const h = harness();
  h.sender.start();
  h.advance(10000);
  const last = h.progress[h.progress.length - 1];
  assert.ok(h.sent.length > 100);
  assert.ok(last.sent >= 20 && last.sent <= 24, `sent ${last.sent}`);
  assert.equal(last.total, 313);
  assert.ok(Math.abs(last.secondsLeft - 132) < 2, `left ${last.secondsLeft}`);
});

test('a failed send stops at once and reports it', async () => {
  const h = harness({ failAt: 100 });
  const result = h.sender.start();
  h.advance(60000);
  assert.equal(await result, 'failed');
  assert.equal(h.sent.length, 100);
  assert.ok(h.logs.some(l => /port gone/.test(l)));
});

test('losing the port part way through fails the send', async () => {
  const h = harness({ lookaheadMs: 3000 });
  const result = h.sender.start();
  h.advance(5000);
  const queued = h.sent.length;
  h.sender.fail('The port disconnected.');
  h.advance(5000);
  assert.equal(await result, 'failed');
  assert.equal(h.sent.length, queued);
  assert.ok(h.logs.some(l => /disconnected/.test(l)));
});

test('a second start is refused and only one set goes out', async () => {
  const h = harness();
  const result = h.sender.start();
  await assert.rejects(h.sender.start());
  h.advance(150000);
  await result;
  assert.equal(h.sent.length, 313);
});

test('stop ends queuing but only resolves once queued messages have gone out', async () => {
  const h = harness({ lookaheadMs: 3000 });
  const result = h.sender.start();
  let settled = false;
  result.then(() => { settled = true; });
  h.advance(1000);
  h.sender.stop();
  const queued = h.sent.length, last = h.sent[queued - 1].when;
  h.advance(1000);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(h.sent.length, queued);
  h.now = last;
  h.advance(100);
  assert.equal(await result, 'stopped');
});

test('IAC buses are refused and other ports are not', () => {
  assert.ok(isRefusedPort('IAC Driver Bus 1'));
  assert.ok(!isRefusedPort('Recorder'));
  assert.ok(!isRefusedPort('Maniac Port'));
});

test('a failure stays busy until queued messages have had time to go out', async () => {
  const h = harness({ lookaheadMs: 3000 });
  const result = h.sender.start();
  let settled = false;
  result.then(() => { settled = true; });
  h.advance(1000);
  h.sender.fail('The port disconnected.');
  h.advance(100);
  await Promise.resolve();
  assert.equal(settled, false);
  h.advance(4000);
  assert.equal(await result, 'failed');
});

test('losing the port before the send starts fails it cleanly', async () => {
  const h = harness();
  h.sender.fail('The port disconnected.');
  assert.equal(await h.sender.start(), 'failed');
  assert.equal(h.sent.length, 0);
});

test('stop after the last message is queued changes nothing, and the send ends as done', async () => {
  const h = harness({ count: 10 });
  const result = h.sender.start();
  h.advance(100);
  assert.equal(h.sent.length, 10);
  assert.equal(h.sender.stop(), false);
  h.advance(10000);
  assert.equal(await result, 'done');
});

test('stop says when it held messages back', async () => {
  const h = harness({ lookaheadMs: 3000 });
  const result = h.sender.start();
  h.advance(1000);
  assert.equal(h.sender.stop(), true);
  h.advance(10000);
  assert.equal(await result, 'stopped');
  assert.ok(h.sent.length < 313);
});

test('losing the port after the last message is queued leaves the result unsure', async () => {
  const h = harness({ count: 10 });
  const result = h.sender.start();
  h.advance(100);
  assert.equal(h.sent.length, 10);
  h.sender.fail('The port disconnected.');
  h.advance(10000);
  assert.equal(await result, 'unsure');
});

test('losing the port after the last message has played, before the next tick, is unsure too', async () => {
  const h = harness({ count: 10 });
  const result = h.sender.start();
  h.advance(100);
  h.now = h.sent[9].when + 1;
  h.sender.fail('The port disconnected.');
  h.advance(100);
  assert.equal(await result, 'unsure');
});
