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

   **It refuses to report unless the render is actually real-time.** A headless
   browser with no audio device renders through a null sink, which pulls when it
   feels like it rather than on a deadline — so there is no deadline to miss and
   the count is a comforting zero that means nothing. The probe therefore checks
   its own block rate against `sampleRate / 128` first, and says it cannot
   measure rather than reporting a zero it did not earn. Run it against a
   machine with a real output device, headed:

       npm run measure:load -- --headed

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
const SECONDS = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 20);

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

const HEADED = process.argv.includes('--headed');
const browser = await chromium.launch({
  headless: !HEADED,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
         '--autoplay-policy=no-user-gesture-required',
         /* Headless Chromium renders into a null sink, which is not clocked at
            real time. Naming the real device steadies the rate but does not fix
            it — on this machine it went from 282/328 to a flat 300 quanta a
            second where real time is 375 — so the guard below still fires. It
            is here because on a headed run it is the right device to use. */
         '--alsa-output-device=default'],
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

console.log(`\nDeadline misses on the audio thread — the demo take, ${SECONDS} s each way\n`);
console.log(`  ${info.sampleRate} Hz, round trip ` +
  `${((info.base + info.output) * 1000).toFixed(1)} ms ` +
  `(base ${(info.base * 1000).toFixed(1)} + output ${(info.output * 1000).toFixed(1)})\n`);

/* Real-time or nothing. A graph that rendered 6 358 quanta in 30 seconds is
   being pulled by a null sink at its own pace, not by a sound card on a clock,
   and a miss count taken from it says nothing about anyone's laptop. */
const expected = info.sampleRate / 128;
const realtime = (r) => Math.abs(r.blocks / SECONDS - expected) / expected < 0.05;

if (!realtime(chainOn) || !realtime(chainOff)) {
  const rate = (r) => (r.blocks / SECONDS).toFixed(0);
  console.log(`  Not measurable here. The graph rendered ${rate(chainOn)} and ${rate(chainOff)}`);
  console.log(`  quanta a second where real time is ${expected.toFixed(0)}: there is no audio`);
  console.log('  device, so the sink pulls at its own pace and nothing has a deadline to miss.');
  console.log('  Run it headed, on a machine with an output device:\n');
  console.log('      npm run measure:load -- --headed\n');
  process.exit(0);
}

const line = (label, r) => {
  const perMinute = (r.gaps / SECONDS) * 60;
  console.log(`  ${label.padEnd(16)} ${String(r.gaps).padStart(5)} misses in ${r.blocks} blocks` +
    `   ${perMinute.toFixed(1).padStart(7)} / minute` +
    (r.gaps ? `   worst ${r.worst.toFixed(1)} quanta` : ''));
};
line('chain running', chainOn);
line('chain off', chainOff);
console.log('\n  The difference is the chain. The rest is the machine.\n');
