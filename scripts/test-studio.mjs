import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import * as alpha from '@coderline/alphatab';

const dist = path.resolve('dist');
const base = process.env.TEST_BASE_PATH ?? '/';
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'tonecraft-studio-'));
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.html': 'text/html', '.json': 'application/json', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith(base)) { res.writeHead(404); res.end(); return; }
  const relative = decodeURIComponent(url.pathname.slice(base.length));
  const file = path.resolve(dist, relative || 'index.html');
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
// Printed as it happens: the final assertion only says an error was thrown,
// never which step threw it.
page.on('pageerror', e => { errors.push(e.message); console.log('pageerror:', e.stack ?? e.message); });
page.on('console', m => { if (m.type() === 'error') console.log('browser:', m.text()); });
try {
  await page.goto(`http://127.0.0.1:${server.address().port}${base}`);
  await page.getByRole('button', { name: 'Musicien' }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.locator('.capture-info[data-capture="loaded"]').waitFor({ state: 'attached', timeout: 30000 });
  await page.getByRole('button', { name: '● Record', exact: true }).click();
  await page.getByRole('button', { name: '■ Stop recording', exact: true }).waitFor();
  await page.waitForTimeout(3000); // capture a real fake-device stream
  await page.getByRole('button', { name: '■ Stop recording', exact: true }).click();
  await page.getByText('Take saved on this device.').waitFor();
  await page.getByRole('button', { name: 'Amplifier power', exact: true }).click();
  const download = async name => {
    const pending = page.waitForEvent('download', { timeout: 60000 });
    await page.getByRole('button', { name, exact: true }).click();
    const result = await pending;
    const target = path.join(artifacts, result.suggestedFilename());
    await result.saveAs(target);
    return fs.readFileSync(target);
  };
  const dry = await download('Export DI · WAV');
  assert.equal(dry.toString('ascii', 0, 4), 'RIFF');
  assert(dry.length > 100000);
  await page.getByRole('button', { name: 'Amplifier power', exact: true }).click();
  const wet = await download('Export amp · WAV');
  assert.notDeepEqual(dry, wet);
  console.log('ok live recording, persistent DI, dry and processed WAV downloads');

  const importer = new alpha.importer.AlphaTexImporter();
  // Long enough to lay out several systems, so the scroll has somewhere to go.
  // The third track enters only in the last bar: that is the case a reader
  // makes look broken, because selecting it plays the band and not it.
  const repeat = (pattern, n) => Array.from({ length: n }, () => pattern).join(' | ');
  importer.initFromString('\\title "Practice riff" \\tempo 120 . '
    + `\\track "Guitar" ${repeat(':4 0.6 2.6 3.6 5.6', 40)} `
    + `\\track "Bass" \\tuning E2 A2 D3 G3 ${repeat(':4 0.4 2.4 3.4 5.4', 40)} `
    + `\\track "Late Solo" ${repeat(':4 r r r r', 39)} | :4 12.1 10.1 8.1 7.1`);
  const score = importer.readScore();
  const gp = Buffer.from(new alpha.exporter.Gp7Exporter().export(score));
  const picker = page.getByLabel('Import tablature', { exact: true });
  await page.locator('.reader').scrollIntoViewIfNeeded();
  await picker.setInputFiles({ name: 'practice.gp', mimeType: 'application/octet-stream', buffer: gp });
  await page.locator('.score-paper svg').first().waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: /^02 Bass/ }).click();
  assert.equal(await page.getByRole('button', { name: /^02 Bass/ }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: 'Solo', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Solo', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: /^01 Guitar/ }).click();
  assert.equal(await page.getByRole('button', { name: 'Solo', exact: true }).getAttribute('aria-pressed'), 'false');
  await page.getByRole('button', { name: 'Play tablature', exact: true }).click({ timeout: 30000 });
  await page.getByRole('button', { name: 'Pause tablature', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.clock').textContent.startsWith('0:00'), { timeout: 10000 });
  await page.getByRole('button', { name: 'Pause tablature', exact: true }).click();
  await page.getByRole('combobox', { name: 'Playback speed', exact: true }).selectOption('70');
  await page.getByRole('button', { name: '↻ Loop song', exact: true }).click();
  await page.getByRole('combobox', { name: 'Notation view', exact: true }).selectOption('both');
  await page.getByRole('button', { name: 'Focus view', exact: true }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(artifacts, 'tab-reader-desktop.png') });
  await page.getByRole('button', { name: 'Exit focus', exact: true }).click();
  console.log('ok Guitar Pro import, tracks, solo, notation, playback, speed, loop and focus view');

  // Where a track plays, and getting there. A track that enters late is not a
  // broken track, but nothing said so until the count and the jump existed.
  const late = page.getByRole('button', { name: /^03 Late Solo/ });
  assert.equal((await late.innerText()).trim().split(/\s+/).pop(), '1', 'the track list counts the bars a track plays in');
  await late.click();
  await page.getByText('Plays bars 40\u201340, 1 of 40.').waitFor();
  await page.getByRole('button', { name: 'Stop tablature', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.clock').textContent.startsWith('0:00'), { timeout: 10000 });
  await page.getByRole('button', { name: 'Go to its first bar', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.clock').textContent.startsWith('0:00'), { timeout: 10000 });
  await page.getByLabel('Playback position').fill('0');
  await page.waitForFunction(() => document.querySelector('.clock').textContent.startsWith('0:00'), { timeout: 10000 });
  console.log('ok per-track bar counts, the jump to a track\u2019s first bar and the position slider');

  // Clicking the score seeks, it focuses nothing, and space used to scroll the
  // page instead of playing. The reader takes the keys on any click of its own.
  // On the notation itself, which is SVG: a guard for HTMLElement let every
  // click on a score through without ever taking the focus.
  await page.locator('.score-paper svg').first().click({ position: { x: 30, y: 30 } });
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Pause tablature', exact: true }).waitFor({ timeout: 10000 });
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Play tablature', exact: true }).waitFor({ timeout: 10000 });
  assert.equal(await page.evaluate(() => window.scrollY), scrollBefore, 'space must not scroll the page');
  console.log('ok space plays and pauses once the reader has been clicked');

  // One line, sliding under a playhead that stays in the middle of the window.
  // alphaTab's own handler for this layout parks the cursor on the left edge.
  await page.getByLabel('Playback position').fill('40000');
  // The button, not the space bar: fill() leaves the focus on the slider.
  await page.getByRole('button', { name: 'Play tablature', exact: true }).click();
  await page.getByRole('button', { name: 'Pause tablature', exact: true }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(2500);
  const read = () => page.evaluate(() => {
    const el = document.querySelector('.score-viewport');
    const view = el.getBoundingClientRect();
    const cursor = document.querySelector('.at-cursor-beat')?.getBoundingClientRect();
    return { off: cursor ? Math.round(cursor.left + cursor.width / 2 - view.left - view.width / 2) : null, scrolled: Math.round(el.scrollLeft), down: Math.round(el.scrollTop), height: el.scrollHeight - el.clientHeight };
  });
  const centred = await read();
  assert(centred.scrolled > 0, 'the score has slid under the playhead');
  assert(Math.abs(centred.off) < 40, `the playhead stays in the middle of the window (off by ${centred.off}px)`);
  assert.equal(centred.height, 0, 'one line: there is nothing to scroll vertically');
  // Smoothly: the scroll is animated over the cursor's own transition, so it
  // moves between beats rather than jumping from one bar to the next.
  await page.waitForTimeout(400);
  const later = await read();
  assert(later.scrolled > centred.scrolled, 'the score keeps sliding');
  assert(Math.abs(later.off) < 40, `and the playhead stays put (off by ${later.off}px)`);
  await page.getByRole('button', { name: 'Pause tablature', exact: true }).click();
  console.log('ok the score slides horizontally under a centred playhead');

  // The neck under the tab is the track's own: a four-string bass draws four.
  assert.equal(await page.locator('.neck .fret').count(), 24);
  assert.equal(await page.locator('.neck .string').count(), 6);
  await page.getByRole('button', { name: /^02 Bass/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.neck .string').length === 4, { timeout: 10000 });
  await page.getByRole('button', { name: /^01 Guitar/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.neck .string').length === 6, { timeout: 10000 });
  // It lights where the note is, and the light leaves for the next one.
  await page.getByRole('button', { name: 'Play tablature', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.neck .core').length > 0, { timeout: 15000 });
  const first = await page.locator('.neck .core').first().getAttribute('cx');
  await page.waitForFunction(was => {
    const dot = document.querySelector('.neck .core');
    return dot !== null && dot.getAttribute('cx') !== was;
  }, first, { timeout: 15000 });
  await page.getByRole('button', { name: 'Pause tablature', exact: true }).click();
  console.log('ok the neck matches the track and lights the note being played');

  // The accepted extensions must be the ones the loader actually reads.
  // alphaTex is the entry furthest from Guitar Pro on that list.
  await picker.setInputFiles({ name: 'riff.atex', mimeType: 'text/plain',
    buffer: Buffer.from('\\title "Alpha riff" \\tempo 100 . :4 0.6 2.6 3.6 5.6') });
  // The laid-out score, not the caption: the caption changes before the layout,
  // and the horizontal layout does not draw the title at all. One bar is a
  // fraction of the width the forty-bar score left behind.
  await page.waitForFunction(() => document.querySelectorAll('.tracks button').length === 1
    && document.querySelectorAll('.score-paper svg').length > 0
    && document.querySelector('.score-paper').scrollWidth < 2000, { timeout: 30000 });
  // Opening a score sets the metronome to its tempo, and shows it doing so.
  await page.waitForFunction(() => document.querySelector('.metronome input[type=number]')?.value === '100', { timeout: 10000 });
  await page.locator('.metronome-launch .metronome-glow').waitFor({ state: 'attached', timeout: 5000 });
  console.log('ok alphaTex import sets the metronome to the score tempo');
  if (process.env.GPX_FIXTURE) {
    await picker.setInputFiles(process.env.GPX_FIXTURE);
    await page.waitForFunction(() => !document.querySelector('.reader-heading .primary').disabled);
    assert.equal(await page.locator('.reader .error').count(), 0);
    await page.locator('.score-paper svg').first().waitFor();
    console.log('ok real GPX import');
  }
  await picker.setInputFiles({ name: 'broken.gpx', mimeType: 'application/octet-stream', buffer: Buffer.from('not a score') });
  await page.locator('.reader .error').waitFor();
  assert(await page.locator('.score-paper svg').count() > 0, 'A bad import must preserve the current score');
  await page.reload();
  await page.getByRole('button', { name: 'Explorer d’abord' }).click();
  await page.getByRole('button', { name: 'Play tablature', exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await page.locator('.recorder polyline').count(), 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.reader').scrollIntoViewIfNeeded();
  await page.locator('.score-paper svg').first().waitFor();
  await page.waitForTimeout(500); // allow the responsive score worker to finish its layout
  await page.screenshot({ path: path.join(artifacts, 'tab-reader-mobile.png') });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal page overflow on mobile');
  assert.deepEqual(errors, []);
  console.log(`ok malformed import recovery, score/recording restoration, mobile layout\nArtifacts: ${artifacts}`);
} catch (e) {
  await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true });
  console.error('Reader:', await page.locator('.reader').innerText());
  console.error('Recorder:', await page.locator('.recorder').innerText());
  console.error('Browser errors:', errors, 'Artifacts:', artifacts);
  throw e;
} finally { await browser.close(); server.close(); }
