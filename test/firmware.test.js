import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PRESETS, ROWS, PLAIN_SHA256, SOURCE_SHA256, buildImage, curveFromPoints, factoryPoints,
  pickSource, readFactoryCurves, rowsFor, sha256, sysexSchedule, toSettings,
} from '../src/firmware.js';

const path = process.env.FACELIFT_SOURCE;
const source = path ? new Uint8Array(readFileSync(path)) : null;
const needsSource = { skip: !path && 'FACELIFT_SOURCE is not set' };
const curve = name => ({ mode: 'curve', points: PRESETS[name] });
const none = { mode: 'none' };

test('no settings gives the plain Toy to Piano build', needsSource, async () => {
  assert.equal(await sha256(buildImage(source, {})), PLAIN_SHA256);
});

test('Toy on Much bolder reproduces the hardware-proven image', needsSource, async () => {
  assert.equal(await sha256(buildImage(source, { toy: curve('Much bolder') })),
    '04ce23f6b1d31d900d3b0e170c34da799ff98735bef5a4c9bcd131b07b6ae016');
});

test('every kind of write reproduces the hardware-proven check image', needsSource, async () => {
  const settings = { rhodes1: curve('Much softer'), rhodes2: curve('Much bolder'), wurli: none, clav: none, combo: none,
    toy: curve('Much bolder') };
  assert.equal(await sha256(buildImage(source, settings)),
    'cc60753f5473474972c1080f01925a5de6700f5250772b21e098bc963e977376');
});

test('No mapping on rows without a factory curve changes nothing', needsSource, async () => {
  assert.equal(await sha256(buildImage(source, { rhodes1: none, rhodes2: none, toy: none })), PLAIN_SHA256);
});

const original = { piano: false };

test('with the piano off and no settings, the output is the original file', needsSource, async () => {
  assert.equal(await sha256(buildImage(source, {}, original)), SOURCE_SHA256);
});

test('with the piano off, a Toy curve goes on the original Toy voice', needsSource, async () => {
  assert.equal(await sha256(buildImage(source, { toy: curve('Much bolder') }, original)),
    '5ab1088fdfbac548fd574503e9a9412d19537182961e5a76fe1c6b78be6d377f');
});

test('with the piano off, No mapping clears the original Toy voice curve', needsSource, async () => {
  assert.equal(await sha256(buildImage(source, { toy: none }, original)),
    '4f24056f800903847178cce73c833c91f693647e99a9080820556e36dc800202');
});

test('with the piano off, Toy has a factory curve like the other rows', needsSource, () => {
  const curves = readFactoryCurves(source, original);
  assert.equal(curves.toy.length, 128);
  assert.equal(curves.toy[127], 127);
  assert.equal(readFactoryCurves(source).toy, undefined);
});

test('rowsFor gives Toy a factory curve only when the piano is off', () => {
  assert.equal(rowsFor({ piano: true }).find(r => r.key === 'toy').factoryCurve, false);
  assert.equal(rowsFor({ piano: false }).find(r => r.key === 'toy').factoryCurve, true);
});

test('factory choices on Toy follow the piano setting', () => {
  const asPlayed = { toy: { checked: true, mode: 'curve', menu: 'Exactly as played', points: PRESETS['Exactly as played'] } };
  const noCurve = { toy: { checked: true, mode: 'none' } };
  assert.deepEqual(toSettings(asPlayed), {});
  assert.deepEqual(toSettings(asPlayed, original), { toy: { mode: 'curve', points: PRESETS['Exactly as played'] } });
  assert.deepEqual(toSettings(noCurve), {});
  assert.deepEqual(toSettings(noCurve, original), { toy: { mode: 'none' } });
});

test('an unknown row is refused', needsSource, () => {
  assert.throws(() => buildImage(source, { nosuch: none }), /nosuch/);
});

test('a source that is not the expected image is refused', needsSource, () => {
  const wrong = source.slice();
  wrong[wrong.length - 40] ^= 1;
  assert.throws(() => buildImage(wrong, {}));
});

test('factory choices are left out of the settings', () => {
  const state = {
    rhodes1: { checked: false },
    rhodes2: { checked: true, mode: 'none' },
    wurli: { checked: true, mode: 'curve', menu: 'Factory', points: PRESETS['Bolder'] },
    clav: { checked: true, mode: 'none' },
    toy: { checked: true, mode: 'curve', menu: 'Exactly as played', points: PRESETS['Exactly as played'] },
    combo: { checked: true, mode: 'curve', menu: 'Exactly as played', points: PRESETS['Exactly as played'] },
  };
  assert.deepEqual(toSettings(state), { clav: { mode: 'none' }, combo: { mode: 'curve', points: PRESETS['Exactly as played'] } });
});

test('a custom curve on a row with no factory curve is kept', () => {
  const points = PRESETS['Bolder'];
  assert.deepEqual(toSettings({ toy: { checked: true, mode: 'curve', menu: 'Custom', points } }), { toy: { mode: 'curve', points } });
});

test('Much softer never silences a note', () => {
  const table = curveFromPoints(PRESETS['Much softer']);
  assert.equal(table[0], 0);
  assert.deepEqual(table.slice(1, 6), [1, 1, 1, 1, 1]);
});

test('the identity preset is exactly n to n', () => {
  assert.deepEqual(curveFromPoints(PRESETS['Exactly as played']), Array.from({ length: 128 }, (_, i) => i));
});

test('a lowered endpoint lowers the hardest note', () => {
  const table = curveFromPoints([[5, 5], [15, 15], [30, 30], [49, 49], [72, 60], [98, 80], [127, 90]]);
  assert.equal(table[127], 90);
});

test('a flat run is allowed', () => {
  const table = curveFromPoints([[5, 60], [15, 60], [30, 60], [49, 60], [72, 60], [98, 60], [127, 60]]);
  assert.equal(table[127], 60);
  assert.equal(table[100], 60);
});

test('a falling curve is refused', () => {
  assert.throws(() => curveFromPoints([[5, 50], [15, 40], [127, 127]]), /fall/i);
});

test('an endpoint below an inner point is refused', () => {
  assert.throws(() => curveFromPoints([[5, 50], [98, 100], [127, 90]]), /fall/i);
});

test('points whose x does not increase are refused', () => {
  assert.throws(() => curveFromPoints([[20, 20], [20, 30], [127, 127]]), /increase/i);
});

test('points out of range are refused', () => {
  assert.throws(() => curveFromPoints([[5, 200], [127, 127]]), /range/i);
});

test('every preset has the same seven x positions', () => {
  for (const points of Object.values(PRESETS)) assert.deepEqual(points.map(p => p[0]), [5, 15, 30, 49, 72, 98, 127]);
});

test('rows are in panel order with distinct slots', () => {
  assert.deepEqual(ROWS.map(r => r.label), ['Rhodes 1', 'Rhodes 2', 'Wurli', 'Clav', 'Toy', 'Combo Piano']);
  assert.equal(new Set(ROWS.map(r => r.slot)).size, 6);
});

test('factory curves are read from the firmware for the rows that have one', needsSource, () => {
  const curves = readFactoryCurves(source);
  assert.deepEqual(Object.keys(curves), ROWS.filter(r => r.factoryCurve).map(r => r.key));
  for (const table of Object.values(curves)) {
    assert.equal(table.length, 128);
    assert.equal(table[0], 0);
    assert.equal(table[127], 127);
    assert.ok(table.every((value, i) => !i || value >= table[i - 1]));
  }
});

test('the factory curves differ from each other', needsSource, () => {
  const { wurli, clav, combo } = readFactoryCurves(source);
  assert.notDeepEqual(wurli, clav);
  assert.notDeepEqual(clav, combo);
});

test('factoryPoints samples a table at the preset x positions', () => {
  const table = Array.from({ length: 128 }, (_, i) => Math.floor(i / 2));
  assert.deepEqual(factoryPoints(table), [[5, 2], [15, 7], [30, 15], [49, 24], [72, 36], [98, 49], [127, 63]]);
});

test('factoryPoints is the straight line for a row with no factory curve', () => {
  assert.deepEqual(factoryPoints(undefined), PRESETS['Exactly as played']);
});

test('pickSource finds the v1.30 file among others', needsSource, async () => {
  const files = [{ name: 'a.dat', bytes: new Uint8Array(4) }, { name: 'b.dat', bytes: source }, { name: 'c.dat', bytes: new Uint8Array(9) }];
  assert.equal((await pickSource(files)).name, 'b.dat');
});

test('pickSource returns null when nothing matches', async () => {
  assert.equal(await pickSource([{ name: 'a.dat', bytes: new Uint8Array(4) }]), null);
});

test('the source hash constant is the supported updater', needsSource, async () => {
  assert.equal(await sha256(source), SOURCE_SHA256);
});

test('sysexSchedule gives 313 complete messages at the official timing', needsSource, () => {
  const { messages, due } = sysexSchedule(source);
  assert.equal(messages.length, 313);
  assert.ok(messages.every(m => m[0] === 0xF0 && m[m.length - 1] === 0xF7));
  assert.ok(Math.abs(due[2] - due[1] - 0.4542) < 0.0001);
  assert.ok(Math.abs(due[312] - 142.154) < 0.01);
});

test('builds that reuse a decoded source match builds from a fresh copy, and leave it unchanged', needsSource, async () => {
  const original = await sha256(source);
  for (const settings of [{ toy: curve('Much bolder') }, {}, { wurli: none, rhodes1: curve('Much softer') }]) {
    for (const options of [{ piano: true }, { piano: false }]) {
      assert.equal(await sha256(buildImage(source, settings, options)), await sha256(buildImage(source.slice(), settings, options)));
    }
  }
  assert.deepEqual(readFactoryCurves(source, { piano: false }), readFactoryCurves(source.slice(), { piano: false }));
  assert.equal(await sha256(source), original);
});
