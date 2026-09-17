/**
 * The home pages show the studio as it is, not a mock-up of it: this takes the
 * screenshots they use from the built site, on the musician path with
 * Chromium's fake input — its tone is what lights the stained glass —
 * and writes them to site/assets/landing/, where astro:assets turns them into
 * AVIF and WebP at build time. Re-run it when the studio changes:
 *
 *   npx astro build && node scripts/landing-shots.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';

const dist = path.resolve('dist');
const out = path.resolve('site/assets/landing');
fs.mkdirSync(out, { recursive: true });

const mime = { '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.html': 'text/html', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.nam': 'application/octet-stream' };
const server = http.createServer((req, res) => {
  const relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).slice(1);
  let file = path.resolve(dist, relative);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!file.startsWith(dist) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// A short riff for the tab reader, so its screenshot shows a score rather than
// an empty drop zone. Written here: the repository carries no tablature.
const riff = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tonecraft-shots-')), 'study-in-e.alphatex');
fs.writeFileSync(riff, [
  '\\title "Study in E"',
  '\\tempo 132',
  '.',
  ':8 0.6 0.6 7.5 0.6 0.6 8.5 0.6 7.5 | 0.6 0.6 10.5 0.6 9.5 0.6 7.5 5.5 |',
  ':8 0.6 0.6 7.5 0.6 0.6 8.5 0.6 7.5 | :4 (0.6 2.5 2.4) (0.6 2.5 2.4) :2 (0.6 2.5 2.4) |',
  ':16 12.1 15.1 12.1 15.2 12.2 14.3 12.3 14.3 :8 12.2 15.1 :4 17.1 |',
  ':8 14.3 12.3 14.4 12.4 14.5 12.5 :4 14.6 |',
].join('\n'));

const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, locale: 'en-US' });
page.on('pageerror', (e) => console.log('pageerror:', e.message));

const shot = async (name, locator) => {
  await locator.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await locator.screenshot({ path: path.join(out, `${name}.png`), animations: 'disabled' });
  console.log(`  ${name}.png`);
};

try {
  await page.goto(`${origin}/app/?lang=en`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Musician' }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.locator('.capture-info[data-capture="loaded"]').waitFor({ state: 'attached', timeout: 60000 });
  if (await page.locator('.amp-head.illuminated').count() === 0) await page.getByRole('button', { name: 'Amplifier power' }).click();
  await page.locator('.amp-head.illuminated').waitFor({ timeout: 15000 });
  await page.waitForTimeout(2500);

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(out, 'overview.png'), animations: 'disabled' });
  console.log('  overview.png');
  await shot('amp', page.locator('.amp-head'));
  await shot('controls', page.locator('.global-controls'));
  await shot('panel', page.locator('.amp-panel'));
  await shot('session', page.locator('.session-bar'));
  // A take, so the recorder shows a waveform rather than its empty state.
  await page.getByRole('button', { name: '● Record', exact: true }).click();
  await page.waitForTimeout(4000);
  await page.getByRole('button', { name: '■ Stop recording', exact: true }).click();
  await page.getByRole('button', { name: '● New take', exact: true }).waitFor({ timeout: 20000 });
  await shot('recorder', page.locator('.recorder'));

  await page.locator('.reader input[type="file"]').setInputFiles(riff);
  await page.locator('.reader svg').first().waitFor({ timeout: 30000 });
  // The riff is in E minor: the neck shows where it lives.
  await page.getByRole('combobox', { name: 'Scale key', exact: true }).selectOption({ label: 'E' });
  await page.getByRole('combobox', { name: 'Scale', exact: true }).selectOption({ label: 'Minor pentatonic' });
  await page.waitForTimeout(1500);
  await shot('tabs', page.locator('.reader'));

  await page.getByRole('button', { name: 'Open tuner' }).click();
  // The fake device's tone needs a moment to be read: a tuner showing a note, not a dash.
  await page.locator('dialog.tuner .note-wrap.heard').waitFor({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  await shot('tuner', page.locator('dialog.tuner'));
  await page.getByRole('button', { name: 'Close tuner' }).click();
  await page.getByRole('button', { name: 'Open metronome' }).click();
  await shot('metronome', page.locator('dialog.metronome'));
  await page.getByRole('button', { name: 'Close metronome' }).click();

  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await shot('engine', settings);
} finally {
  await browser.close();
  server.close();
}
