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
// 1200 tall, not 1000: the head's glass gives way to the transport below a
// certain window height (AmpHead.svelte), and at 1000 the amp on the home page
// was a squashed version of itself. At 1200 it stands at its full size, which
// is what the page is showing.
const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 2, locale: 'en-US' });
page.on('pageerror', (e) => console.log('pageerror:', e.message));

/**
 * The studio is a lit room: the nave is behind everything and the panels are
 * 85 % opaque over it, with the cabinet's corner cut off each of their four
 * corners. An element screenshot takes whatever is painted inside that
 * element's box, so a band cut out of the studio used to arrive on the home
 * page with a blurred cathedral inside it and a slice of one in every corner —
 * a second background, inside a page that has its own.
 *
 * So the room is taken away for the length of a shot, the panels are made
 * opaque, and the shot is taken with `omitBackground`: what comes out is the
 * module alone on transparency, which the page then sets on its own surface.
 * The amplifier comes out cut to its own silhouette, cable included.
 *
 * The one exception is the overview, which is the whole window and is supposed
 * to show the room; it is taken with `page.screenshot` and never passes here.
 */
const CUT = `
  .page::before, .room-light { display: none !important; }
  html, body, astro-island, .page, .stage, .amp-frame, .amp-stand, .tab-stage, .scene {
    background: transparent !important;
  }
  :root, [data-amp='guilt'] { --panel-alpha: 1; }
  .tc-panel, .tc-dialog, .tc-popover {
    -webkit-backdrop-filter: none !important;
    backdrop-filter: none !important;
  }
  dialog::backdrop { background: transparent !important; -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }
  [data-shot-hide] { visibility: hidden !important; }
  [data-shot-bare] { background: none !important; box-shadow: none !important; border-color: transparent !important; }
`;

/**
 * Hides everything the shot is not, and returns the undo.
 *
 * A module's own corners are cut off — the panels take the cabinet's 18 px —
 * and a dialog's are rounded too, so whatever is behind shows through them: a
 * slice of the amplifier's ivory plate in each corner of the tuner, a slice of
 * the chain band in each corner of the pedals. Cutting the room away is not
 * enough on its own; the studio has to go with it.
 *
 * What goes is everything beside the element, at every level: its siblings,
 * its parent's siblings, and so on. That leaves its ancestors, which is what a
 * band cut from the transport wants — it is photographed on the plate it
 * belongs to. A dialog or a popover belongs to no plate, it floats over the
 * lot, so for those the ancestors are stripped of their own paint as well.
 *
 * Not `visibility: hidden` on the page with the dialog put back: the dialog is
 * in the top layer, and Chromium then paints neither.
 */
const isolate = (locator) => locator.evaluate((el) => {
  const floating = el.matches('dialog, [popover]');
  for (let node = el; node && node !== document.body; node = node.parentElement) {
    for (const sibling of node.parentElement?.children ?? []) {
      if (sibling !== node) sibling.setAttribute('data-shot-hide', '');
    }
    if (floating && node !== el) node.setAttribute('data-shot-bare', '');
  }
  // An open popover paints nothing at all under `omitBackground` in Chromium —
  // a `<dialog>` does, a popover does not — and the shot comes back empty. So
  // it is taken out of the top layer for the length of the shot and pinned
  // where it stood: everything a popover's own styles key on `:popover-open`
  // stops matching the moment the attribute goes, which for `.tc-popover` is
  // its opacity and for `.pedals` its whole layout, so the box it had is
  // measured first and written back as inline style.
  if (el.hasAttribute('popover')) {
    const box = el.getBoundingClientRect();
    const display = getComputedStyle(el).display;
    el.dataset.shotStyle = el.getAttribute('style') ?? '';
    el.dataset.shotPopover = el.getAttribute('popover') || 'auto';
    el.removeAttribute('popover');
    Object.assign(el.style, {
      display,
      position: 'fixed',
      top: `${box.top}px`,
      left: `${box.left}px`,
      margin: '0',
      translate: 'none',
      transform: 'none',
      opacity: '1',
    });
  }
  el.setAttribute('data-shot', '');
});

const restore = () => page.evaluate(() => {
  for (const node of document.querySelectorAll('[data-shot-popover]')) {
    const style = node.dataset.shotStyle;
    if (style) node.setAttribute('style', style); else node.removeAttribute('style');
    // Putting the attribute back closes it, which is what the caller does next.
    node.setAttribute('popover', node.dataset.shotPopover);
    delete node.dataset.shotPopover;
    delete node.dataset.shotStyle;
  }
  for (const attribute of ['data-shot', 'data-shot-hide', 'data-shot-bare']) {
    for (const node of document.querySelectorAll(`[${attribute}]`)) node.removeAttribute(attribute);
  }
});

const shot = async (name, locator) => {
  await locator.scrollIntoViewIfNeeded();
  const cut = await page.addStyleTag({ content: CUT });
  await isolate(locator);
  await page.waitForTimeout(400);
  await locator.screenshot({ path: path.join(out, `${name}.png`), animations: 'disabled', omitBackground: true });
  await restore();
  await cut.evaluate((node) => node.remove());
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
  await shot('amp', page.locator('.amp-stand'));
  await shot('controls', page.locator('.global-controls'));
  // The stages the head's plate has no place engraved for, behind the band's
  // one key. The panel is a popover: it has to be opened to be shot.
  await page.getByRole('button', { name: 'Pedals', exact: true }).click();
  await page.locator('.pedals:popover-open').waitFor({ timeout: 5000 });
  await shot('panel', page.locator('.pedals'));
  await page.keyboard.press('Escape');

  // Before the take and before the score, not after them: the tuner listens to
  // whatever the chain's source is, and by the end of this script that source
  // has a recorded take on it. A tuner photographed then shows a dash where the
  // note goes, which is the one thing a tuner is for.
  await page.getByRole('button', { name: 'Open tuner' }).click();
  const heard = await page.locator('dialog.tuner .note-wrap.heard').waitFor({ timeout: 25000 }).then(() => true, () => false);
  if (!heard) console.log('  ! the tuner heard nothing: its shot will show a dash');
  await page.waitForTimeout(800);
  await shot('tuner', page.locator('dialog.tuner'));
  await page.getByRole('button', { name: 'Close tuner' }).click();
  await page.getByRole('button', { name: 'Open metronome' }).click();
  // A tempo in it, not the empty field it opens with: the shot is of a
  // metronome, and a metronome with no tempo is a blank readout. The score
  // this script loads further down is at 132, so the two agree.
  await page.getByRole('spinbutton', { name: 'Tempo in BPM' }).fill('132');
  await page.waitForTimeout(300);
  await shot('metronome', page.locator('dialog.metronome'));
  await page.getByRole('button', { name: 'Close metronome' }).click();

  // The transport is the studio's DAW: its row holds the looper and the tab.
  await shot('session', page.locator('.transport-row'));
  // A take, so the recorder shows a waveform rather than its empty state.
  await page.getByRole('button', { name: 'Record a take', exact: true }).click();
  await page.waitForTimeout(4000);
  await page.getByRole('button', { name: 'Stop the take', exact: true }).click();
  await page.getByRole('button', { name: 'Record a take', exact: true }).waitFor({ timeout: 20000 });
  await shot('recorder', page.locator('.transport'));

  // A score sends the studio to Play, where the tab has the stage.
  await page.locator('.reader input[type="file"]').setInputFiles(riff);
  await page.locator('.reader svg').first().waitFor({ timeout: 30000 });
  // The riff is in E minor: the neck shows where it lives.
  await page.getByRole('combobox', { name: 'Scale key', exact: true }).selectOption({ label: 'E' });
  await page.getByRole('combobox', { name: 'Scale', exact: true }).selectOption({ label: 'Minor pentatonic' });
  await page.waitForTimeout(1500);
  await shot('tabs', page.locator('.tab-stage'));

  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await shot('engine', settings);
} finally {
  await browser.close();
  server.close();
}
