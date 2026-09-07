/* =============================================================================
   scripts/measure-load.mjs — does the chain hold, in a real browser
   -----------------------------------------------------------------------------
   `npm run bench:model` measures the amp alone, in Node. This measures whether
   the whole graph keeps its deadline on the audio thread — the two convolvers,
   the five biquads, the limiter's 4x oversampling and the three worklets
   included, none of which Node can see.

   **The metric is not the millisecond, it is the miss.** A constant 20 ms of
   latency is forgotten in a minute; a block that does not finish in time is a
   crackle, and a crackle is never forgotten. So a probe worklet is spliced into
   the running AudioContext and counts render quanta: `currentTime` advances by
   exactly one quantum per call while the thread keeps up, and any larger step
   is a block the graph did not render in time.

   It is measured twice — chain running, then chain switched off — because the
   absolute number belongs to the machine and the browser, and only the
   difference between the two belongs to the chain.

   The probe is our own, not the product's output meter: an instrument that
   shares code with what it measures reports zero for the same reason twice.

   Prerequisites:
       npm run build
       npx playwright install chromium

   Usage:  npm run measure:load [seconds]
   ========================================================================== */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PORT = 8138;
const SECONDS = Number(process.argv[2] ?? 20);

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.tcnm': 'application/octet-stream', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.wav': 'audio/wav', '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let file = path.join(DIST, url === '/' ? 'index.html' : url);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
         '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();

/* The engine keeps its AudioContext private, which is right. Rather than open
   it up for a measurement, the context is caught as it is constructed. */
await page.addInitScript(() => {
  const Real = window.AudioContext;
  window.AudioContext = class extends Real {
    constructor(...args) { super(...args); window.__ctx = this; }
  };
});

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
await page.locator('.choice', { hasText: 'Just let me hear it' }).click();
await page.waitForSelector('.wave svg', { timeout: 40_000 });
await page.locator('.transport button.start').click();
await page.waitForTimeout(2000);            // settle: the model prewarms on load

/* Install the probe once; it stays for both passes. */
const installed = await page.evaluate(async () => {
  const ctx = window.__ctx;
  if (!ctx) return 'no AudioContext was constructed';
  const source = `
    class Probe extends AudioWorkletProcessor {
      constructor() {
        super();
        this.last = -1;
        this.quantum = 128 / sampleRate;
        this.gaps = 0;
        this.worst = 0;
        this.blocks = 0;
        this.port.onmessage = () => {
          this.port.postMessage({ gaps: this.gaps, worst: this.worst, blocks: this.blocks });
          this.gaps = 0; this.worst = 0; this.blocks = 0;
        };
      }
      process() {
        if (this.last >= 0) {
          const step = currentTime - this.last;
          // Half a quantum of slack absorbs float jitter in currentTime.
          if (step > this.quantum * 1.5) {
            this.gaps++;
            const missed = step / this.quantum - 1;
            if (missed > this.worst) this.worst = missed;
          }
        }
        this.last = currentTime;
        this.blocks++;
        return true;
      }
    }
    registerProcessor('probe', Probe);`;
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  await ctx.audioWorklet.addModule(url);
  const node = new AudioWorkletNode(ctx, 'probe', { numberOfInputs: 0, numberOfOutputs: 1 });
  const mute = new GainNode(ctx, { gain: 0 });
  node.connect(mute).connect(ctx.destination);
  window.__probe = node;
  return null;
});
if (installed) { console.error(installed); await browser.close(); server.close(); process.exit(1); }

const sample = (seconds) => page.evaluate(async (s) => {
  const node = window.__probe;
  const read = () => new Promise((r) => { node.port.onmessage = (e) => r(e.data); node.port.postMessage(0); });
  await read();                              // discard whatever accumulated
  await new Promise((r) => setTimeout(r, s * 1000));
  return read();
}, seconds);

const chainOn = await sample(SECONDS);
await page.locator('button.chain').click();  // the amp out of the path
await page.waitForTimeout(1000);
const chainOff = await sample(SECONDS);

const info = await page.evaluate(() => ({
  sampleRate: window.__ctx.sampleRate,
  base: window.__ctx.baseLatency,
  output: window.__ctx.outputLatency,
}));

await browser.close();
server.close();

const line = (label, r) => {
  const perMinute = (r.gaps / SECONDS) * 60;
  console.log(`  ${label.padEnd(16)} ${String(r.gaps).padStart(5)} misses in ${r.blocks} blocks` +
    `   ${perMinute.toFixed(1).padStart(7)} / minute` +
    (r.gaps ? `   worst ${r.worst.toFixed(1)} quanta` : ''));
};

console.log(`\nDeadline misses on the audio thread — the demo take, ${SECONDS} s each way\n`);
console.log(`  ${info.sampleRate} Hz, round trip ` +
  `${((info.base + info.output) * 1000).toFixed(1)} ms ` +
  `(base ${(info.base * 1000).toFixed(1)} + output ${(info.output * 1000).toFixed(1)})\n`);
line('chain running', chainOn);
line('chain off', chainOff);
console.log('\n  The difference is the chain. The rest is the machine.\n');
