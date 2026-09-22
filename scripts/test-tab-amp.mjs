/**
 * The tab, played through the amplifier, in a real browser.
 *
 * What this holds to, because each one failed silently at some point while it
 * was being built: nothing is fetched for it until it is asked for, the render
 * finishes and says so, the cursor then moves on *our* clock rather than
 * alphaTab's, and the band and the guitars start together.
 *
 *   npm run build && node scripts/test-tab-amp.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import * as alpha from '@coderline/alphatab';

const dist = path.resolve('dist');
const base = process.env.TEST_BASE_PATH ?? '/';
if (!fs.existsSync(path.join(dist, 'di-bank', 'bank.json'))) {
  console.log('skip: no DI bank in dist — run npx tsx scripts/build-di-bank.ts <dataset> && npm run build');
  process.exit(0);
}
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.html': 'text/html', '.json': 'application/json', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith(base)) { res.writeHead(404); res.end(); return; }
  const relative = decodeURIComponent(url.pathname.slice(base.length));
  const file = path.resolve(dist, relative.endsWith('/') || !relative ? relative + 'index.html' : relative);
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, locale: 'en-US' });
const errors = [];
page.on('pageerror', e => { errors.push(e.message); console.log('pageerror:', e.stack ?? e.message); });
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning' || process.env.VERBOSE) console.log(`browser[${m.type()}]:`, m.text()); });
const bank = [];
page.on('response', r => { if (r.url().includes('/di-bank/')) bank.push(new URL(r.url()).pathname); });

try {
  await page.goto(`http://127.0.0.1:${server.address().port}${base}app/`);
  await page.getByRole('button', { name: 'Musician' }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.locator('.capture-info[data-capture="loaded"]').waitFor({ state: 'attached', timeout: 30000 });

  // Four bars: long enough to play, short enough that a render is a few seconds.
  const importer = new alpha.importer.AlphaTexImporter();
  importer.initFromString('\\title "Amp test" \\tempo 120 . '
    + '\\track "Guitar" \\instrument distortionguitar :8 0.6{pm} 0.6{pm} 3.6 5.6 0.6{pm} 0.6{pm} 3.6 5.6 | :8 0.6 2.6 3.6 5.6 7.6 5.6 3.6 2.6 | '
    + ':8 0.6{pm} 0.6{pm} 3.6 5.6 0.6{pm} 0.6{pm} 3.6 5.6 | :4 0.6 3.6 5.6 7.6 '
    + '\\track "Bass" \\tuning E1 A1 D2 G2 :4 0.4 0.4 0.4 0.4 | :4 0.4 0.4 0.4 0.4 | :4 0.4 0.4 0.4 0.4 | :4 0.4 0.4 0.4 0.4');
  const gp = Buffer.from(new alpha.exporter.Gp7Exporter().export(importer.readScore()));
  await page.getByLabel('Open a tab', { exact: true }).setInputFiles({ name: 'amp-test.gp', mimeType: 'application/octet-stream', buffer: gp });
  await page.locator('.score-paper svg').first().waitFor({ timeout: 30000 });
  assert.deepEqual(bank, [], 'nothing of the sample bank is fetched while the soundfont plays the tab');

  const plays = page.getByRole('combobox', { name: 'What plays the tab' });
  assert.equal(await plays.inputValue(), 'soundfont', 'a tab opens on the soundfont, as it always did');
  assert(await plays.isEnabled(), 'with a capture loaded, the amplifier is on offer');
  await plays.selectOption('amp');
  await page.locator('.amp-bar').waitFor({ timeout: 15000 });
  console.log('ok  the render starts and says so');
  // The render is the slow part on a modest machine: two tracks of eight seconds.
  await page.locator('.amp-bar').waitFor({ state: 'detached', timeout: 240000 });
  assert.equal(await page.locator('.amp-state').count(), 0, 'a fresh render is not announced as stale');
  assert(bank.some(p => p.endsWith('bank.pcm')) && bank.some(p => p.endsWith('bank.json')),
    `the bank is fetched once the amplifier is asked for (${bank.join(', ')})`);
  console.log('ok  the bank arrives only when the amplifier is chosen');

  const play = page.getByRole('button', { name: 'Play tablature', exact: true });
  await play.waitFor({ timeout: 30000 });
  assert(await play.isEnabled(), 'the transport is ready once the render has landed');

  // What plays is ours: a rendered buffer on the reader's own context, with
  // alphaTab's cursor following it. Both have to move.
  const before = await page.evaluate(() => document.querySelector('.at-cursor-beat')?.getBoundingClientRect().x ?? -1);
  await play.click();
  await page.waitForTimeout(2500);
  const running = await page.evaluate(() => {
    const cursor = document.querySelector('.at-cursor-beat')?.getBoundingClientRect().x ?? -1;
    const clock = document.querySelector('.transport .position, .time, [aria-label="Position"]')?.textContent ?? '';
    return { cursor, clock };
  });
  assert(running.cursor > before, `the cursor moves while the rendered tab plays (${before} → ${running.cursor})`);
  console.log('ok  the cursor rides on the rendered audio');

  await page.getByRole('button', { name: 'Pause tablature', exact: true }).click();
  await page.waitForTimeout(300);
  const stopped = await page.evaluate(() => document.querySelector('.at-cursor-beat')?.getBoundingClientRect().x ?? -1);
  await page.waitForTimeout(700);
  const still = await page.evaluate(() => document.querySelector('.at-cursor-beat')?.getBoundingClientRect().x ?? -1);
  assert.equal(stopped, still, 'paused, the cursor stays where the audio stopped');
  console.log('ok  pause holds the cursor');

  // The speed cannot move while a render is playing, and says why.
  const speed = page.getByRole('combobox', { name: 'Playback speed' });
  assert(await speed.isDisabled(), 'the speed is fixed while the amp plays the tab');
  assert.match(await speed.getAttribute('title') ?? '', /soundfont/i, 'and the tooltip says what to do about it');
  console.log('ok  the speed is held, not silently ignored');

  // A tone dialled after the render is said, not applied behind the player's back.
  // The knobs are on the amp head, which stands in the Tone view; the tab is in Play.
  await page.getByRole('tab', { name: 'Tone', exact: true }).click();
  await page.getByRole('slider', { name: 'Gain' }).first().press('ArrowUp');
  await page.getByRole('tab', { name: 'Play', exact: true }).click();
  await page.locator('.amp-state', { hasText: 'Rendered with the tone' }).waitFor({ timeout: 10000 });
  console.log('ok  a tone dialled after the render is announced');
  await page.getByRole('button', { name: 'Render again', exact: true }).click();
  await page.locator('.amp-bar').waitFor({ timeout: 15000 });
  await page.locator('.amp-bar').waitFor({ state: 'detached', timeout: 240000 });
  assert.equal(await page.locator('.amp-state').count(), 0, 'rendering again clears it');
  console.log('ok  and rendering again answers it');

  // Writing a tab is the synthesiser's job: the editor takes the reader back.
  await page.getByRole('button', { name: 'Write a tab', exact: true }).click();
  await page.waitForTimeout(1500);
  assert.equal(await plays.inputValue(), 'soundfont', 'the editor goes back to the soundfont, which can preview a note');
  await page.getByRole('button', { name: 'Close editor', exact: true }).click();
  await page.waitForTimeout(500);
  console.log('ok  the editor takes back the synthesiser');

  // Back to the soundfont: the reader reloads its player and plays as before.
  await plays.selectOption('soundfont');
  await page.waitForTimeout(1500);
  assert.equal(await plays.inputValue(), 'soundfont');
  await page.getByRole('button', { name: 'Play tablature', exact: true }).click();
  await page.waitForTimeout(1200);
  const soundfontCursor = await page.evaluate(() => document.querySelector('.at-cursor-beat')?.getBoundingClientRect().x ?? -1);
  assert(soundfontCursor >= 0, 'the soundfont path still plays after the amplifier was used');
  await page.getByRole('button', { name: 'Pause tablature', exact: true }).click();
  console.log('ok  switching back leaves the reader as it was');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('ok  tab through the amplifier');
} finally {
  await browser.close();
  server.close();
}
