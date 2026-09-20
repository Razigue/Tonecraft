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
import { chromium, devices } from 'playwright';
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
  // Long enough to outlast every measurement below: the take plays once, it does not loop.
  const rate = 48_000, seconds = 60;
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

if (!fs.existsSync(path.join(DIST, 'app', 'index.html'))) {
  console.error('dist/ is not built. Run `npm run build` first.');
  process.exit(1);
}

const server = await serve();
/* The checks read English: every page is opened as an English browser, so a
   machine set to French does not fail them (a French page says so below). */
const browser = await chromium.launch({
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
  ],
});
const page = await browser.newPage({ locale: 'en-US' });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

console.log('\nTonecraft — end-to-end\n');

await page.goto(`http://127.0.0.1:${PORT}/app/`, { waitUntil: 'networkidle' });

check('the page renders the rig', await page.locator('.amp-head').isVisible());
check('the welcome offers musician and tester paths',
  await page.getByRole('button', { name: 'Musician' }).isVisible() && await page.getByRole('button', { name: 'Tester' }).isVisible());
// French and English, detected from the browser's languages: nothing on the
// rig or the welcome offers to switch; the settings sheet does.
const welcome = page.locator('dialog.welcome');
check('the welcome speaks the browser’s language, English here',
  await welcome.getByRole('heading', { name: 'Welcome to Tonecraft' }).isVisible() && (await page.evaluate(() => document.documentElement.lang)) === 'en');
check('and offers no language switch of its own',
  (await welcome.getByRole('button', { name: /^(EN|FR)$|Français/ }).count()) === 0 && (await page.locator('.bar').getByRole('button', { name: /^(EN|FR)$|Français/ }).count()) === 0);
{
  const french = await browser.newPage({ locale: 'fr-FR' });
  await french.goto(`http://127.0.0.1:${PORT}/app/`, { waitUntil: 'networkidle' });
  check('a French browser is welcomed in French, the page saying so',
    await french.locator('dialog.welcome').getByRole('heading', { name: 'Bienvenue sur Tonecraft' }).isVisible()
      && (await french.evaluate(() => document.documentElement.lang)) === 'fr');
  await french.close();
}
check('the capture catalogue is read before starting',
  (await page.locator('select').first().locator('option').count()) > 0);

// Start, from the opening sheet. A failure here must be reported as a failure
// and not as a 30 second stack trace, so whatever the page said about it is
// read back — the product's whole voice is that it names the cause.
await page.getByRole('button', { name: 'Musician' }).click();
check('musician opens audio settings immediately', await page.getByRole('dialog', { name: 'Settings' }).locator('.audio-settings').isVisible());
await page.getByRole('button', { name: 'Done', exact: true }).click();
let started = true;
try {
  await page.waitForSelector('.latency', { timeout: 30_000 });
  ok('the engine starts and reports a round trip');
} catch {
  started = false;
  const said = await page.locator('.sheet .failure').allInnerTexts();
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
      for (const n of document.querySelectorAll('.sheet .failure, .workspace .notice')) {
        found.add(n.textContent);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return [...found];
  });
  const complaints = said.filter((t) => t?.includes('did not load') || t?.includes('missing'));
  check('the capture loads', complaints.length === 0, complaints[0]);

  const playing = await page.getByRole('combobox', { name: 'Capture', exact: true }).inputValue();
  check('the selector identifies the capture it is playing', playing.length > 0, playing);
  check('Guilt starts with ENGL E530 and the recorded Celestion G12 Vintage IR',
    playing === 'engl-e530.nam'
    && await page.getByRole('combobox', { name: 'Cabinet', exact: true }).inputValue() === 'celestion-g12-vintage'
    && await page.evaluate(() => performance.getEntriesByType('resource').some((r) => r.name.endsWith('/irs/celestion-g12-vintage.wav'))));

  // Ground truth, straight from the worklet: the model is loaded and the
  // processor is running it. Without this, "there is sound" proves nothing —
  // a failed load passes the dry signal through and the meters still move.
  const running = await page.locator('.capture-info').getAttribute('data-capture');
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
    /* The head is a photograph whose glass is already lit, so the signal is
       read off the bloom layer screened over it: its opacity is
       0.12 + light * 0.3, and the lighting that produced it is the inverse.
       The neutral head has no such layer, so a missing one reads as no
       measurement rather than as darkness. */
    const glass = document.querySelector('.skin-bloom img');
    if (glass !== null) {
      const opacity = Number(glass.style.opacity === '' ? 0.12 : glass.style.opacity);
      cord = Math.max(cord, (opacity - 0.12) / 0.3);
    }
    input = Math.max(input, Number(bar('.global-controls > .io-control:first-child')?.getAttribute('height') ?? 0));
    output = Math.max(output, Number(bar('.output-control')?.getAttribute('height') ?? 0));
    if (cord > 0.2 && input > 1 && output > 1) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return { cord, input, output };
});
check('signal illuminates the glass', levels.cord > 0.2, `peak illumination ${levels.cord.toFixed(2)} of 1.00`);
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
  ? '.global-controls > .io-control:first-child .meter rect:last-child'
  : '.output-control .meter rect:last-child', ms]);

// The tuner keeps listening to the selected guitar input but owns silence at
// the destination. Closing it must hand the exact running chain back.
await page.getByRole('button', { name: 'Open tuner' }).click();
const tunerBox = await page.locator('dialog.tuner').boundingBox();
const viewport = page.viewportSize();
check('the tuner opens as a centred popup',
  tunerBox !== null && viewport !== null && tunerBox.width < viewport.width * 0.75
    && Math.abs(tunerBox.x + tunerBox.width / 2 - viewport.width / 2) < 2,
  tunerBox === null ? 'missing' : `${tunerBox.width.toFixed(0)} px wide at x ${tunerBox.x.toFixed(0)}`);
check('the tuner exposes a centred accuracy meter',
  await page.getByRole('meter', { name: 'Tuning accuracy' }).isVisible());
await page.waitForTimeout(400);
const tuningIn = await meterPeak('in', 2200);
const tuningOut = await meterPeak('out', 1200);
check('the tuner keeps the guitar input alive while muting all monitoring',
  tuningIn > 1 && tuningOut === 0, `in ${tuningIn}, out ${tuningOut}, of 96`);
await page.getByRole('button', { name: 'Close tuner' }).click();
const restoredOut = await meterPeak('out', 5000);
check('closing the tuner restores the audio chain', restoredOut > 1, `out ${restoredOut} of 96`);

await page.getByRole('button', { name: 'Open metronome' }).click();
const metronomeBox = await page.locator('dialog.metronome').boundingBox();
check('the metronome opens as a centred popup',
  metronomeBox !== null && viewport !== null && metronomeBox.width < viewport.width * 0.5
    && Math.abs(metronomeBox.x + metronomeBox.width / 2 - viewport.width / 2) < 2);
check('opening the metronome does not start a sound',
  await page.locator('dialog.metronome').getAttribute('data-playing') === 'false');
const tempoInput = page.getByRole('spinbutton', { name: 'Tempo in BPM' });
check('the tempo field is empty and accepts up to 450 BPM',
  await tempoInput.inputValue() === '' && await tempoInput.getAttribute('placeholder') === null
    && await tempoInput.getAttribute('max') === '450');
await page.evaluate(async () => {
  const button = document.querySelector('dialog.metronome .tap');
  for (let i = 0; i < 4; i += 1) {
    button.click();
    if (i < 3) await new Promise((resolve) => setTimeout(resolve, 500));
  }
});
const tappedBpm = Number(await tempoInput.inputValue());
check('four taps set the tempo from their average interval',
  tappedBpm >= 117 && tappedBpm <= 122, `${tappedBpm} BPM`);
check('the fourth tap starts the metronome',
  await page.locator('dialog.metronome').getAttribute('data-playing') === 'true');
await page.getByRole('slider', { name: 'Metronome volume' }).fill('0.25');
check('the metronome volume is adjustable',
  await page.locator('dialog.metronome output').textContent() === '25%');
await page.getByRole('button', { name: 'Close metronome' }).click();
const metronomeToggle = page.getByRole('button', { name: 'Pause metronome' });
check('the metronome keeps playing outside its popup',
  await metronomeToggle.getAttribute('aria-pressed') === 'true');
await metronomeToggle.click();
check('the outside toggle pauses the metronome',
  await page.getByRole('button', { name: 'Start metronome' }).getAttribute('aria-pressed') === 'false');
await page.getByRole('button', { name: 'Start metronome' }).click();
check('the outside toggle resumes the stored tempo',
  await page.getByRole('button', { name: 'Pause metronome' }).getAttribute('aria-pressed') === 'true');
await page.getByRole('button', { name: 'Pause metronome' }).click();

await page.locator('button.rocker, button.power-indicator').click();
// Past the reverb tail, which is 1.3 s and legitimately still ringing.
await page.waitForTimeout(2500);
const mutedIn = await meterPeak('in', 2500);
const mutedOut = await meterPeak('out', 2500);
check('switching the simulation off closes the live input',
  mutedIn === 0 && mutedOut === 0, `in ${mutedIn}, out ${mutedOut}, of 96`);
await page.locator('button.rocker, button.power-indicator').click();
await page.waitForTimeout(1200);
const backIn = await page.evaluate(async () => {
  let peak = 0;
  const until = performance.now() + 20_000;
  while (performance.now() < until && peak <= 1) {
    const bar = document.querySelector('.global-controls > .io-control:first-child .meter rect:last-child');
    peak = Math.max(peak, Number(bar?.getAttribute('height') ?? 0));
    await new Promise((r) => setTimeout(r, 50));
  }
  return peak;
});
check('switching it back on reopens the input', backIn > 1, `in ${backIn} of 96`);

// Knobs follow vertical movement: up raises the value and down lowers it.
const knob = page.locator('input[type=range]').first();
await knob.scrollIntoViewIfNeeded();
const beforeDrag = Number(await knob.inputValue());
const box = await knob.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2, box.y + 4, { steps: 6 });
await page.mouse.up();
const afterDrag = Number(await knob.inputValue());
check('dragging a knob upward raises its value', afterDrag > beforeDrag,
  `${beforeDrag.toFixed(3)} then ${afterDrag.toFixed(3)}`);
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2, box.y + box.height + 28, { steps: 6 });
await page.mouse.up();
const afterDown = Number(await knob.inputValue());
check('dragging a knob downward lowers its value', afterDown < afterDrag,
  `${afterDrag.toFixed(3)} then ${afterDown.toFixed(3)}`);

// Once a preset has been changed by hand its name becomes "Custom tone", but
// double-click still returns to the values of the preset it came from.
const tonePreset = page.getByRole('combobox', { name: 'Tone preset', exact: true });
await tonePreset.selectOption('Modern metal');
await page.waitForTimeout(1500);
check('Modern metal selects the exact Nightmare capture and Celestion IR',
  await page.getByRole('combobox', { name: 'Capture', exact: true }).inputValue() === 'va-nightmare-md-and-mesa-oversized.nam'
  && await page.getByRole('combobox', { name: 'Cabinet', exact: true }).inputValue() === 'celestion-g12-vintage');
check('the recorded Celestion IR is fetched when the preset changes',
  await page.evaluate(() => performance.getEntriesByType('resource').some((r) => r.name.endsWith('/irs/celestion-g12-vintage.wav'))));
const bass = page.locator('input[type=range][aria-label="Bass"]');
const presetBass = Number(await bass.inputValue());
await bass.press('ArrowUp');
await bass.dblclick();
await page.waitForTimeout(300);
const resetBass = Number(await bass.inputValue());
check('double-click restores the current preset value',
  Math.abs(resetBass - presetBass) < 0.0001,
  `${resetBass.toFixed(4)} instead of ${presetBass.toFixed(4)}`);
await tonePreset.selectOption('Lead');
check('returning to Lead restores the Guilt amp and cabinet',
  await page.getByRole('combobox', { name: 'Capture', exact: true }).inputValue() === 'engl-e530.nam'
  && await page.getByRole('combobox', { name: 'Cabinet', exact: true }).inputValue() === 'celestion-g12-vintage');
await page.waitForTimeout(1500);

// Changing capture and cabinet, the two real tone choices. Found by their
// labels: how many selects the page has depends on the machine — an output
// selector appears when there is more than one output to choose from.
const capture = page.getByRole('combobox', { name: 'Capture', exact: true });
const options = await capture.locator('option').allTextContents();
if (options.length > 1) {
  await capture.selectOption({ index: 1 });
  await page.waitForTimeout(2000);
  ok('the capture can be changed while playing');
}
await page.getByRole('combobox', { name: 'Cabinet', exact: true }).selectOption({ index: 1 });
await page.waitForTimeout(500);
ok('the cabinet can be changed while playing');

// A player's own IR, as IR packs export them: a few ms of silence, then a
// decaying cabinet-ish impulse. It becomes the cabinet in use, by name.
const irFile = path.join(ROOT, 'node_modules', '.cache', 'tonecraft-my-cab.wav');
fs.mkdirSync(path.dirname(irFile), { recursive: true });
{
  const rate = 48_000, ir = new Float32Array(rate / 2);
  let seed = 7;
  for (let i = 240; i < 240 + 2048; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    ir[i] = (seed / 0x3fffffff - 1) * Math.exp(-(i - 240) / 200) * 0.5;
  }
  writeWav(irFile, rate, [ir]);
}
const cabinet = page.getByRole('combobox', { name: 'Cabinet', exact: true });
await page.getByLabel('Cabinet IR file', { exact: true }).setInputFiles(irFile);
await page.waitForFunction(() => document.querySelector('select[aria-label="Cabinet"]')?.value === 'custom', null, { timeout: 5000 }).catch(() => {});
check('a cabinet IR file becomes the cabinet in use', await cabinet.inputValue() === 'custom',
  (await cabinet.locator('option:checked').textContent()) ?? '');
const junk = path.join(ROOT, 'node_modules', '.cache', 'tonecraft-not-an-ir.wav');
fs.writeFileSync(junk, 'not audio');
await page.getByLabel('Cabinet IR file', { exact: true }).setInputFiles(junk);
await page.waitForTimeout(800);
check('a file that is not audio is refused, and the cabinet stays', await cabinet.inputValue() === 'custom'
  && await page.getByText('could not be read as an impulse response').isVisible());
// Back to a synthesised cabinet: the tone checks below measure through one.
await cabinet.selectOption('v30mod');
await page.waitForTimeout(300);
check('and a synthesised cabinet can be chosen again', await cabinet.inputValue() === 'v30mod');

// A DI dropped on the recorder's guitar lane plays live through the chain, at a
// level a guitar actually arrives at.
const take = path.join(ROOT, 'node_modules', '.cache', 'tonecraft-take.wav');
fs.mkdirSync(path.dirname(take), { recursive: true });
writeTestTake(take);

// The takes are a drawer over the stage, opened from the transport.
await page.getByLabel('Guitar DI file', { exact: true }).setInputFiles(take);
await page.getByLabel('Recorded guitar', { exact: true }).waitFor({ timeout: 20_000 });
ok('an audio file is decoded and drawn on the guitar lane');

const listenButton = page.locator('.recorder button.listen');
// The drawer covers the foot of the stage, where the amp's knobs are: it is
// opened for a press and closed again, and the take plays on behind it.
async function inTakes(action) {
  await action();
}
async function playTake() {
  await inTakes(async () => {
    if ((await listenButton.getAttribute('aria-label')) === 'Listen to take') await listenButton.click();
    await page.getByRole('button', { name: 'Pause take', exact: true }).waitFor({ timeout: 20_000 });
  });
}
async function stopTake() {
  await inTakes(async () => {
    if ((await listenButton.getAttribute('aria-label')) === 'Pause take') await listenButton.click();
    await page.getByRole('button', { name: 'Listen to take', exact: true }).waitFor({ timeout: 20_000 });
  });
}
// Loading a take never starts it, so the level checks below have to press play.
await playTake();
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
      const bar = document.querySelector('.output-control .meter rect:last-child');
      peak = Math.max(peak, Number(bar?.getAttribute('height') ?? 0));
      await new Promise((r) => setTimeout(r, 50));
    }
    return peak;
  }, ms);
}

/**
 * One knob, by its name, wherever the studio puts it. GAIN and MASTER are
 * engraved on the head's plate and are also the band's In and Out: one
 * parameter behind two controls, on purpose, so a label can match twice. The
 * band's is taken when there is one, because the band is there in both modes
 * and behind either amplifier.
 */
function fader(label) {
  const band = page.locator(`.global-controls input[type=range][aria-label="${label}"]`);
  const head = page.locator(`.amp-head input[type=range][aria-label="${label}"]`);
  return band.or(head).first();
}

/** Native range Home sets a knob to its minimum. */
async function press(label, key) {
  const knob = fader(label);
  await knob.scrollIntoViewIfNeeded();
  await knob.focus();
  await knob.press(key);
  await page.waitForTimeout(600);
}

/**
 * Back to the preset default, which is what a double-click does — not Home,
 * which is the top of the travel. Getting that wrong left every later
 * measurement running at +6 dB of master and +14 dB of bass.
 */
async function reset(label) {
  const knob = fader(label);
  await knob.scrollIntoViewIfNeeded();
  await knob.dblclick();
  await page.waitForTimeout(600);
}

const flat = await peakOver(2500);

// The test take is an 82 Hz note: a -14 dB shelf at 110 Hz takes its
// fundamental with it, so the post-cabinet correction has to show up here.
await press('Bass', 'Home');
const cut = await peakOver(2500);
await reset('Bass');
check('the tone stage reaches the audio', flat - cut > 2,
  `${flat.toFixed(0)} flat, ${cut.toFixed(0)} with the bass cut, of 96`);

// Relative, not an absolute floor: -40 dB off a signal that peaks around a
// quarter of the bar still leaves a few pixels of it, and asserting on silence
// would be asserting the meter's rounding rather than the master.
await press('Output', 'Home');
const quiet = await peakOver(2500);
await reset('Output');
check('the master reaches the audio', flat - quiet > 10,
  `${flat.toFixed(0)} at -12.4 dB, ${quiet.toFixed(0)} at -40 dB, of 96`);

/**
 * The looper, end to end, through the real worklet.
 *
 * The take is playing, so there is material to record. What this proves is the
 * thing the chain tests cannot: that a press in the interface reaches the
 * chain, and that the loop is still playing when the source that fed it has
 * stopped — which is the whole point of a looper.
 */
{
  const status = page.locator('.loop-status');
  const button = page.locator('button.loop-main');
  check('the looper starts empty and offers to record',
    (await status.innerText()).includes('Empty') && (await button.innerText()) === 'Rec');

  await button.click();
  await page.waitForTimeout(1200);
  check('recording is recording', (await status.innerText()).includes('Recording'));
  check('while recording, the button offers to stop', (await button.innerText()) === 'Stop');
  await button.click();                       // stop: the loop closes and plays by itself
  await page.waitForTimeout(400);
  check('the loop closes and plays', (await status.innerText()).includes('Playing'));

  // The take stops; the loop must not. Stopping a take hands the rig back to
  // the live input — Chromium's fake device, which beeps — so the loop is told
  // apart by the energy it adds over that, not by silence.
  await stopTake();
  await page.waitForTimeout(300);
  const energy = (ms) => page.evaluate(async (d) => {
    let sum = 0, n = 0;
    const until = performance.now() + d;
    while (performance.now() < until) {
      const bar = document.querySelector('.output-control .meter rect:last-child');
      sum += Math.pow(Number(bar?.getAttribute('height') ?? 0) / 96 / 1.4, 2);
      n++;
      await new Promise((r) => setTimeout(r, 40));
    }
    return sum / n;
  }, ms);
  const looped = await energy(1500);
  check('the loop keeps playing after the take stops', looped > 1e-4, `mean ${looped.toExponential(2)}`);

  await page.locator('button.loop-power').click();
  await page.waitForTimeout(400);
  check('power off empties it', (await status.innerText()).includes('Empty'));
  const after = await energy(1500);
  check('and the loop is gone from the output', after < looped * 0.7,
    `mean ${looped.toExponential(2)} with the loop, ${after.toExponential(2)} without`);
  await playTake();   // the take, playing again
  await page.waitForTimeout(600);
}

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
    const bar = document.querySelector('.output-control .meter rect:last-child');
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
  const button = page.locator('button.rocker, button.power-indicator');
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
  await stopTake();
  await playTake();
  await page.waitForTimeout(700);
  return integrate(ms);
}

const ampLevel = await passFromStart('Amp', 3000);
const offLevel = await passFromStart('Off', 3000);
const restoredLevel = await passFromStart('Amp', 3000);
check('Power off silences the DI and effect tails', offLevel < 1e-5,
  `mean amplitude ${offLevel.toExponential(2)}`);
check('Power on restores the loaded DI', ampLevel > 1e-3 && restoredLevel > 1e-3,
  `mean ${ampLevel.toExponential(2)} before, ${restoredLevel.toExponential(2)} after`);

/**
 * The messages below the rig arrive and leave on their own — a hardware
 * diagnosis once the input has been measured, a dropout warning that comes and
 * goes. If they push the strand around, the interface feels unstable at exactly
 * the moment it is trying to tell somebody something.
 */
/* In document coordinates, not viewport ones. By this point the page is
   scrolled to its maximum (the fader drags and the waveform focus above scroll
   it there), so the rig's viewport position is a function of the scroll clamp:
   a transient dropout warning expiring inside the window below shortens the
   document by its one line, the browser clamps the scroll down to match, and
   every element appears to move by exactly that line's 22 px. That is the
   scroll clamp, not the layout, and it failed this check about half the time.
   The document position answers the question actually being asked. */
const rigTop = () => page.evaluate(
  () => document.querySelector('.amp-head').getBoundingClientRect().top + window.scrollY);
const before = await rigTop();
// Written into the slot the rig keeps for it, which is what happens at runtime.
// Appending a second element would be testing a case the product never makes.
await page.evaluate(() => {
  const notice = document.querySelector('.stage .notice');
  notice.textContent = 'A notice appearing while playing, two lines long, about '
    + 'the take currently on screen and what to do about it.';
});
await page.waitForTimeout(300);
const after = await rigTop();
const moved = Math.abs(after - before);
check('a notice does not move the rig', moved < 1, `${moved.toFixed(1)} px`);
check('and the rig keeps a place for it whether or not there is one',
  (await page.locator('.stage .notice').count()) === 1);

// FR-18: the limiter has no control anywhere, in any mode, on any path.
// Every switch the amp offers: the head's own lever, and the three stages
// behind the band's pedals key. None of them is the limiter.
const bypasses = await page.locator('.amp-head button[aria-pressed], .pedals button[aria-pressed]').allTextContents();
// The same A/B from the keyboard, which is what makes it usable more than twice.
await monitor('Amp');
const beforeKey = await page.locator('button.rocker, button.power-indicator').getAttribute('aria-pressed');
await page.locator('body').click({ position: { x: 5, y: 5 } });
await page.keyboard.press('b');
await page.waitForTimeout(300);
const afterKey = await page.locator('button.rocker, button.power-indicator').getAttribute('aria-pressed');
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
 * The session outlives the tab (store/, IndexedDB). The tone and the tempo
 * come back after a reload — and nothing plays on its own, because an
 * AudioContext still needs a gesture and a page that makes noise by itself is
 * the thing this product refuses to be.
 */
{
  const bassBefore = await page.locator('input[type=range][aria-label="Bass"]').inputValue();
  const cabBefore = await page.getByRole('combobox', { name: 'Cabinet', exact: true }).inputValue();
  // Past the write debounce; pagehide would flush it anyway, this is belt and braces.
  await page.waitForTimeout(500);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const bassAfter = await page.locator('input[type=range][aria-label="Bass"]').inputValue();
  const cabAfter = await page.getByRole('combobox', { name: 'Cabinet', exact: true }).inputValue();
  check('the tone survives a reload', bassAfter === bassBefore && cabAfter === cabBefore,
    `bass ${bassBefore} then ${bassAfter}, cabinet ${cabBefore} then ${cabAfter}`);
  const toggle = page.getByRole('button', { name: 'Start metronome' });
  check('the tempo survives a reload, and waits to be started',
    await toggle.isEnabled() && (await toggle.getAttribute('aria-pressed')) === 'false');
  check('nothing starts by itself after a reload', (await page.locator('.latency').count()) === 0);
}

/**
 * The other way in, on its own page.
 *
 * Someone who arrived to find out what this is should not be met with a
 * microphone permission prompt: that is a toll gate in front of a
 * demonstration. The demo path must therefore never touch getUserMedia, and
 * "never" is the kind of claim that needs counting rather than reading.
 */
const demoPage = await browser.newPage({ locale: 'en-US' });
await demoPage.addInitScript(() => {
  window.__mic = 0;
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (...args) => { window.__mic++; return real(...args); };
});
const demoErrors = [];
const demoRequests = [];
demoPage.on('pageerror', (e) => demoErrors.push(String(e)));
demoPage.on('request', (request) => {
  if (request.url().includes('/di/demo-di.wav')) demoRequests.push(request.url());
});
await demoPage.goto(`http://127.0.0.1:${PORT}/app/`, { waitUntil: 'networkidle' });
await demoPage.getByRole('button', { name: 'Tester' }).click();
// A tester is walked through the page one window at a time, the rest in the
// dark, each window lit where it is and explained beside it.
check('a tester starts with the tutorial', await demoPage.locator('.tour-card').isVisible());
const tourTargets = ['.global-controls', '.amp-head', '.demo-panel', '.reader', '.reader', '.metronome-launch', null];
const tourSeen = [];
let tourWaited = false;
for (const [step, target] of tourTargets.entries()) {
  // The composing step waits for a note written from the keyboard.
  if (step === 4) {
    await demoPage.waitForTimeout(900);
    const waited = await demoPage.locator('.tour-card .tour-next').isDisabled();
    await demoPage.locator('.write-tab').click();
    await demoPage.locator('.editor-bar').waitFor({ timeout: 30000 });
    await demoPage.keyboard.press('3');
    await demoPage.waitForFunction(() => !document.querySelector('.tour-card .tour-next').disabled, null, { timeout: 15000 });
    tourWaited = waited;
  }
  await demoPage.waitForTimeout(900);
  tourSeen.push(await demoPage.evaluate((selector) => {
    const card = document.querySelector('.tour-card').getBoundingClientRect();
    const inView = card.top >= 0 && card.bottom <= innerHeight && card.left >= 0 && card.right <= innerWidth;
    const lit = [...document.querySelectorAll('.tour-lit')];
    const title = document.querySelector('#tour-title').textContent;
    if (selector === null) return { title, ok: lit.length === 0 && inView };
    const el = document.querySelector(selector);
    const r = el.getBoundingClientRect();
    const top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
    const hit = document.elementFromPoint(r.left + Math.min(r.width / 2, 24), top + Math.min((bottom - top) / 2, 24));
    const overlaps = !(card.bottom <= r.top || card.top >= r.bottom || card.right <= r.left || card.left >= r.right);
    const shaded = document.elementFromPoint(2, 2)?.classList.contains('tour-shade');
    const tall = r.height + card.height + 48 > innerHeight;
    return {
      title,
      ok: lit.includes(el) && el.contains(hit) && shaded && inView && (tall || !overlaps),
      detail: `lit ${lit.includes(el)}, on top ${el.contains(hit)}, shaded ${shaded}, card in view ${inView}, overlaps ${overlaps && !tall}`,
    };
  }, target));
  await demoPage.locator('.tour-card .tour-next').click();
}
check('the tutorial lights each window in turn, the page dark around it, the explanation beside it',
  tourSeen.every((s) => s.ok), tourSeen.map((s) => `${s.title}: ${s.ok ? 'ok' : s.detail}`).join(' · '));
check('the composing step waits for a note written from the keyboard', tourWaited);
await demoPage.locator('.write-tab').click();
check('and gives the page back as it was',
  (await demoPage.locator('.tour-shade, .tour-lit').count()) === 0
    && (await demoPage.evaluate(() => document.querySelector('.global-controls').style.zIndex === '' && document.querySelector('.metronome-launch').style.zIndex === '')));
check('in English for an English browser', tourSeen[0]?.title === 'General settings' && tourSeen[4]?.title === 'Write your own tab' && tourSeen[6]?.title === 'Your turn',
  tourSeen.map((s) => s.title).join(' · '));
// A tester has the settings sheet too, with the language and nothing else.
await demoPage.getByRole('button', { name: 'Settings', exact: true }).click();
check('a tester’s settings hold the language and no audio',
  (await demoPage.getByRole('dialog', { name: 'Settings' }).getByRole('radio', { name: 'Français' }).count()) === 1
    && (await demoPage.locator('.audio-settings').count()) === 0);
await demoPage.getByRole('radio', { name: 'Français', exact: true }).click();
// The sheet itself switches on the spot.
await demoPage.getByRole('button', { name: 'Terminé', exact: true }).click();
// A tester reads one page: the head, the demo and the reader under each
// other, and none of the musician's bands (CLAUDE.md §4).
check('a tester gets the page, not the instrument',
  (await demoPage.getByRole('tab', { name: /^(Son|Jeu|Tone|Play)$/ }).count()) === 0
    && (await demoPage.locator('.transport, .recorder').count()) === 0
    && (await demoPage.locator('.page.tester .stage .demo-panel').count()) === 1
    && (await demoPage.evaluate(() => document.documentElement.scrollHeight > innerHeight)));
// The language is state the whole studio reads, not the welcome's and the
// tutorial's alone: the rig, the amp and the reader follow at once.
check('French reaches the whole studio, not only the tutorial',
  await demoPage.evaluate(() => {
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? '';
    return text('.global-controls .io-control .label') === 'Entrée'
      && text('.pedals .pedal:first-child .enable b') === 'Hauteur'
      && text('.reader .eyebrow') === 'Lecteur de tablatures'
      && document.querySelector('.rocker, .power-indicator')?.getAttribute('aria-label') === 'Mise en marche de l’ampli';
  }));
await demoPage.getByRole('button', { name: 'Tutoriel', exact: true }).click();
await demoPage.locator('.tour-card').waitFor();
check('and in French once French is chosen',
  (await demoPage.locator('#tour-title').innerText()) === 'Réglages généraux'
    && (await demoPage.locator('.tour-card .tour-next').innerText()) === 'Suivant');
// A defined term, in bold: hovered, it rings the control it names on the page.
await demoPage.waitForTimeout(900);
await demoPage.locator('.tour-card .tour-term', { hasText: 'Gate' }).hover();
const ringOnGate = await demoPage.evaluate(() => {
  const ring = document.querySelector('.tour-ring')?.getBoundingClientRect();
  const gate = document.querySelector('.gate-control').getBoundingClientRect();
  return ring !== undefined && ring.left <= gate.left && ring.right >= gate.right && ring.top <= gate.top && ring.bottom >= gate.bottom;
});
check('a term in bold, hovered, rings the control it names', ringOnGate);
await demoPage.keyboard.press('Escape');
await demoPage.getByRole('button', { name: 'Réglages', exact: true }).click();
await demoPage.getByRole('radio', { name: 'English', exact: true }).click();
await demoPage.getByRole('button', { name: 'Done', exact: true }).click();
check('the language chosen in the settings applies and is kept',
  (await demoPage.evaluate(() => [document.documentElement.lang, localStorage.getItem('tonecraft-locale')].join())) === 'en,en');
check('it can be started again from the page, and left with Escape',
  (await demoPage.locator('.tour-card').count()) === 0 || !(await demoPage.locator('.tour-card').isVisible()));
await demoPage.locator('.capture-info[data-capture="loaded"]').waitFor({ state: 'attached', timeout: 40_000 });
// The demo waits behind a button that says what it is.
const demoButton = demoPage.getByRole('button', { name: 'Listen to a demo' });
check('the demo waits behind its own button', await demoButton.isVisible() && (await demoPage.locator('.wave svg').count()) === 0);
check('and a tester has no recorder', (await demoPage.locator('.recorder').count()) === 0);
await demoButton.click();
await demoPage.waitForSelector('.wave svg', { timeout: 40_000 });
await demoPage.waitForTimeout(1500);

check('tester cannot select an input', (await demoPage.locator('.audio-settings, .session-bar, button.chain').count()) === 0);
const asked = await demoPage.evaluate(() => window.__mic);
check('the demo path never asks for a microphone', asked === 0, `${asked} request(s)`);
check('the demo take bypasses stale CDN responses',
  demoRequests.some((url) => url.endsWith('/di/demo-di.wav?v=riff-a-1')),
  demoRequests[0] ?? 'no demo request');
check('and the take is loaded and waiting, not playing at you',
  (await demoPage.locator('.capture-info').getAttribute('data-capture')) === 'loaded' &&
  (await demoPage.locator('.demo-panel button.start').innerText()) === 'Play');
// The chain is what you hear first; turning it off is the deliberate act.
check('and the chain is on by default',
  (await demoPage.locator('button.rocker, button.power-indicator').getAttribute('aria-pressed')) === 'true');
await demoPage.locator('.demo-panel button.start').click();
await demoPage.waitForTimeout(1200);
check('and plays when asked', (await demoPage.locator('.demo-panel button.start').innerText()) === 'Pause');

const demoLevel = await demoPage.evaluate(async () => {
  let peak = 0;
  const until = performance.now() + 8000;
  while (performance.now() < until && peak <= 1) {
    const bar = document.querySelector('.output-control .meter rect:last-child');
    peak = Math.max(peak, Number(bar?.getAttribute('height') ?? 0));
    await new Promise((r) => setTimeout(r, 40));
  }
  return peak;
});
check('and there is sound without anyone plugging anything in', demoLevel > 1,
  `output peak ${demoLevel.toFixed(0)} of 96`);
check('nothing threw on the demo path', demoErrors.length === 0, demoErrors[0]);

/**
 * The way to ASIO. With Tonecraft Engine not running — the case on CI, and
 * the case of everyone who has never heard of it — choosing it in the settings
 * has to say where to get it, and has to offer the way back. On its own page,
 * because the failed loopback connection is logged by Chromium as an error and
 * would otherwise fail "nothing threw" above. A developer with the engine
 * running locally will see this check fail: it is written for its absence.
 */
const nativePage = await browser.newPage({ locale: 'en-US' });
await nativePage.goto(`http://127.0.0.1:${PORT}/app/`, { waitUntil: 'networkidle' });
await nativePage.getByRole('button', { name: 'Musician' }).click();
const engines = nativePage.getByRole('radiogroup', { name: 'Audio engine' }).getByRole('radio');
await engines.nth(1).click();
const download = nativePage.locator('.audio-settings a.download');
let offered = '';
try {
  await download.waitFor({ timeout: 10_000 });
  offered = (await download.getAttribute('href')) ?? '';
} catch { /* reported below */ }
check('choosing the native engine without it running offers the download',
  offered.includes('/releases/'), offered || 'no download link');
await nativePage.getByRole('button', { name: 'Keep playing in the browser' }).click();
check('and the way back to the browser', (await engines.nth(0).getAttribute('aria-checked')) === 'true');

/**
 * And the case that made the engine feel compulsory: a session that remembers
 * ASIO, on a machine where Tonecraft Engine is no longer running — which is
 * every reload after the player quits it. The rig has to come up in the
 * browser and say why, not refuse to start.
 */
await nativePage.evaluate(async () => {
  await new Promise((resolve, reject) => {
    const open = indexedDB.open('tonecraft', 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore('state');
      open.result.createObjectStore('media', { keyPath: 'id' });
    };
    open.onsuccess = () => {
      const tx = open.result.transaction('state', 'readwrite');
      tx.objectStore('state').put({ version: 1, session: { backend: 'native', source: 'live' } }, 'session');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  });
});
await nativePage.reload({ waitUntil: 'networkidle' });
await nativePage.getByRole('button', { name: 'Musician' }).click();
await nativePage.getByRole('button', { name: 'Done', exact: true }).click();
let fellBack = false;
try {
  await nativePage.locator('.latency').waitFor({ timeout: 20_000 });
  fellBack = true;
} catch { /* reported below */ }
check('a remembered ASIO choice does not stop the rig starting without the engine', fellBack,
  fellBack ? '' : (await nativePage.locator('.welcome .failure').innerText().catch(() => 'it refused to start')));
// The take is loaded before the fallback can say anything, so this waits for
// the sentence rather than reading the line the instant the rig comes up.
let said = false;
try {
  await nativePage.locator('.notice', { hasText: 'playing in the browser' }).waitFor({ timeout: 15_000 });
  said = true;
} catch { /* reported below */ }
check('and it says where the sound went', said,
  said ? '' : await nativePage.locator('.notice').innerText());
// The sheet was dismissed by Done; the selector is read where it lives.
await nativePage.getByRole('button', { name: 'Settings' }).first().click();
check('and the engine choice shows what is actually running',
  (await engines.nth(0).getAttribute('aria-checked')) === 'true');

/*
 * An engine older than the newest release is offered the update, explicitly.
 * Both ends are faked: the engine by a routed WebSocket that says hello at
 * 0.1.0, GitHub by a routed release list whose newest engine is 0.1.2.
 */
const updatePage = await browser.newPage({ locale: 'en-US' });
await updatePage.routeWebSocket('ws://127.0.0.1:47800/', (ws) => {
  ws.onMessage((data) => {
    const message = JSON.parse(String(data));
    if (message.type === 'hello') ws.send(JSON.stringify({ type: 'hello', abi: 1, version: '0.1.0', platform: 'windows', hosts: [], chain: false,
      config: { host: null, input: null, output: null, sampleRate: null, bufferSize: null, inputChannels: null, outputChannels: null, monitor: 1 } }));
  });
});
await updatePage.route('https://api.github.com/**', (route) => route.fulfill({
  status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
  body: JSON.stringify([{ tag_name: 'engine-v0.1.2', draft: false, prerelease: false }, { tag_name: 'engine-v0.1.1', draft: false, prerelease: false }]),
}));
await updatePage.goto(`http://127.0.0.1:${PORT}/app/`, { waitUntil: 'networkidle' });
await updatePage.getByRole('button', { name: 'Musician' }).click();
await updatePage.getByRole('radiogroup', { name: 'Audio engine' }).getByRole('radio').nth(1).click();
let updateOffered = false;
try {
  await updatePage.locator('.audio-settings a', { hasText: 'Update Tonecraft Engine' }).waitFor({ timeout: 15_000 });
  updateOffered = true;
} catch { /* reported below */ }
check('an engine older than the newest release is offered the update', updateOffered,
  updateOffered ? '' : await updatePage.locator('.audio-settings').innerText());

/**
 * On a phone, by touch. The card beside the window was the whole screen: it
 * hid what it explained, its buttons scrolled out of reach, and the composing
 * step waited for a key no phone has. Now it is a sheet at the foot of the
 * screen, each window read above it, stepped through by swiping or tapping.
 */
{
  // Alone, last: an engine that fails to start under the load of the pages
  // above brings the welcome sheet back over the tutorial.
  for (const context of browser.contexts()) for (const open of context.pages()) await open.close();
  const phone = await browser.newContext({ ...devices['iPhone 13'], locale: 'en-US' });
  const tap = await phone.newPage();
  const cdp = await phone.newCDPSession(tap);
  const swipeLeft = async () => {
    const h = await tap.locator('.tour-card h2').boundingBox();
    const y = h.y + h.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y }] });
    for (let x = 260; x >= 100; x -= 40) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  await tap.goto(`http://127.0.0.1:${PORT}/app/`, { waitUntil: 'networkidle' });
  await tap.getByRole('button', { name: 'Tester' }).tap();
  const seen = [];
  for (const [step, target] of tourTargets.entries()) {
    if (step === 4) {
      await tap.waitForTimeout(900);
      const folded = await tap.locator('.tour-card.collapsed').count() === 1;
      const write = await tap.locator('.write-tab').boundingBox();
      await tap.touchscreen.tap(write.x + write.width / 2, write.y + write.height / 2);
      await tap.locator('.editor-bar').waitFor({ timeout: 30000 });
      // A fret on the neck, brought above the sheet the way a thumb would.
      await tap.evaluate(() => { const fret = document.querySelectorAll('.reader rect.pick')[30]; scrollBy(0, fret.getBoundingClientRect().top - 120); });
      await tap.waitForTimeout(400);
      const fret = await tap.locator('.reader rect.pick').nth(30).boundingBox();
      await tap.touchscreen.tap(fret.x + fret.width / 2, fret.y + fret.height / 2);
      await tap.waitForFunction(() => !document.querySelector('.tour-card .tour-next').disabled, null, { timeout: 15000 });
      seen.push({ title: 'compose', ok: folded, detail: `starts folded ${folded}` });
    }
    await tap.waitForTimeout(900);
    seen.push(await tap.evaluate((selector) => {
      const card = document.querySelector('.tour-card').getBoundingClientRect();
      const next = document.querySelector('.tour-card .tour-next').getBoundingClientRect();
      const title = document.querySelector('#tour-title').textContent;
      const sheet = Math.abs(card.bottom - innerHeight) < 2 && card.left <= 0 && card.right >= innerWidth;
      const reachable = next.top >= card.top && next.bottom <= innerHeight && next.height >= 44;
      if (selector === null) return { title, ok: sheet && reachable, detail: `sheet ${sheet}, next ${reachable}` };
      const r = document.querySelector(selector).getBoundingClientRect();
      // Some of the window in the part of the screen the sheet leaves free: a tall one is read by scrolling it.
      const visible = r.top < card.top && r.bottom > 0 && (r.top >= 0 || r.bottom - r.top > card.top);
      return { title, ok: sheet && reachable && visible, detail: `sheet ${sheet}, next ${reachable}, window above it ${visible} (${Math.round(r.top)} under ${Math.round(card.top)})` };
    }, target));
    const before = await tap.locator('#tour-title').innerText();
    if (step % 2 === 0 && step < tourTargets.length - 1) {
      await swipeLeft();
      await tap.waitForTimeout(300);
      seen.push({ title: 'swipe', ok: (await tap.locator('#tour-title').innerText()) !== before, detail: 'a swipe to the left is the next step' });
    } else await tap.locator('.tour-card .tour-next').tap();
  }
  check('on a phone the tutorial is a sheet under each window, its buttons in reach, swiped or tapped through, a note written on the neck',
    seen.every((s) => s.ok), seen.filter((s) => !s.ok).map((s) => `${s.title}: ${s.detail}`).join(' · ') || `${seen.length} checks`);
  // The last Done unmounts the tutorial, and what it put on the page is given
  // back as it goes: read before it has gone, the page still carries it.
  await tap.locator('.tour-card').waitFor({ state: 'detached', timeout: 10000 });
  check('and the page is given back as it was', await tap.evaluate(() => document.body.style.paddingBottom === '' && document.querySelectorAll('.tour-lit').length === 0));
  await phone.close();
}

await browser.close();
server.close();

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
