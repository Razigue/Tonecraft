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
  // The third track enters only in the last bar: that is the case a reader
  // makes look broken, because selecting it plays the band and not it.
  importer.initFromString('\\title "Practice riff" \\tempo 120 . \\track "Guitar" :4 0.6 2.6 3.6 5.6 | 7.6 5.6 3.6 2.6 \\track "Bass" \\tuning E2 A2 D3 G3 :4 0.4 2.4 3.4 5.4 | 7.4 5.4 3.4 2.4 \\track "Late Solo" :4 r r r r | 12.1 10.1 8.1 7.1');
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
  await page.getByText('Plays bars 2\u20132, 1 of 2.').waitFor();
  await page.getByRole('button', { name: 'Stop tablature', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.clock').textContent.startsWith('0:00'), { timeout: 10000 });
  await page.getByRole('button', { name: 'Go to its first bar', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.clock').textContent.startsWith('0:00'), { timeout: 10000 });
  await page.getByLabel('Playback position').fill('0');
  await page.waitForFunction(() => document.querySelector('.clock').textContent.startsWith('0:00'), { timeout: 10000 });
  console.log('ok per-track bar counts, the jump to a track\u2019s first bar and the position slider');

  // The accepted extensions must be the ones the loader actually reads.
  // alphaTex is the entry furthest from Guitar Pro on that list.
  await picker.setInputFiles({ name: 'riff.atex', mimeType: 'text/plain',
    buffer: Buffer.from('\\title "Alpha riff" \\tempo 100 . :4 0.6 2.6 3.6 5.6') });
  // The rendered score, not the caption: the caption changes before the layout.
  await page.waitForFunction(() => document.querySelector('.score-paper')?.textContent?.includes('Alpha riff'), { timeout: 30000 });
  console.log('ok alphaTex import');
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
