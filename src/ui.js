// The page: loading the updater, the curve editor, and flashing.
import { PRESETS, ROWS, buildImage, curveFromPoints, factoryPoints, pickSource, readFactoryCurves, rowsFor, sha256, sysexSchedule, toSettings } from './firmware.js';
import { createSender, isRefusedPort } from './send.js';

const $ = id => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const RECOVERY = 'The keyboard stays in update mode. To recover, switch it off, enter update mode again and flash again.';
const UNSURE = 'The port went away after every message was queued, so the page can\'t tell how much arrived. Do not switch off yet. If all 6 TYPE lamps light, the flash worked. If they never do, switch it off, enter update mode again and flash again.';
const KEY_REBUILD_DELAY_MS = 300;

let source = null;   // the v1.30 file
let factory = null;  // its factory curves, read when it first loads
let piano = true;    // whether Toy plays the hidden piano
let image = null;    // the checked file to flash, or null
let midi = null;
let sending = false;
let sender = null;
let buildToken = 0;
let rebuildTimer = null;

// Nothing else from an earlier visit is kept, so its ticks must not be either. autocomplete="off" in index.html
// stops Chrome, which restores controls after this runs. These lines cover a browser that restores before it.
$('piano').checked = piano;
$('confirmed').checked = false;

function log(text, kind = '') {
  const line = document.createElement('div');
  line.className = kind;
  line.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  $('log').append(line);
  $('log').scrollTop = $('log').scrollHeight;
}

// ---------- 1. Loading the updater ----------

const isDat = name => name.toLowerCase().endsWith('.dat');

async function useFiles(files) {
  const candidates = await Promise.all(files.filter(f => isDat(f.name))
    .map(async f => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
  const found = await pickSource(candidates);
  if (sending) {
    log('A send started while those files were loading, so they were ignored.');
    return;
  }
  source = found ? found.bytes : null;
  const status = $('sourceStatus');
  status.className = found ? 'ok' : 'bad';
  status.textContent = found ? 'v1.30 updater recognised.' : 'Not the supported v1.30 updater. Nothing was changed.';
  if (source && !factory) showCurves();
  $('curveControls').disabled = !source;
  rebuild();
}

const entryFile = entry => new Promise((resolve, reject) => entry.file(resolve, reject));
const readBatch = reader => new Promise((resolve, reject) => reader.readEntries(resolve, reject));

async function collectDats(entry, depth = 0) {
  if (entry.isFile) return isDat(entry.name) ? [await entryFile(entry)] : [];
  if (depth > 8) return [];
  const reader = entry.createReader(), files = [];
  for (let batch = await readBatch(reader); batch.length; batch = await readBatch(reader)) {
    for (const child of batch) files.push(...await collectDats(child, depth + 1));
  }
  return files;
}

const drop = $('drop');
drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', async event => {
  event.preventDefault();
  drop.classList.remove('over');
  if (sending) return;
  const entries = [...event.dataTransfer.items].map(item => item.webkitGetAsEntry()).filter(Boolean);
  const files = (await Promise.all(entries.map(entry => collectDats(entry)))).flat();
  await useFiles(files);
});
for (const id of ['pickFolder', 'pickFile']) $(id).addEventListener('change', event => useFiles([...event.target.files]));

// ---------- 2. Velocity curves ----------

const state = {};  // per-row settings, filled in once the factory curves are known

const rows = () => rowsFor({ piano });
const factoryTable = row => (row.factoryCurve ? factory[row.key] : undefined);
const startingMenu = row => (row.factoryCurve ? 'Factory' : 'Exactly as played');

function svgElement(parent, name, attributes = {}, text = '') {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  element.textContent = text;
  parent.append(element);
  return element;
}

const LEFT = 30, TOP = 8, SIZE = 296;
const X = value => LEFT + value * SIZE / 127;
const Y = value => TOP + SIZE - value * SIZE / 127;
const line = table => table.map((y, x) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(' ');

/** The drawing box for one row. Returns a function that redraws it after its points change. */
function createEditor(svg, row, onDrag, onDragEnd, onKeyMove) {
  const s = state[row.key];
  svg.setAttribute('viewBox', `0 0 ${LEFT + SIZE + 10} ${TOP + SIZE + 28}`);
  svg.setAttribute('role', 'group');
  svg.setAttribute('aria-label', `${row.label} velocity curve`);
  svgElement(svg, 'rect', { class: 'plot', x: LEFT, y: TOP, width: SIZE, height: SIZE });
  for (const v of [32, 64, 96]) {
    svgElement(svg, 'line', { class: 'grid', x1: X(v), x2: X(v), y1: Y(0), y2: Y(127) });
    svgElement(svg, 'line', { class: 'grid', x1: X(0), x2: X(127), y1: Y(v), y2: Y(v) });
  }
  svgElement(svg, 'text', { class: 'axis', x: LEFT + SIZE / 2, y: TOP + SIZE + 20, 'text-anchor': 'middle' }, 'how hard you play →');
  svgElement(svg, 'text', { class: 'axis', transform: `translate(16 ${TOP + SIZE / 2}) rotate(-90)`, 'text-anchor': 'middle' }, 'how hard it sounds →');
  const straight = Array.from({ length: 128 }, (_, i) => i);
  if (row.factoryCurve) svgElement(svg, 'polyline', { class: 'ref', points: line(straight), 'stroke-dasharray': '2 4' });
  svgElement(svg, 'polyline', { class: 'ref', points: line(factoryTable(row) ?? straight), 'stroke-dasharray': '7 5' });
  const current = svgElement(svg, 'polyline', { class: 'current' });
  const handles = s.points.map((_, index) => {
    const hit = svgElement(svg, 'circle', { class: 'hit', r: 15 });
    const dot = svgElement(svg, 'circle', { class: 'point', r: 6.5, tabindex: 0, role: 'slider' });
    attachDrag(index, hit, dot);
    return { hit, dot };
  });

  function draw() {
    current.setAttribute('points', line(curveFromPoints(s.points)));
    s.points.forEach(([x, y], index) => {
      for (const circle of [handles[index].hit, handles[index].dot]) { circle.setAttribute('cx', X(x)); circle.setAttribute('cy', Y(y)); }
      const { dot } = handles[index];
      dot.setAttribute('aria-label', `Point ${index + 1}: playing ${x} sounds as ${y}`);
      dot.setAttribute('aria-valuenow', y);
    });
  }

  /** Move a point, staying between its neighbours so the curve keeps rising. Returns true if it moved. */
  function moveTo(index, x, y) {
    const before = s.points[index - 1] ?? [0, 0], after = s.points[index + 1], last = index === s.points.length - 1;
    const clamp = (value, low, high) => Math.max(low, Math.min(high, Math.round(value)));
    const newX = last ? 127 : clamp(x, before[0] + 1, after[0] - 1);
    const newY = last ? clamp(y, Math.max(before[1], 1), 127) : clamp(y, before[1], after[1]);
    if (newX === s.points[index][0] && newY === s.points[index][1]) return false;
    s.points[index] = [newX, newY];
    return true;
  }

  function attachDrag(index, ...circles) {
    let dragging = false;
    const position = event => {
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
      return [(point.x - LEFT) * 127 / SIZE, (TOP + SIZE - point.y) * 127 / SIZE];
    };
    for (const circle of circles) {
      circle.addEventListener('pointerdown', event => { dragging = true; circle.setPointerCapture(event.pointerId); event.preventDefault(); });
      circle.addEventListener('pointermove', event => {
        if (dragging && moveTo(index, ...position(event))) { draw(); onDrag(); }
      });
      const end = () => { if (dragging) { dragging = false; onDragEnd(); } };
      circle.addEventListener('pointerup', end);
      circle.addEventListener('pointercancel', end);
    }
    circles[circles.length - 1].addEventListener('keydown', event => {
      const step = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[event.key];
      if (!step || sending) return;
      event.preventDefault();
      const [x, y] = s.points[index];
      if (moveTo(index, x + step[0], y + step[1])) { draw(); onDrag(); onKeyMove(); }
    });
  }

  draw();
  return draw;
}

function renderRow(row) {
  const s = state[row.key];
  const element = document.createElement('div');
  element.className = 'row';
  const factoryNote = row.factoryCurve ? 'Factory' : 'Factory (no curve)';
  const toyNote = row.key === 'toy' && piano ? 'plays the hidden piano' : '';
  element.innerHTML = `
    <label class="head"><input type="checkbox"> <span class="name">${row.label}</span> <span class="note state"></span></label>
    <div class="body" hidden>
      <label><input type="radio" name="mode-${row.key}" value="none"> No mapping <span class="note">use the velocity you play exactly</span></label>
      <label><input type="radio" name="mode-${row.key}" value="curve" checked> New curve</label>
      <div class="editor">
        <label>Curve: <select></select></label>
        <svg></svg>
      </div>
    </div>`;
  element.querySelector('input[type=checkbox]').checked = s.checked;
  element.querySelector(`input[value=${s.mode}]`).checked = true;
  const checkbox = element.querySelector('input[type=checkbox]'), body = element.querySelector('.body');
  const editor = element.querySelector('.editor'), menu = element.querySelector('select'), note = element.querySelector('.state');
  const entries = [['Custom', 'Custom'], ...(row.factoryCurve ? [['Factory', 'Factory']] : []),
    ...Object.keys(PRESETS).map(name => [name, name === 'Exactly as played' && !row.factoryCurve ? 'Exactly as played (factory)' : name])];
  menu.append(...entries.map(([value, label]) => new Option(label, value)));
  menu.value = s.menu;
  const draw = createEditor(element.querySelector('svg'), row, () => { s.menu = 'Custom'; menu.value = 'Custom'; refreshSummary(); }, rebuild, rebuildSoon);

  const showState = () => {
    body.hidden = !s.checked;
    editor.hidden = s.mode !== 'curve';
    note.textContent = [s.checked ? '' : factoryNote, toyNote].filter(Boolean).join(' · ');
  };
  checkbox.addEventListener('change', () => { s.checked = checkbox.checked; showState(); rebuild(); });
  element.querySelectorAll('input[type=radio]').forEach(radio => radio.addEventListener('change', () => { s.mode = radio.value; showState(); rebuild(); }));
  menu.addEventListener('change', () => {
    s.menu = menu.value;
    if (s.menu !== 'Custom') {
      s.points = s.menu === 'Factory' ? factoryPoints(factoryTable(row)) : PRESETS[s.menu].map(point => [...point]);
      draw();
    }
    rebuild();
  });
  showState();
  return element;
}

function showCurves() {
  factory = readFactoryCurves(source, { piano: false });
  for (const row of rows()) {
    state[row.key] = { checked: false, mode: 'curve', menu: startingMenu(row), points: factoryPoints(factoryTable(row)) };
  }
  $('rows').replaceChildren(...rows().map(renderRow));
}

/** Toy's row controls a different voice with the piano on or off, so it is rebuilt. Other rows don't change. */
$('piano').addEventListener('change', event => {
  const toyRow = () => rows().find(row => row.key === 'toy'), s = state.toy, onStart = s.menu === startingMenu(toyRow());
  piano = event.target.checked;
  if (onStart) {
    s.menu = startingMenu(toyRow());
    s.points = factoryPoints(factoryTable(toyRow()));
  }
  $('rows').children[ROWS.findIndex(row => row.key === 'toy')].replaceWith(renderRow(toyRow()));
  rebuild();
});

function summary() {
  const parts = [], toy = piano ? 'Toy plays the piano' : 'Toy keeps its own sound';
  for (const row of rows()) {
    const s = state[row.key];
    if (!s?.checked) continue;
    if (s.mode === 'none') parts.push(`${row.label}: No mapping`);
    else if (s.menu !== startingMenu(row)) parts.push(`${row.label}: ${s.menu}`);
  }
  if (!parts.length) return piano ? 'All factory, with Toy playing the piano.' : 'The original firmware, with nothing changed.';
  return [...parts, ...(parts.length < ROWS.length ? ['others factory'] : []), toy].join(' · ');
}

function refreshSummary() {
  $('summaryText').textContent = summary();
}

function setDownload() {
  const link = $('download');
  if (link.href) URL.revokeObjectURL(link.href);
  link.hidden = !image;
  if (image) {
    link.href = URL.createObjectURL(new Blob([image]));
    link.download = 'facelift-image.dat';
  } else {
    link.removeAttribute('href');
  }
}

/** Build and check after every change. There is no Build button to forget. */
async function rebuild() {
  clearTimeout(rebuildTimer);
  const token = ++buildToken, status = $('imageStatus');
  refreshSummary();
  image = null;
  setDownload();
  refreshFlash();  // Send stays off until this build finishes
  if (!source) {
    status.textContent = 'Load the updater to build an image.';
  } else {
    try {
      const built = buildImage(source, toSettings(state, { piano }), { piano });
      const digest = await sha256(built);
      if (token !== buildToken) return;
      image = built;
      status.textContent = `Image built and checked. SHA-256 ${digest}`;
      status.className = 'note mono';
    } catch (error) {
      if (token !== buildToken) return;
      status.textContent = `Could not build: ${error.message}`;
      status.className = 'bad';
    }
  }
  setDownload();
  refreshFlash();
}

/** For held arrow keys. The old image goes at once, so it can't be sent, and the build waits for a pause. */
function rebuildSoon() {
  buildToken++;  // a build still running is out of date too
  image = null;
  $('imageStatus').textContent = 'Building…';
  $('imageStatus').className = 'note';
  setDownload();
  refreshFlash();
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuild, KEY_REBUILD_DELAY_MS);
}

// ---------- 3. Flash ----------

if (!navigator.requestMIDIAccess) {
  $('noMidi').hidden = false;
  $('connect').disabled = true;
}

const selectedPort = () => midi?.outputs.get($('port').value) ?? null;

function whyNot(needsImage) {
  if (sending) return 'a send is running';
  if (!source) return 'load the updater first';
  if (needsImage && !image) return 'the image has not been built';
  if (!midi) return 'press Connect';
  const port = selectedPort();
  if (!port) return 'pick a port';
  if (isRefusedPort(port.name)) return 'IAC buses drop bulk SysEx, so they are refused';
  if (!$('confirmed').checked) return 'tick the box above to confirm the keyboard is ready';
  return '';
}

function refreshFlash() {
  const why = whyNot(true);
  $('send').disabled = !!why;
  $('restore').disabled = !!whyNot(false);
  $('stop').disabled = !sending;
  $('why').textContent = sending ? '' : why ? `Send is off: ${why}.` : 'Ready to send.';
}

function fillPorts() {
  const select = $('port'), keep = select.value;
  select.replaceChildren(new Option('Choose a port', ''), ...[...midi.outputs.values()].map(port => new Option(port.name, port.id)));
  select.value = midi.outputs.has(keep) ? keep : '';
  if (select.value !== keep) $('confirmed').checked = false;  // the tick was about a port that has gone
  select.disabled = sending;
  refreshFlash();
}

$('connect').addEventListener('click', async () => {
  try {
    midi = await navigator.requestMIDIAccess({ sysex: true });
  } catch (error) {
    log(`MIDI access was refused: ${error.message}`, 'bad');
    return;
  }
  midi.onstatechange = event => {
    fillPorts();
    if (sending && event.port.type === 'output' && event.port.state === 'disconnected' && event.port.id === sendingTo) {
      sender.fail(`"${event.port.name}" disconnected. The page stays locked until anything already queued has had time to clear.`);
    }
  };
  fillPorts();
});
$('port').addEventListener('change', () => { $('confirmed').checked = false; refreshFlash(); });
$('confirmed').addEventListener('change', refreshFlash);

let sendingTo = null;

function lock(locked) {
  sending = locked;
  $('updaterControls').disabled = locked;
  $('curveControls').disabled = locked || !source;
  $('connect').disabled = locked || !navigator.requestMIDIAccess;
  $('port').disabled = locked || !midi;
  $('confirmed').disabled = locked;
  $('progress').hidden = !locked && $('progress').value === 0;
}

function onVisibility() {
  if (document.hidden) log('This tab is hidden. Sending continues, but keep the computer awake.');
}

async function flash(data, label) {
  const port = selectedPort();
  if (!confirm(`Flash ${label} to "${port.name}"? Do not switch off until all 6 TYPE lamps are lit.`)) return;
  if (port.state !== 'connected') { log(`"${port.name}" is no longer connected. Nothing was sent.`, 'bad'); return; }
  const { messages, due } = sysexSchedule(data);
  sendingTo = port.id;
  sender = createSender({
    output: port, messages, due, onLog: text => log(text),
    onProgress: ({ sent, total, secondsLeft }) => {
      $('progress').max = total;
      $('progress').value = sent;
      $('progressText').textContent = `${sent} of ${total} sent, about ${Math.ceil(secondsLeft)} s left.`;
    },
  });
  lock(true);
  refreshFlash();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('beforeunload', warnBeforeLeaving);
  let wakeLock = null;
  navigator.wakeLock?.request('screen').then(lock => { wakeLock = lock; }, () => { /* sending still works without it */ });
  log(`Sending ${label} to "${port.name}".`);
  const result = await sender.start();
  wakeLock?.release?.();
  window.removeEventListener('beforeunload', warnBeforeLeaving);
  document.removeEventListener('visibilitychange', onVisibility);
  lock(false);
  $('confirmed').checked = false;  // the keyboard has left update mode, or needs checking again
  if (result === 'done') {
    $('progressText').textContent = 'All sent. Wait for all 6 TYPE lamps before switching off.';
    log('All messages sent. The keyboard finishes after this: wait for all 6 TYPE lamps.', 'ok');
  } else {
    $('progressText').textContent = { stopped: `Stopped. ${RECOVERY}`, failed: `Failed. ${RECOVERY}`, unsure: UNSURE }[result];
    log($('progressText').textContent, 'bad');
  }
  refreshFlash();
}

function warnBeforeLeaving(event) {
  event.preventDefault();
}

$('send').addEventListener('click', () => flash(image, `"${summary()}"`));
$('restore').addEventListener('click', () => flash(source, 'the unmodified v1.30 firmware'));
$('stop').addEventListener('click', () => {
  $('stop').disabled = true;
  log(sender.stop()
    ? 'Stopping. Messages already queued can\'t be recalled, so up to a minute more will still go out.'
    : 'Too late to stop: every message is already queued and can\'t be recalled. Do not switch off. Wait for all 6 TYPE lamps.');
});

rebuild();
