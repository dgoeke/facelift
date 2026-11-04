// Everything about the firmware file, with no DOM: parse, decode, encode, curves, build and checks.
// The updater's file is a format-0 Standard MIDI File of SysEx messages that carry a packed image.

export const SOURCE_SHA256 = '115cd5bbc80ec1d5852bd1bdc3d36dd0ce5e2c82e7534710028ac35329b931e4';
export const PLAIN_SHA256 = '5f78926f05a1c4c78e05c6434c1b069829cc46da2d34e1ee1582f1c968596385';

const IMAGE_SIZE = 0x440000;
const BLOCK_PAYLOAD = 16368;
const PAYLOAD_START = 14;  // within a SysEx body; the payload ends 2 bytes before the body does
const SECTIONS = [[0, 0x2A0000], [0x2C0000, 0x440000]];
const CURVES = 0x2E8778;  // six 128-entry velocity curves
const NO_CURVE = 0xFFFF;
const TOY_EDITS = [[0x1F672B, 0x01, 0x00], [0x1F672D, 0x09, 0x00]];  // [offset, v1.30 value, new value]
const LOUD_EDIT = [0x1F672F, 0x4A, 0x7F];  // the Toy record's part volume: 74 suits the Toy sound and leaves the piano 9.4 dB down

// `field` holds the voice's curve number (big-endian u16). `factory` is its value in v1.30.
export const ROWS = [
  { key: 'rhodes1', label: 'Rhodes 1', field: 0x2C4E4E, factory: NO_CURVE, slot: 4, factoryCurve: false },
  { key: 'rhodes2', label: 'Rhodes 2', field: 0x2C4F16, factory: NO_CURVE, slot: 5, factoryCurve: false },
  { key: 'wurli', label: 'Wurli', field: 0x2C4F7A, factory: 2, slot: 2, factoryCurve: true },
  { key: 'clav', label: 'Clav', field: 0x2C4FDE, factory: 0, slot: 0, factoryCurve: true },
  { key: 'toy', label: 'Toy', field: 0x2C516E, factory: NO_CURVE, slot: 3, factoryCurve: false },
  { key: 'combo', label: 'Combo Piano', field: 0x2C4D96, factory: 1, slot: 1, factoryCurve: true },
];

// Without the piano patch, Toy plays its original voice, which has a factory curve in the same slot.
const ORIGINAL_TOY = { field: 0x2C507E, factory: 3, factoryCurve: true };

/** The rows for a build. They differ only in which voice the Toy row controls. */
export function rowsFor({ piano = true } = {}) {
  return piano ? ROWS : ROWS.map(row => (row.key === 'toy' ? { ...row, ...ORIGINAL_TOY } : row));
}

export const PRESETS = {
  'Much bolder': [[5, 24], [15, 44], [30, 62], [49, 79], [72, 95], [98, 111], [127, 127]],
  'Bolder': [[5, 13], [15, 29], [30, 46], [49, 65], [72, 85], [98, 106], [127, 127]],
  'Exactly as played': [[5, 5], [15, 15], [30, 30], [49, 49], [72, 72], [98, 98], [127, 127]],
  'Softer': [[5, 1], [15, 5], [30, 15], [49, 30], [72, 54], [98, 86], [127, 127]],
  'Much softer': [[5, 0], [15, 2], [30, 7], [49, 19], [72, 40], [98, 75], [127, 127]],
};

/** The factory curves of the rows that have one, read from the firmware. */
export function readFactoryCurves(source, options) {
  const image = decodedSource(source), curves = {};
  for (const row of rowsFor(options)) {
    if (row.factoryCurve) curves[row.key] = [...image.subarray(CURVES + 128 * row.slot, CURVES + 128 * (row.slot + 1))];
  }
  return curves;
}

/** A 128-entry table as 7 editable points at the presets' x positions, or the straight line with no table. */
export function factoryPoints(table) {
  return PRESETS['Exactly as played'].map(([x, y]) => [x, table ? table[x] : y]);
}

/** The menu choice a row starts on: its factory curve, or the straight line if it has none. */
export const startingMenu = row => (row.factoryCurve ? 'Factory' : 'Exactly as played');

/** What the page's options start as. buildImage's own defaults stay on the plain build. */
export const PAGE_OPTIONS = { piano: true, loud: true };

/** Turn the page's per-row state into build settings. Anything that would change nothing is left out. */
export function toSettings(state, options) {
  const settings = {};
  for (const row of rowsFor(options)) {
    const s = state[row.key];
    if (!s?.checked) continue;
    if (s.mode === 'none') {
      if (row.factoryCurve) settings[row.key] = { mode: 'none' };
    } else if (!(s.menu === 'Factory' || (s.menu === 'Exactly as played' && !row.factoryCurve))) {
      settings[row.key] = { mode: 'curve', points: s.points };
    }
  }
  return settings;
}

export async function sha256(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** The first file whose hash is the supported updater's, or null. */
export async function pickSource(files) {
  for (const file of files) if (await sha256(file.bytes) === SOURCE_SHA256) return file;
  return null;
}

function readVlq(data, pos) {
  let value = 0;
  for (;;) {
    const byte = data[pos++];
    value = value << 7 | byte & 0x7F;
    if (!(byte & 0x80)) return [value, pos];
  }
}

const u32 = (data, pos) => (data[pos] * 2 ** 24) + (data[pos + 1] << 16 | data[pos + 2] << 8 | data[pos + 3]);

/** Parse the MIDI file. SysEx events give the body after F0 and its length, F7 included. */
function parseMidi(data) {
  if (String.fromCharCode(...data.subarray(0, 4)) !== 'MThd') throw new Error('This is not a MIDI file.');
  const division = data[12] << 8 | data[13];
  let pos = 8 + u32(data, 4);
  const end = pos + 8 + u32(data, pos + 4);
  pos += 8;
  let tick = 0;
  const events = [];
  while (pos < end) {
    let delta, length;
    [delta, pos] = readVlq(data, pos);
    tick += delta;
    if (data[pos] === 0xF0) {
      [length, pos] = readVlq(data, pos + 1);
      events.push({ tick, sysex: true, start: pos, length });
    } else if (data[pos] === 0xFF) {
      const type = data[pos + 1];
      [length, pos] = readVlq(data, pos + 2);
      events.push({ tick, sysex: false, type, start: pos, length });
    } else {
      throw new Error('Unexpected data in the firmware file.');
    }
    pos += length;
  }
  return { division, events };
}

const bodies = data => parseMidi(data).events.filter(e => e.sysex);

/** Every SysEx message, complete from F0 to F7, and the second each is due. */
export function sysexSchedule(data) {
  const { division, events } = parseMidi(data);
  let tempo = 500000, lastTick = 0, seconds = 0;
  const messages = [], due = [];
  for (const e of events) {
    seconds += (e.tick - lastTick) * tempo / division / 1e6;
    lastTick = e.tick;
    if (e.sysex) {
      const message = new Uint8Array(e.length + 1);
      message[0] = 0xF0;
      message.set(data.subarray(e.start, e.start + e.length), 1);
      messages.push(message);
      due.push(seconds);
    } else if (e.type === 0x51) {
      tempo = data[e.start] << 16 | data[e.start + 1] << 8 | data[e.start + 2];
    }
  }
  return { messages, due };
}

function decodeImage(data) {
  const image = new Uint8Array(IMAGE_SIZE);
  let n = 0;
  for (const { start, length } of bodies(data)) {
    let sum = 0;
    for (let i = start + 6; i < start + length - 1; i++) sum += data[i];
    if (sum & 0x7F) throw new Error('A SysEx message checksum is wrong.');
    if (length < 64) continue;  // the header message carries no image data
    const first = start + PAYLOAD_START, usable = (length - PAYLOAD_START - 2) & ~7;
    for (let i = 0; i < usable; i += 8) {
      const high = data[first + i];
      for (let j = 0; j < 7 && n < IMAGE_SIZE; j++) image[n++] = data[first + i + 1 + j] | ((high >> (6 - j)) & 1) << 7;
    }
  }
  if (n < IMAGE_SIZE) throw new Error('The firmware image is too short.');
  return image;
}

const decodedSources = new WeakMap();

/** The image in a source file, decoded once per file. Read-only, and it assumes the file's bytes never change. */
function decodedSource(source) {
  if (!decodedSources.has(source)) decodedSources.set(source, decodeImage(source));
  return decodedSources.get(source);
}

/** Offsets the firmware's ROM check reads: 0, 4, 8, 16 … 0x40000 in each 0x80000 window. */
function* sampleOffsets(size) {
  let step = 0, window = 0;
  while (window + step < size) {
    yield window + step;
    if (step === 0) step = 4;
    else {
      step *= 2;
      if (step > 0x40000) { step = 0; window += 0x80000; }
    }
  }
}

/** The 8-byte trailer the ROM check expects: L0 L1 L2 L3 S FF Z FF. */
function sectionTrailer(section) {
  const end = section.length - 8, trailer = section.slice(end), lanes = [0, 0, 0, 0];
  for (const offset of sampleOffsets(end)) for (let lane = 0; lane < 4; lane++) lanes[lane] = (lanes[lane] + section[offset + lane]) & 0xFF;
  trailer.set(lanes);
  trailer[4] = lanes.reduce((a, b) => a + b) & 0xFF;
  let sum = 0;
  for (let i = 0; i < end; i++) sum += section[i];
  for (let i = 0; i < 6; i++) sum += trailer[i];
  trailer[6] = -sum & 0xFF;
  return trailer;
}

function sectionOk(section) {
  const want = sectionTrailer(section), have = section.subarray(section.length - 8);
  return want.every((byte, i) => byte === have[i]);
}

/** Python's round(): halves go to the even neighbour, which keeps tables identical to the reference images. */
function roundHalfEven(value) {
  const floor = Math.floor(value), rest = value - floor;
  if (rest !== 0.5) return rest < 0.5 ? floor : floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** A 128-entry table through (0,0) and the points, by Fritsch-Carlson monotone cubic interpolation. */
export function curveFromPoints(points) {
  if (points.some(([x, y]) => !(x >= 1 && x <= 127 && y >= 0 && y <= 127))) throw new Error('A curve point is out of range.');
  if (points[points.length - 1][0] !== 127) throw new Error('A curve must end at x = 127.');
  const xs = [0, ...points.map(p => p[0])], ys = [0, ...points.map(p => p[1])];
  for (let i = 1; i < xs.length; i++) {
    if (xs[i] <= xs[i - 1]) throw new Error('Curve points must increase from left to right.');
    if (ys[i] < ys[i - 1]) throw new Error('A curve must not fall.');
  }
  const slopes = xs.slice(1).map((x, i) => (ys[i + 1] - ys[i]) / (x - xs[i]));
  const tangents = [slopes[0]];
  for (let i = 1; i < slopes.length; i++) {
    const a = slopes[i - 1], b = slopes[i];
    tangents.push(a * b <= 0 ? 0 : 2 / (1 / a + 1 / b));
  }
  tangents.push(slopes[slopes.length - 1]);
  const table = [0];
  for (let x = 1; x < 128; x++) {
    let i = 0;
    while (i < xs.length - 2 && xs[i + 1] <= x) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h;
    const y = (2 * t ** 3 - 3 * t ** 2 + 1) * ys[i] + (t ** 3 - 2 * t ** 2 + t) * h * tangents[i]
      + (-2 * t ** 3 + 3 * t ** 2) * ys[i + 1] + (t ** 3 - t ** 2) * h * tangents[i + 1];
    table.push(Math.max(1, Math.min(127, roundHalfEven(y))));
  }
  if (table.some((value, i) => i && value < table[i - 1])) throw new Error('A curve must not fall.');
  return table;
}

/** The image edits for these settings, as a Map of offset to value. Refuses a source that isn't as expected. */
function editsFor(image, settings, { piano = true, loud = false } = {}) {
  const rows = rowsFor({ piano }), known = new Set(rows.map(r => r.key));
  for (const key of Object.keys(settings)) if (!known.has(key)) throw new Error(`Unknown sound: ${key}`);
  const edits = new Map();
  for (const [offset, old, value] of TOY_EDITS) {
    if (image[offset] !== old) throw new Error('The firmware is not as expected.');
    if (piano) edits.set(offset, value);
  }
  const [loudOffset, loudOld, loudValue] = LOUD_EDIT;
  if (image[loudOffset] !== loudOld) throw new Error('The firmware is not as expected.');
  if (piano && loud) edits.set(loudOffset, loudValue);
  for (const row of rows) {
    if ((image[row.field] << 8 | image[row.field + 1]) !== row.factory) throw new Error('The firmware is not as expected.');
    const setting = settings[row.key];
    if (!setting) continue;
    const number = setting.mode === 'none' ? NO_CURVE : row.slot;
    edits.set(row.field, number >> 8);
    edits.set(row.field + 1, number & 0xFF);
    if (setting.mode === 'curve') curveFromPoints(setting.points).forEach((value, i) => edits.set(CURVES + 128 * row.slot + i, value));
  }
  return edits;
}

/** Write every byte that differs into a copy of the file, with its top bit in the group's high byte. */
function encode(source, before, image) {
  const data = source.slice(), blocks = bodies(data).slice(1), touched = new Set();
  const at = encoded => {
    const block = Math.floor(encoded / BLOCK_PAYLOAD);
    touched.add(block);
    return blocks[block].start + PAYLOAD_START + encoded % BLOCK_PAYLOAD;
  };
  for (let offset = 0; offset < IMAGE_SIZE; offset++) {
    if (image[offset] === before[offset]) continue;
    const group = Math.floor(offset / 7), position = offset % 7, value = image[offset], bit = 1 << (6 - position);
    data[at(group * 8 + 1 + position)] = value & 0x7F;
    const high = at(group * 8);
    data[high] = data[high] & ~bit | (value >> 7 ? bit : 0);
  }
  for (const block of touched) {
    const { start, length } = blocks[block];
    let sum = 0;
    for (let i = start + 6; i < start + length - 2; i++) sum += data[i];
    data[start + length - 2] = -sum & 0x7F;
  }
  return data;
}

/** Check a finished file from scratch, against the source and what was intended. */
function verify(source, data, before, intended, edits, settings, options) {
  if (data.length !== source.length) throw new Error('The file length changed.');
  const after = decodeImage(data), allowed = new Set(edits.keys());
  for (const [, end] of SECTIONS) for (let i = end - 8; i < end; i++) allowed.add(i);
  for (let i = 0; i < IMAGE_SIZE; i++) {
    if (after[i] !== intended[i]) throw new Error('The file does not decode to the intended image.');
    if (after[i] !== before[i] && !allowed.has(i)) throw new Error('The image changed in an unexpected place.');
  }
  for (const [start, end] of SECTIONS) if (!sectionOk(after.subarray(start, end))) throw new Error('A firmware section fails its check.');
  for (const row of rowsFor(options)) {
    if (settings[row.key]?.mode !== 'curve') continue;
    const table = after.subarray(CURVES + 128 * row.slot, CURVES + 128 * (row.slot + 1));
    if (table[0] !== 0 || table.some((value, i) => i && (value < 1 || value > 127 || value < table[i - 1]))) throw new Error('A written curve is not valid.');
  }
  // Outside the payload and block checksums, the file must be identical: framing, timing and the header message.
  const open = new Uint8Array(data.length);
  for (const { start, length } of bodies(source).slice(1)) open.fill(1, start + PAYLOAD_START, start + length - 1);
  for (let i = 0; i < data.length; i++) if (data[i] !== source[i] && !open[i]) throw new Error('The file changed outside the firmware data.');
}

/** Build the file to flash from these settings, with the Toy to Piano patch unless piano is false, and that piano at full volume if loud is true. Throws if any check fails. */
export function buildImage(source, settings, options) {
  const before = decodedSource(source), image = before.slice(), edits = editsFor(before, settings, options);
  for (const [offset, value] of edits) image[offset] = value;
  for (const [start, end] of SECTIONS) {
    if ([...edits.keys()].some(o => o >= start && o < end)) image.set(sectionTrailer(image.subarray(start, end)), end - 8);
  }
  const data = encode(source, before, image);
  verify(source, data, before, image, edits, settings, options);
  return data;
}

/** Build from the page's state. It shares its options with describeBuild, so the two can't disagree. */
export function buildFromPage(source, state, options) {
  return buildImage(source, toSettings(state, options), options);
}

/** The page's one-line description of the build these options and state give. */
export function describeBuild(state, { piano, loud }) {
  const level = loud ? ' at full volume' : '', parts = [], toy = piano ? `Toy plays the piano${level}` : 'Toy keeps its own sound';
  for (const row of rowsFor({ piano })) {
    const s = state[row.key];
    if (!s?.checked) continue;
    if (s.mode === 'none') parts.push(`${row.label}: No mapping`);
    else if (s.menu !== startingMenu(row)) parts.push(`${row.label}: ${s.menu}`);
  }
  if (!parts.length) return piano ? `All factory, with Toy playing the piano${level}.` : 'The original firmware, with nothing changed.';
  return [...parts, ...(parts.length < ROWS.length ? ['others factory'] : []), toy].join(' · ');
}
