/* =============================================================================
   scripts/browser-test.mjs — end-to-end test in a real browser
   -----------------------------------------------------------------------------
   Checks what no unit test can see: that the worklets load, that the
   WebAssembly engine starts, that signal actually travels the whole chain, and
   that the interface responds.

   Three traps met while writing this, kept here as notes:

     - Chromium's fake audio device emits a periodic beep, not a continuous
       signal: the maximum has to be held over several seconds, or you sample
       during a silence and conclude the chain is dead;
     - an element outside the viewport receives no mouse events from Playwright,
       hence scrollIntoViewIfNeeded() before dragging a fader;
     - the chain passes the raw signal through when the model fails to load, so
       "there is sound" is not the same as "the amp is running". The capture
       load is confirmed by the worklet, and this test asserts on that.

   Prerequisites:
       npm run build
       npx playwright install chromium

   Usage:  npm run test:browser   (starts its own static server)
   ========================================================================== */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { writeWav } from '../render/wav.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PORT = 8137;

/**
 * A test take, written next to the test rather than committed.
 *
 * Chromium's fake device is a loud beep: through a high-gain capture it pins
 * every meter, with the amp bypassed as well as with it in, so it cannot tell
 * a working chain from a passthrough. A plucked note at -20 dBFS is the level a
 * guitar actually arrives at, and it exercises the file source at the same
 * time.
 */
function writeTestTake(file) {
  const rate = 48_000, seconds = 4;
  const n = rate * seconds;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    // One note repeating: 82.4 Hz (low E) with a few harmonics and a decay, so
    // the gate has something to open and close on.
    const beat = t % 1;
    const env = Math.exp(-beat * 3.5) * (beat < 0.98 ? 1 : 0);
    out[i] = 0.1 * env * (
      Math.sin(2 * Math.PI * 82.4 * t) +
      0.5 * Math.sin(2 * Math.PI * 164.8 * t) +
      0.25 * Math.sin(2 * Math.PI * 247.2 * t)
    );
  }
  writeWav(file, rate, [out]);
}

let failures = 0;
const ok = (name, detail) => console.log(`  ok    ${name}${detail ? ` — ${detail}` : ''}`);
const bad = (name, detail) => { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); };
/* The detail is printed either way for the measured checks: a threshold that
   passes by a hair is worth seeing before it starts failing. */
const check = (name, condition, detail) => (condition ? ok(name, detail) : bad(name, detail));

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.nam': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let file = path.join(DIST, decodeURIComponent(url.pathname));
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!file.startsWith(DIST) || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('dist/ is not built. Run `npm run build` first.');
  process.exit(1);
}

const server = await serve();
const browser = await chromium.launch({
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

console.log('\nTonecraft — end-to-end\n');

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });

check('the page renders the rig', await page.locator('.strand').isVisible());
check('the opening sheet offers both ways in',
  (await page.locator('.choice').count()) === 2);
check('the capture catalogue is read before starting',
  (await page.locator('select').first().locator('option').count()) > 0);

// Start, from the opening sheet. A failure here must be reported as a failure
// and not as a 30 second stack trace, so whatever the page said about it is
// read back — the product's whole voice is that it names the cause.
await page.locator('.choice', { hasText: 'I have a guitar' }).click();
let started = true;
try {
  await page.waitForSelector('.latency', { timeout: 30_000 });
  ok('the engine starts and reports a round trip');
} catch {
  started = false;
  const said = await page.locator('.says .note').allInnerTexts();
  bad('the engine starts and reports a round trip',
    said[0]?.replace(/\s+/g, ' ') ?? 'and the page said nothing at all');
}

if (!started) {
  // Nothing below means anything without a running engine, and letting it run
  // anyway turns one clear failure into a stack trace half a suite later.
  console.log('  ....  the rest is skipped: there is no engine to test');
  await browser.close();
  server.close();
  console.log(`\n${failures} check(s) failed.\n`);
  process.exit(1);
}

{
  // The capture must be confirmed loaded, not merely requested: when the model
  // fails, the chain passes the raw DI through, which is audible but looks
  // exactly like a working chain from the outside.
  const said = await page.evaluate(async () => {
    const found = new Set();
    for (let i = 0; i < 40; i++) {
      for (const n of document.querySelectorAll('.says .note')) found.add(n.textContent);
      await new Promise((r) => setTimeout(r, 100));
    }
    return [...found];
  });
  const complaints = said.filter((t) => t?.includes('did not load') || t?.includes('missing'));
  check('the capture loads', complaints.length === 0, complaints[0]);

  const playing = await page.locator('.marquee .t-heading').textContent();
  check('the rig names the capture it is playing', playing !== 'No capture installed', playing);

  // Ground truth, straight from the worklet: the model is loaded and the
  // processor is running it. Without this, "there is sound" proves nothing —
  // a failed load passes the dry signal through and the meters still move.
  const running = await page.locator('.marquee').getAttribute('data-capture');
  check('the worklet confirms the capture is running', running === 'loaded', running);
}

// Chromium's fake device beeps periodically, so hold the maximum.
/**
 * Chromium's fake device emits a periodic beep, not a continuous tone, so a
 * fixed window can land entirely in a gap and report a dead chain. This holds
 * the maximum until every threshold is met, and only gives up after twenty
 * seconds — which also makes it finish in about two when things are working.
 */
const levels = await page.evaluate(async () => {
  let cord = 0, input = 0, output = 0;
  // Two meters exist, In and Out. Reading them together would let the input
  // answer a question about the output.
  const bar = (sel) => document.querySelector(`${sel} .meter rect:last-child`);
  const until = performance.now() + 20_000;
  while (performance.now() < until) {
    for (const el of document.querySelectorAll('.cord')) {
      cord = Math.max(cord, Number(getComputedStyle(el).opacity));
    }
    input = Math.max(input, Number(bar('.strand > section:first-child')?.getAttribute('height') ?? 0));
    output = Math.max(output, Number(bar('.strand > section:last-child')?.getAttribute('height') ?? 0));
    if (cord > 0.2 && input > 1 && output > 1) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return { cord, input, output };
});
check('signal reaches the cord', levels.cord > 0.2, `peak opacity ${levels.cord.toFixed(2)} of 1.00`);
check('signal reaches the input meter', levels.input > 1, `peak height ${levels.input.toFixed(0)} of 96`);
check('signal reaches the output meter', levels.output > 1, `peak height ${levels.output.toFixed(0)} of 96`);

/**
 * Off means off. With the live input as the source, switching the simulation off
 * must leave nothing at all coming out — routing a laptop's built-in microphone
 * back through the speakers is a feedback path, not a comparison.
 *
 * Both meters are read, because they answer different questions: the input one
 * says the capture is closed, the output one says nothing is leaking past it.
 */
const meterPeak = (which, ms) => page.evaluate(async ([sel, d]) => {
  let peak = 0;
  const until = performance.now() + d;
  while (performance.now() < until) {
    const bar = document.querySelector(sel);
    peak = Math.max(peak, Number(bar?.getAttribute('height') ?? 0));
    await new Promise((r) => setTimeout(r, 40));
  }
  return peak;
}, [which === 'in'
  ? '.strand > section:first-child .meter rect:last-child'
  : '.strand > section:last-child .meter rect:last-child', ms]);

await page.locator('button.chain').click();
// Past the reverb tail, which is 1.3 s and legitimately still ringing.
await page.waitForTimeout(2500);
const mutedIn = await meterPeak('in', 2500);
const mutedOut = await meterPeak('out', 2500);
check('switching the simulation off closes the live input',
  mutedIn === 0 && mutedOut === 0, `in ${mutedIn}, out ${mutedOut}, of 96`);
check('and the rig says why it went quiet',
  (await page.locator('.says').innerText()).includes('nothing is being monitored'));

await page.locator('button.chain').click();
await page.waitForTimeout(1200);
const backIn = await page.evaluate(async () => {
  let peak = 0;
  const until = performance.now() + 20_000;
  while (performance.now() < until && peak <= 1) {
    const bar = document.querySelector('.strand > section:first-child .meter rect:last-child');
    peak = Math.max(peak, Number(bar?.getAttribute('height') ?? 0));
    await new Promise((r) => setTimeout(r, 50));
  }
  return peak;
});
check('switching it back on reopens the input', backIn > 1, `in ${backIn} of 96`);

// The faders drive the engine.
const fader = page.locator('.track').first();
await fader.scrollIntoViewIfNeeded();
const box = await fader.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2, box.y + 4, { steps: 6 });
await page.mouse.up();
ok('a fader takes a drag');

// Changing capture and cabinet, the two real tone choices.
const selects = page.locator('select');
const count = await selects.count();
const capture = selects.nth(count - 2);
const options = await capture.locator('option').allTextContents();
if (options.length > 1) {
  await capture.selectOption({ index: 1 });
  await page.waitForTimeout(2000);
  ok('the capture can be changed while playing');
}
await selects.nth(count - 1).selectOption({ index: 1 });
await page.waitForTimeout(500);
ok('the cabinet can be changed while playing');

// The file source, at a level a guitar actually arrives at.
const take = path.join(ROOT, 'node_modules', '.cache', 'tonecraft-take.wav');
fs.mkdirSync(path.dirname(take), { recursive: true });
writeTestTake(take);

await page.locator('.segmented button', { hasText: 'File' }).click();
await page.locator('.file input[type=file]').first().setInputFiles(take);
await page.waitForSelector('.wave svg', { timeout: 10_000 });
ok('an audio file is decoded and drawn');

await page.waitForTimeout(1500);

/**
 * Do the controls reach the audio?
 *
 * Not measured on the boost, which would look broken: in front of a capture
 * this saturated the pedal changes bite and low-end tightness and barely
 * touches the level, which is the whole reason it is there. Measured instead on
 * the two controls whose job *is* level.
 */
async function peakOver(ms) {
  return page.evaluate(async (duration) => {
    let peak = 0;
    const until = performance.now() + duration;
    while (performance.now() < until) {
      const bar = document.querySelector('.strand > section:last-child .meter rect:last-child');
      peak = Math.max(peak, Number(bar?.getAttribute('height') ?? 0));
      await new Promise((r) => setTimeout(r, 50));
    }
    return peak;
  }, ms);
}

/** End sets a fader to its minimum. */
async function press(label, key) {
  const fader = page.locator(`[role=slider][aria-label="${label}"]`);
  await fader.scrollIntoViewIfNeeded();
  await fader.focus();
  await fader.press(key);
  await page.waitForTimeout(600);
}

/**
 * Back to the preset default, which is what a double-click does — not Home,
 * which is the top of the travel. Getting that wrong left every later
 * measurement running at +6 dB of master and +14 dB of bass.
 */
async function reset(label) {
  const fader = page.locator(`[role=slider][aria-label="${label}"]`);
  await fader.scrollIntoViewIfNeeded();
  await fader.dblclick();
  await page.waitForTimeout(600);
}

const flat = await peakOver(2500);

// The test take is an 82 Hz note: a -14 dB shelf at 110 Hz takes its
// fundamental with it, so the post-cabinet correction has to show up here.
await press('Bass', 'End');
const cut = await peakOver(2500);
await reset('Bass');
check('the tone stage reaches the audio', flat - cut > 2,
  `${flat.toFixed(0)} flat, ${cut.toFixed(0)} with the bass cut, of 96`);

// Relative, not an absolute floor: -40 dB off a signal that peaks around a
// quarter of the bar still leaves a few pixels of it, and asserting on silence
// would be asserting the meter's rounding rather than the master.
await press('Master', 'End');
const quiet = await peakOver(2500);
await reset('Master');
check('the master reaches the audio', flat - quiet > 10,
  `${flat.toFixed(0)} at -12.4 dB, ${quiet.toFixed(0)} at -40 dB, of 96`);

// The take that ships. Someone with no guitar and no interface has to be able
// to hear what this does, so it has to actually load and play.
await page.locator('button.demo').click();
await page.waitForSelector('.wave svg', { timeout: 20_000 });
await page.waitForTimeout(1500);
ok('the demo take loads and plays');

/**
 * The A/B has to compare tone, not loudness: louder wins every loudness test
 * regardless of what it sounds like, so a direct path that is quietly 6 dB down
 * would make the amp sound better than it is, for free.
 *
 * Integrated over a full pass of the take, because a guitar performance is not
 * a steady tone and a peak reading would be measuring one note.
 */
const integrate = (ms) => page.evaluate(async (d) => {
  let sum = 0, n = 0;
  const until = performance.now() + d;
  while (performance.now() < until) {
    const bar = document.querySelector('.strand > section:last-child .meter rect:last-child');
    // Inverts the meter's own min(1, sqrt(level) * 1.4) scaling.
    sum += Math.pow(Number(bar?.getAttribute('height') ?? 0) / 96 / 1.4, 2);
    n++;
    await new Promise((r) => setTimeout(r, 40));
  }
  return sum / n;
}, ms);

/**
 * One button, so this asks for a state rather than clicking a named option: it
 * reads what the button says it is and flips it only if it has to.
 */
async function monitor(want) {
  const button = page.locator('button.chain');
  const on = (await button.getAttribute('aria-pressed')) === 'true';
  if (on !== (want === 'Amp')) await button.click();
}

/**
 * Both passes have to cover the same audio. The take is a performance, not a
 * steady tone, so integrating each side over whatever happened to be playing
 * put 1.8 dB of the take's own dynamics into the comparison. Home on the
 * waveform seeks to zero.
 */
async function passFromStart(label, ms) {
  await monitor(label);
  const wave = page.locator('[role=slider][aria-label="Position in the file"]');
  await wave.scrollIntoViewIfNeeded();
  await wave.focus();
  await wave.press('Home');
  await page.waitForTimeout(700);
  return integrate(ms);
}

const ampLevel = await passFromStart('Amp', 14_000);
const directLevel = await passFromStart('Direct', 14_000);
await monitor('Amp');

check('the direct path carries the dry signal', directLevel > 1e-3,
  `mean amplitude ${directLevel.toExponential(2)}`);
const offset = 20 * Math.log10(ampLevel / directLevel);
check('the A/B is level-matched, so it compares tone', Math.abs(offset) < 1.5,
  `${offset.toFixed(2)} dB apart`);

/**
 * The messages below the rig arrive and leave on their own — a hardware
 * diagnosis once the input has been measured, a dropout warning that comes and
 * goes. If they push the strand around, the interface feels unstable at exactly
 * the moment it is trying to tell somebody something.
 */
const before = await page.locator('.strand').boundingBox();
await page.evaluate(() => {
  const says = document.querySelector('.says');
  const note = document.createElement('p');
  note.className = 'note';
  note.innerHTML = '<span>A message two lines long, appearing while playing.</span>' +
    '<span class="fix">And the remedy that comes with it.</span>';
  says.appendChild(note);
});
await page.waitForTimeout(300);
const after = await page.locator('.strand').boundingBox();
const moved = Math.abs(after.y - before.y);
check('a message does not move the rig', moved < 1, `${moved.toFixed(1)} px`);

// FR-18: the limiter has no control anywhere, in any mode, on any path.
const bypasses = await page.locator('.strand button[aria-label^="Bypass"]').allTextContents();
// The same A/B from the keyboard, which is what makes it usable more than twice.
await monitor('Amp');
const beforeKey = await page.locator('button.chain').getAttribute('aria-pressed');
await page.locator('body').click({ position: { x: 5, y: 5 } });
await page.keyboard.press('b');
await page.waitForTimeout(300);
const afterKey = await page.locator('button.chain').getAttribute('aria-pressed');
check('B flips the chain from the keyboard', beforeKey !== afterKey,
  `${beforeKey} then ${afterKey}`);
await monitor('Amp');

check('no stage offers a bypass that should not have one',
  !(await page.locator('button[aria-label="Bypass Amp"]').count()) &&
  !(await page.locator('button[aria-label="Bypass Cab"]').count()) &&
  !(await page.locator('button[aria-label="Bypass Out"]').count()),
  `${bypasses.length} bypasses in the strand`);

check('nothing threw', errors.length === 0, errors[0]);

/**
 * The other way in, on its own page.
 *
 * Someone who arrived to find out what this is should not be met with a
 * microphone permission prompt: that is a toll gate in front of a
 * demonstration. The demo path must therefore never touch getUserMedia, and
 * "never" is the kind of claim that needs counting rather than reading.
 */
const demoPage = await browser.newPage();
await demoPage.addInitScript(() => {
  window.__mic = 0;
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (...args) => { window.__mic++; return real(...args); };
});
const demoErrors = [];
demoPage.on('pageerror', (e) => demoErrors.push(String(e)));
await demoPage.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await demoPage.locator('.choice', { hasText: 'Just let me hear it' }).click();
await demoPage.waitForSelector('.wave svg', { timeout: 40_000 });
await demoPage.waitForTimeout(2500);

const asked = await demoPage.evaluate(() => window.__mic);
check('the demo path never asks for a microphone', asked === 0, `${asked} request(s)`);
check('and it is playing the take through the chain',
  (await demoPage.locator('.marquee').getAttribute('data-capture')) === 'loaded' &&
  (await demoPage.locator('.transport button.start').innerText()) === 'Pause');

const demoLevel = await demoPage.evaluate(async () => {
  let peak = 0;
  const until = performance.now() + 8000;
  while (performance.now() < until && peak <= 1) {
    const bar = document.querySelector('.strand > section:last-child .meter rect:last-child');
    peak = Math.max(peak, Number(bar?.getAttribute('height') ?? 0));
    await new Promise((r) => setTimeout(r, 40));
  }
  return peak;
});
check('and there is sound without anyone plugging anything in', demoLevel > 1,
  `output peak ${demoLevel.toFixed(0)} of 96`);
check('nothing threw on the demo path', demoErrors.length === 0, demoErrors[0]);

await browser.close();
server.close();

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
