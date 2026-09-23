/** How long a real song takes: to first note, and to the end of the render. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';

const dist = path.resolve('dist');
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.html': 'text/html', '.json': 'application/json', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const rel = decodeURIComponent(url.pathname.slice(1));
  const file = path.resolve(dist, rel.endsWith('/') || !rel ? rel + 'index.html' : rel);
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, locale: 'en-US' });
page.on('pageerror', e => console.log('pageerror:', e.message));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/app/`);
  await page.getByRole('button', { name: 'Musician' }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.locator('.capture-info[data-capture="loaded"]').waitFor({ state: 'attached', timeout: 30000 });
  const file = process.argv[2];
  await page.getByLabel('Open a tab', { exact: true }).setInputFiles({ name: path.basename(file), mimeType: 'application/octet-stream', buffer: fs.readFileSync(file) });
  await page.locator('.score-paper svg').first().waitFor({ timeout: 60000 });
  const started = Date.now();
  await page.getByRole('combobox', { name: 'What plays the tab' }).selectOption('amp');
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === 'Play tablature');
    return b && !b.disabled;
  }, undefined, { timeout: 600000 });
  const playable = (Date.now() - started) / 1000;
  await page.getByRole('button', { name: 'Play tablature', exact: true }).click();
  await page.locator('.amp-bar').waitFor({ state: 'detached', timeout: 1800000 });
  const whole = (Date.now() - started) / 1000;
  const waits = await page.evaluate(() => document.querySelector('.amp-state')?.textContent ?? '');
  console.log(`${path.basename(file)}: playable after ${playable.toFixed(1)} s, rendered in ${(whole / 60).toFixed(1)} min${waits ? ` (${waits.trim()})` : ''}`);
  const heap = await page.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : -1);
  console.log(`  JS heap: ${heap} MB (audio buffers live outside it)`);
} finally { await browser.close(); server.close(); }
