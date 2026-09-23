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
  const file = path.resolve(dist, relative.endsWith('/') || !relative ? relative + 'index.html' : relative);
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', mime[path.extname(file)] ?? 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, locale: 'en-US' });
const errors = [];
// Printed as it happens: the final assertion only says an error was thrown,
// never which step threw it.
page.on('pageerror', e => { errors.push(e.message); console.log('pageerror:', e.stack ?? e.message); });
page.on('console', m => { if (m.type() === 'error') console.log('browser:', m.text()); });
// The path lives in TabReader.svelte and nothing else fails if it goes stale:
// alphaTab would sit silently waiting for a soundfont that 404s.
const soundFonts = [];
page.on('response', r => { if (r.url().endsWith('/MuseScore_General.sf3')) soundFonts.push(r.status()); });
try {
  await page.goto(`http://127.0.0.1:${server.address().port}${base}app/`);
  await page.getByRole('button', { name: 'Musician' }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.locator('.capture-info[data-capture="loaded"]').waitFor({ state: 'attached', timeout: 30000 });
  // The studio is one screen, in both views: the document never scrolls.
  const fits = () => page.evaluate(() => document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth);
  assert(await fits(), 'the Tone view fits the window');
  // A tone is saved, found again after a reload, and deleted, all from the preset dropdown.
  const tonePicker = page.getByRole('combobox', { name: 'Tone preset' });
  await page.getByRole('slider', { name: 'Gain' }).first().press('ArrowUp');
  await tonePicker.selectOption('action:save');
  await page.getByRole('textbox', { name: 'Tone name' }).fill('  Test   crunch ');
  await page.getByRole('textbox', { name: 'Tone name' }).press('Enter');
  const savedOption = tonePicker.locator('optgroup[label="My tones"] option', { hasText: 'Test crunch' });
  await savedOption.waitFor({ state: 'attached' });
  assert.equal(await tonePicker.inputValue(), await savedOption.getAttribute('value'), 'the saved tone is the one selected');
  const savedKey = await savedOption.getAttribute('value');
  await page.waitForTimeout(500); // the session write is debounced by 250 ms
  await page.reload();
  // Nothing starts by itself after a reload; the dropdown is enough to check.
  await savedOption.waitFor({ state: 'attached', timeout: 30000 });
  await page.waitForFunction(key => document.querySelector('select[aria-label="Tone preset"]')?.value === key, savedKey, { timeout: 10000 });
  await tonePicker.selectOption('action:delete');
  await savedOption.waitFor({ state: 'detached' });
  assert.equal(await tonePicker.inputValue(), '', 'deleting the tone leaves the sound as a custom tone');
  assert(await fits(), 'the tone dropdown does not change the layout');
  // The reload left the amp off, as it should: start it again as the page first did.
  await page.getByRole('button', { name: 'Musician' }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.locator('.capture-info[data-capture="loaded"]').waitFor({ state: 'attached', timeout: 30000 });
  // A take is recorded from the transport, and the tracks under it show it.
  await page.getByRole('button', { name: 'Record a take', exact: true }).click();
  await page.getByRole('button', { name: 'Stop the take', exact: true }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(3000); // capture a real fake-device stream
  await page.getByRole('button', { name: 'Stop the take', exact: true }).click();
  await page.getByRole('button', { name: 'Record a take', exact: true }).waitFor({ timeout: 20000 });
  assert(await fits(), 'the open drawer rises over the stage, it does not lengthen the page');
  await page.getByRole('button', { name: '● New take', exact: true }).waitFor({ timeout: 20000 });
  const download = async item => {
    const pending = page.waitForEvent('download', { timeout: 60000 });
    await page.getByRole('button', { name: 'Export WAV', exact: true }).click();
    await page.getByRole('menuitem', { name: new RegExp(`^${item.replace('+', '\\+')}`) }).click();
    const result = await pending;
    const target = path.join(artifacts, result.suggestedFilename());
    await result.saveAs(target);
    return fs.readFileSync(target);
  };
  const frames = wav => (wav.length - 56) / 4;
  // DI or processed is chosen on the recorder itself, not by the amplifier's power.
  await page.getByRole('radio', { name: 'DI', exact: true }).click();
  const dry = await download('Guitar only');
  assert.equal(dry.toString('ascii', 0, 4), 'RIFF');
  assert(dry.length > 100000);
  // The take is heard before it is exported.
  await page.getByRole('button', { name: 'Listen to take', exact: true }).click();
  await page.getByRole('button', { name: 'Pause take', exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Pause take', exact: true }).click();
  await page.getByRole('button', { name: 'Listen to take', exact: true }).waitFor();
  await page.getByRole('radio', { name: 'Processed', exact: true }).click();
  const wet = await download('Guitar only');
  assert.notDeepEqual(dry, wet);
  // Without a backing track, the list offers only the guitar.
  await page.getByRole('button', { name: 'Export WAV', exact: true }).click();
  assert(await page.getByRole('menuitem', { name: /^Guitar \+ backing/ }).isDisabled(), 'no mix without a backing track');
  assert(await page.getByRole('menuitem', { name: /^Backing only/ }).isDisabled(), 'no backing export without one');
  await page.locator('.recorder .lane-names').click();
  assert.equal(await page.getByRole('menu').count(), 0, 'the list closes on a click elsewhere');
  console.log('ok live recording, persistent DI, dry and processed WAV downloads');

  // A backing track: dropped in its lane, played along to while recording, and
  // exported with the take, alone, or cut to a selection.
  const songRate = 48000, songFrames = songRate * 2;
  const song = Buffer.alloc(44 + songFrames * 2);
  song.write('RIFF', 0); song.writeUInt32LE(36 + songFrames * 2, 4); song.write('WAVEfmt ', 8); song.writeUInt32LE(16, 16);
  song.writeUInt16LE(1, 20); song.writeUInt16LE(1, 22); song.writeUInt32LE(songRate, 24); song.writeUInt32LE(songRate * 2, 28);
  song.writeUInt16LE(2, 32); song.writeUInt16LE(16, 34); song.write('data', 36); song.writeUInt32LE(songFrames * 2, 40);
  for (let i = 0; i < songFrames; i++) song.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * i / songRate) * 9000), 44 + i * 2);
  await page.getByLabel('Backing track file', { exact: true }).setInputFiles({ name: 'song.wav', mimeType: 'audio/wav', buffer: song });
  await page.getByLabel('Backing track waveform', { exact: true }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: '● New take', exact: true }).click();
  await page.getByRole('button', { name: 'Stop the take', exact: true }).waitFor();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Stop the take', exact: true }).click();
  await page.getByRole('button', { name: '● New take', exact: true }).waitFor({ timeout: 20000 });
  await page.getByRole('radio', { name: 'DI', exact: true }).click();
  const cover = await download('Guitar + backing');
  const guitarOnly = await download('Guitar only');
  const backingOnly = await download('Backing only');
  const takeRate = cover.readUInt32LE(24);
  // Resampled from 48 kHz to the take's rate: the decoder may round one frame off.
  assert(Math.abs(frames(backingOnly) - 2 * takeRate) <= 2, `the backing track alone is the whole song (${frames(backingOnly)} frames at ${takeRate} Hz)`);
  assert.equal(frames(cover), Math.max(frames(guitarOnly), frames(backingOnly)), 'the longer lane sets the end of the mix');
  // Sync moves the guitar earlier against the backing track: 200 ms more of it
  // is before the timeline starts, so the guitar lane is 200 ms shorter.
  await page.getByLabel('Guitar sync', { exact: true }).fill('0');
  const unsynced = await download('Guitar only');
  await page.getByLabel('Guitar sync', { exact: true }).fill('200');
  const synced = await download('Guitar only');
  assert(Math.abs(frames(unsynced) - frames(synced) - 0.2 * takeRate) <= 2, `sync moves the guitar by what it says (${frames(unsynced)} → ${frames(synced)})`);
  await page.getByRole('button', { name: /^Measured / }).click();
  const lanes = await page.locator('.recorder .lanes').boundingBox();
  await page.mouse.move(lanes.x + lanes.width * 0.25, lanes.y + 20);
  await page.mouse.down();
  await page.mouse.move(lanes.x + lanes.width * 0.5, lanes.y + 20, { steps: 5 });
  await page.mouse.move(lanes.x + lanes.width * 0.75, lanes.y + 20, { steps: 5 });
  await page.mouse.up();
  await page.getByText(/^Selection /).waitFor();
  const part = await download('Guitar + backing');
  assert(Math.abs(frames(part) - frames(cover) / 2) < takeRate * 0.05, `a selection exports its span (${frames(part)} of ${frames(cover)})`);
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await page.getByRole('button', { name: 'Remove backing track', exact: true }).click();
  await page.getByLabel('Backing track file', { exact: true }).waitFor({ state: 'attached' });
  console.log('ok a backing track is recorded over, and exported with the take, alone, or cut to a selection');

  // A DI dropped on the guitar lane is the take: exported like one, and in
  // Processed played live through the amp, as the old file source did.
  // 3.5 s, so its duration cannot be mistaken for the take it replaces, even
  // with the frame the resampler may round off.
  const diFrames = Math.round(songRate * 3.5);
  const di = Buffer.alloc(44 + diFrames * 2);
  di.write('RIFF', 0); di.writeUInt32LE(36 + diFrames * 2, 4); di.write('WAVEfmt ', 8); di.writeUInt32LE(16, 16);
  di.writeUInt16LE(1, 20); di.writeUInt16LE(1, 22); di.writeUInt32LE(songRate, 24); di.writeUInt32LE(songRate * 2, 28);
  di.writeUInt16LE(2, 32); di.writeUInt16LE(16, 34); di.write('data', 36); di.writeUInt32LE(diFrames * 2, 40);
  for (let i = 0; i < diFrames; i++) di.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 110 * i / songRate) * 6000), 44 + i * 2);
  await page.getByLabel('Guitar DI file', { exact: true }).setInputFiles({ name: 'di.wav', mimeType: 'audio/wav', buffer: di });
  await page.waitForFunction(() => document.querySelector('.recorder .duration')?.textContent === '00:03', { timeout: 20000 });
  await page.getByRole('radio', { name: 'DI', exact: true }).click();
  const dropped = await download('Guitar only');
  assert(Math.abs(frames(dropped) - 3.5 * dropped.readUInt32LE(24)) <= 2, `the dropped DI is the whole take (${frames(dropped)} frames)`);
  await page.getByRole('radio', { name: 'Processed', exact: true }).click();
  /* Listening to a take switches the chain to the file and back. It must not
     give the interface back in between: reopening a device costs a few hundred
     milliseconds, or fails if something took it in the gap, and the amp sat
     dark with the guitar silent behind it at the end of every take listened to. */
  await page.evaluate(() => {
    const media = navigator.mediaDevices;
    const original = media.getUserMedia.bind(media);
    window.__opens = 0;
    media.getUserMedia = (...args) => { window.__opens++; return original(...args); };
  });
  await page.getByRole('button', { name: 'Listen to take', exact: true }).click();
  await page.getByRole('button', { name: 'Pause take', exact: true }).waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'Pause take', exact: true }).click();
  await page.getByRole('button', { name: 'Listen to take', exact: true }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(1000);
  assert.equal(await page.evaluate(() => window.__opens), 0, 'listening to a take never reopens the interface');
  console.log('ok a DI dropped on the guitar lane is the take, exported, and played live through the amp, and the interface is never given back');

  // The timeline is an editor, not a drawing: a track is dragged along it by
  // its grip, and a selection is taken out of every lane at once.
  const lanesBox = await page.locator('.recorder .lanes').boundingBox();
  const gripBox = await page.locator('.recorder .guitar-lane .lane-grip').first().boundingBox();
  assert(gripBox !== null, 'a track with audio has a grip to move it by');
  const laneDraw = () => page.evaluate(() => {
    const points = document.querySelector('.recorder .guitar-lane polyline')?.getAttribute('points')?.split(' ') ?? [];
    return { first: points.length ? Number(points[0].split(',')[0]) : -1, grip: document.querySelector('.recorder .guitar-lane .lane-grip')?.getBoundingClientRect().left ?? -1 };
  });
  const atRest = await laneDraw();
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(gripBox.x + gripBox.width / 2 + lanesBox.width * 0.25, gripBox.y + gripBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const dragged = await laneDraw();
  assert(dragged.first > 40 && dragged.grip > atRest.grip + 40,
    `dragging the grip moves the track and the room in front of it stays empty (${JSON.stringify(dragged)})`);
  await page.getByRole('radio', { name: 'DI', exact: true }).click();
  const movedExport = await download('Guitar only');
  assert(frames(movedExport) > frames(dropped) + movedExport.readUInt32LE(24) * 0.5, `a moved track is exported where it was put (${frames(movedExport)} against ${frames(dropped)})`);
  // Home puts it back where it was, and the export is the take again.
  await page.locator('.recorder .guitar-lane .lane-grip').first().focus();
  await page.keyboard.press('Home');
  await page.waitForTimeout(400);
  assert.deepEqual(await laneDraw(), atRest, 'Home returns the track to where it was recorded');
  assert.equal(frames(await download('Guitar only')), frames(dropped));

  // A span selected across the lanes, cut, and put back.
  await page.mouse.move(lanesBox.x + lanesBox.width * 0.2, lanesBox.y + 8);
  await page.mouse.down();
  for (let i = 0; i <= 10; i++) await page.mouse.move(lanesBox.x + lanesBox.width * (0.2 + 0.03 * i), lanesBox.y + 8);
  await page.mouse.up();
  await page.locator('.recorder .selection').waitFor();
  await page.getByRole('button', { name: 'Cut', exact: true }).click();
  await page.waitForTimeout(600);
  assert.equal(await page.locator('.recorder .selection').count(), 0, 'the cut consumes the selection');
  const shorter = await download('Guitar only');
  assert(frames(shorter) < frames(dropped) - 1000 && frames(shorter) > 0,
    `the cut takes its span out of the take (${frames(shorter)} of ${frames(dropped)})`);
  await page.getByRole('button', { name: 'Undo cut', exact: true }).click();
  await page.waitForTimeout(600);
  assert.equal(frames(await download('Guitar only')), frames(dropped), 'and one undo puts it back');
  await page.getByRole('radio', { name: 'Processed', exact: true }).click();
  console.log('ok the timeline moves a track by its grip, cuts a selection out of every lane, and undoes it');

  // A second track, added with the button and recorded over the first: the
  // first is heard through the chain while it records, and each exports alone
  // or together. Removing it leaves the first track as it was.
  await page.getByRole('button', { name: 'Add track', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Add track', exact: true }).count(), 0, 'two tracks at most');
  assert.equal(await page.getByRole('radio', { name: 'Record into Guitar 2', exact: true }).getAttribute('aria-checked'), 'true', 'a new track is the one recorded into');
  await page.getByRole('button', { name: 'Record a take', exact: true }).click();
  await page.getByRole('button', { name: 'Stop the take', exact: true }).waitFor({ timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Stop the take', exact: true }).click();
  await page.getByLabel('Recorded guitar 2', { exact: true }).waitFor({ timeout: 20000 });
  await page.getByRole('radio', { name: 'DI', exact: true }).click();
  const second = await download('Guitar 2 only');
  const both = await download('Guitars only');
  const firstOnly = await download('Guitar only');
  const secondRate = second.readUInt32LE(24);
  assert(frames(second) > 0.8 * secondRate && frames(second) < 3 * secondRate, `the second track is its own take (${frames(second)} frames)`);
  assert(Math.abs(frames(both) - Math.max(frames(firstOnly), frames(second))) <= 1, 'both tracks together run to the longer one');
  // Deleting asks twice, and deletes the track Record would record into.
  await page.getByRole('button', { name: 'Delete Guitar 2', exact: true }).click();
  assert.equal(await page.getByLabel('Recorded guitar 2', { exact: true }).count(), 1, 'one press only asks');
  await page.getByRole('button', { name: 'Press again to delete', exact: true }).click();
  await page.getByLabel('Recorded guitar 2', { exact: true }).waitFor({ state: 'detached' });
  assert.equal(frames(await download('Guitar only')), frames(firstOnly), 'removing the second track leaves the first as it was');
  console.log('ok a second track is added, recorded over the first, exported alone or with it, and removed');

  const importer = new alpha.importer.AlphaTexImporter();
  // Long enough to lay out several systems, so the scroll has somewhere to go.
  // The third track enters only in the last bar: that is the case a reader
  // makes look broken, because selecting it plays the band and not it.
  const repeat = (pattern, n) => Array.from({ length: n }, () => pattern).join(' | ');
  importer.initFromString('\\title "Practice riff" \\tempo 120 . '
    // The first bar opens a section and palm-mutes on its first beat, under the
    // tempo: three rows of text that alphaTab drew on top of one another.
    + `\\track "Guitar" \\section "Riff 1" :4 0.6{pm} 2.6{pm} 3.6 5.6 | ${repeat(':4 0.6 2.6 3.6 5.6', 39)} `
    + `\\track "Bass" \\tuning E2 A2 D3 G3 ${repeat(':4 0.4 2.4 3.4 5.4', 40)} `
    + `\\track "Late Solo" ${repeat(':4 r r r r', 39)} | :4 12.1 10.1 8.1 7.1`);
  const score = importer.readScore();
  const gp = Buffer.from(new alpha.exporter.Gp7Exporter().export(score));
  const picker = page.getByLabel('Import tablature', { exact: true });
  // The track list is a popover opened from the transport.
  const tracks = async () => {
    const list = page.locator('#tab-tracks');
    if (!(await list.evaluate(el => el.matches(':popover-open')))) await page.getByRole('button', { name: 'Tracks', exact: true }).click();
    return list;
  };
  const closeTracks = () => page.evaluate(() => document.getElementById('tab-tracks')?.hidePopover());
  // Opened from the transport, in the Tone mode: the studio goes to Play, and the tab has the stage.
  const mode = name => page.getByRole('tab', { name, exact: true });
  assert.equal(await mode('Tone').getAttribute('aria-selected'), 'true', 'the studio opens on the amp');
  await page.getByLabel('Open a tab', { exact: true }).setInputFiles({ name: 'practice.gp', mimeType: 'application/octet-stream', buffer: gp });
  await page.locator('.score-paper svg').first().waitFor({ timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('[role=tab][aria-selected=true]')?.textContent === 'Play');
  assert.equal(await page.locator('.amp-head').count(), 0, 'in Play the amp leaves the stage');
  assert(await page.getByRole('button', { name: 'Amplifier power', exact: true }).isVisible(), 'and its power is in the chain band');
  assert(await fits(), 'the Play view fits the window');
  await page.waitForTimeout(1500);
  const signed = await page.evaluate(() => [...document.querySelectorAll('.score-paper svg text')]
    .filter(t => t.textContent.includes('rendered by') && t.getClientRects().length > 0).length);
  assert.equal(signed, 0, 'the score carries no "rendered by alphaTab" caption');
  const rows = await page.evaluate(() => {
    const box = (match) => [...document.querySelectorAll('.score-paper svg text')].find(t => match(t.textContent.trim()))?.getBoundingClientRect();
    return [box(t => t === 'Riff 1'), box(t => t === 'P.M.'), box(t => t.includes('120'))].map(r => r && { top: r.top, bottom: r.bottom, left: r.left, right: r.right });
  });
  assert(rows.every(Boolean), `the section, the palm mute and the tempo are drawn (${JSON.stringify(rows)})`);
  const apart = (a, b) => a.bottom <= b.top || b.bottom <= a.top || a.right <= b.left || b.right <= a.left;
  assert(apart(rows[0], rows[1]) && apart(rows[0], rows[2]) && apart(rows[1], rows[2]), `rows of effects starting on one beat do not overlap (${JSON.stringify(rows)})`);
  await (await tracks()).getByRole('button', { name: /^02 Bass/ }).click();
  assert.equal(await (await tracks()).getByRole('button', { name: /^02 Bass/ }).getAttribute('aria-pressed'), 'true');
  await (await tracks()).getByRole('button', { name: 'Solo', exact: true }).click();
  assert.equal(await (await tracks()).getByRole('button', { name: 'Solo', exact: true }).getAttribute('aria-pressed'), 'true');
  await (await tracks()).getByRole('button', { name: /^01 Guitar/ }).click();
  assert.equal(await (await tracks()).getByRole('button', { name: 'Solo', exact: true }).getAttribute('aria-pressed'), 'false');
  // Solo and mute belong to their track: choosing another one used to clear
  // them all, so muting a second track unmuted the first.
  await (await tracks()).getByRole('button', { name: 'Mute', exact: true }).click();
  await (await tracks()).getByRole('button', { name: /^03 Late Solo/ }).click();
  assert.equal(await (await tracks()).getByRole('button', { name: 'Mute', exact: true }).getAttribute('aria-pressed'), 'false');
  await (await tracks()).getByRole('button', { name: 'Mute', exact: true }).click();
  await (await tracks()).getByRole('button', { name: /^01 Guitar/ }).click();
  assert.equal(await (await tracks()).getByRole('button', { name: 'Mute', exact: true }).getAttribute('aria-pressed'), 'true', 'muting a second track leaves the first muted');
  assert.equal(await page.locator('.tracks button.muted .flag.mute').count(), 2, 'the track list shows which tracks are muted');
  await (await tracks()).getByRole('button', { name: /^02 Bass/ }).click();
  assert.equal(await (await tracks()).getByRole('button', { name: 'Solo', exact: true }).getAttribute('aria-pressed'), 'true', 'a solo survives choosing other tracks');
  assert.equal(await page.locator('.tracks button.silenced').count(), 2, 'the track list shows which tracks a solo silences');
  // A volume per track, kept like mute and solo while other tracks are chosen.
  assert.equal(await page.locator('.tracks input.track-volume').count(), 3, 'every track has its own volume');
  await (await tracks()).getByLabel('Volume of Guitar', { exact: true }).fill('35');
  await (await tracks()).getByRole('button', { name: /^03 Late Solo/ }).click();
  await (await tracks()).getByRole('button', { name: /^02 Bass/ }).click();
  assert.equal(await (await tracks()).getByLabel('Volume of Guitar', { exact: true }).inputValue(), '35', 'a track keeps its volume');
  assert.equal(await (await tracks()).getByLabel('Volume of Bass', { exact: true }).inputValue(), '100', 'the others stay at full volume');
  await (await tracks()).getByLabel('Volume of Guitar', { exact: true }).fill('100');
  // Back to the whole band unmuted, for the playback below.
  await (await tracks()).getByRole('button', { name: 'Solo', exact: true }).click();
  await (await tracks()).getByRole('button', { name: /^01 Guitar/ }).click();
  await (await tracks()).getByRole('button', { name: 'Mute', exact: true }).click();
  await (await tracks()).getByRole('button', { name: /^03 Late Solo/ }).click();
  await (await tracks()).getByRole('button', { name: 'Mute', exact: true }).click();
  await (await tracks()).getByRole('button', { name: /^01 Guitar/ }).click();
  await closeTracks();
  await page.getByRole('button', { name: 'Play tablature', exact: true }).click({ timeout: 30000 });
  await page.getByRole('button', { name: 'Pause tablature', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.clock').textContent.startsWith('0:00'), { timeout: 10000 });
  assert.deepEqual(soundFonts, [200], 'the MuseScore_General soundfont is fetched once, and served');
  await page.getByRole('button', { name: 'Pause tablature', exact: true }).click();
  await page.getByRole('combobox', { name: 'Playback speed', exact: true }).selectOption('70');
  await page.getByRole('button', { name: 'Loop song', exact: true }).click();
  await page.getByRole('combobox', { name: 'Notation view', exact: true }).selectOption('both');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(artifacts, 'tab-reader-desktop.png') });
  // The two modes, one press apart, the tab kept laid out while the amp has the stage.
  await mode('Tone').click();
  await page.locator('.amp-head').waitFor();
  assert(await page.locator('.tab-stage').evaluate(el => el.inert), 'the stowed tab takes no input');
  assert(await fits(), 'back in Tone, the studio still fits');
  await mode('Tone').press('ArrowRight');
  assert.equal(await mode('Play').getAttribute('aria-selected'), 'true', 'the arrow keys move between the modes');
  await page.locator('.amp-head').waitFor({ state: 'detached' });
  console.log('ok Guitar Pro import, tracks, solo, notation, playback, speed, loop, and the two modes');

  // Where a track plays, and getting there. A track that enters late is not a
  // broken track, but nothing said so until the count and the jump existed.
  const late = (await tracks()).getByRole('button', { name: /^03 Late Solo/ });
  assert.equal((await late.innerText()).trim().split(/\s+/).pop(), '1', 'the track list counts the bars a track plays in');
  await late.click();
  await page.locator('.plays').filter({ hasText: '40\u201340 \u00b7 1/40' }).waitFor();
  await page.getByRole('button', { name: 'Stop tablature', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.clock').textContent.startsWith('0:00'), { timeout: 10000 });
  await (await tracks()).getByRole('button', { name: 'Go to its first bar', exact: true }).click();
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

  // Synced, the tab starts the click and gives it back when it stops. It used
  // to start one and leave it ticking over a paused page, with nothing on
  // screen claiming the sound.
  const clicking = () => page.locator('.metronome-toggle').getAttribute('aria-pressed');
  await page.getByRole('button', { name: 'Open metronome' }).click();
  const syncButton = page.locator('dialog.metronome .sync');
  if (await syncButton.getAttribute('aria-pressed') !== 'true') await syncButton.click();
  await page.getByRole('button', { name: 'Close metronome' }).click();
  assert.equal(await clicking(), 'false', 'the sync alone starts nothing');
  await page.getByRole('button', { name: 'Play tablature', exact: true }).click();
  await page.getByRole('button', { name: 'Pause tablature', exact: true }).waitFor({ timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('.metronome-toggle')?.getAttribute('aria-pressed') === 'true', null, { timeout: 15000 });
  await page.getByRole('button', { name: 'Pause tablature', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.metronome-toggle')?.getAttribute('aria-pressed') === 'false', null, { timeout: 15000 });
  // A click the player started is theirs, and the tab never takes it away.
  await page.locator('.metronome-toggle').click();
  assert.equal(await clicking(), 'true');
  await page.getByRole('button', { name: 'Play tablature', exact: true }).click();
  await page.getByRole('button', { name: 'Pause tablature', exact: true }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Pause tablature', exact: true }).click();
  await page.getByRole('button', { name: 'Play tablature', exact: true }).waitFor({ timeout: 15000 });
  assert.equal(await clicking(), 'true', 'the tab stops only the click it started itself');
  await page.locator('.metronome-toggle').click();
  await page.getByRole('button', { name: 'Open metronome' }).click();
  await syncButton.click();
  await page.getByRole('button', { name: 'Close metronome' }).click();
  console.log('ok a synced tab starts the click and gives it back, and never takes the player\'s own');

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
    const stage = document.querySelector('.stage').getBoundingClientRect();
    const neck = document.querySelector('.neck svg')?.getBoundingClientRect();
    return { off: cursor ? Math.round(cursor.left + cursor.width / 2 - view.left - view.width / 2) : null, scrolled: Math.round(el.scrollLeft), down: Math.round(el.scrollTop), height: el.scrollHeight - el.clientHeight,
      inStage: Math.round(view.top) >= Math.round(stage.top) - 1 && Math.round(view.bottom) <= Math.round(stage.bottom) + 1,
      neckInStage: !neck || (Math.round(neck.top) >= Math.round(stage.top) - 1 && Math.round(neck.bottom) <= Math.round(stage.bottom) + 1) };
  });
  const centred = await read();
  assert(centred.scrolled > 0, 'the score has slid under the playhead');
  assert(Math.abs(centred.off) < 40, `the playhead stays in the middle of the window (off by ${centred.off}px)`);
  // One line, however tall alphaTab makes it: in this layout a system is as
  // tall as the tallest bar of the whole score, which on a long one is mostly
  // blank above the staff. Nothing may leave the stage, which clips — that is
  // what cut the neck in half under the tab — and when the system is taller
  // than the lectern, the paper is parked on the staff, not on the blank.
  assert(centred.inStage, 'the paper stays inside the stage');
  assert(centred.neckInStage, 'the neck is drawn inside the stage, whole');
  if (centred.height > 0) assert(centred.down > 0, 'a system taller than the lectern is parked on its staff');
  // Smoothly: the scroll is animated over the cursor's own transition, so it
  // moves between beats rather than jumping from one bar to the next.
  await page.waitForTimeout(400);
  const later = await read();
  assert(later.scrolled > centred.scrolled, 'the score keeps sliding');
  assert(Math.abs(later.off) < 40, `and the playhead stays put (off by ${later.off}px)`);
  await page.getByRole('button', { name: 'Pause tablature', exact: true }).click();
  // Pausing leaves the line under the mark. Three separate things ask to
  // scroll on a pause and all of them carry somewhere else: the start of the
  // beat the cursor is part way across, or — because the synthesiser runs
  // ahead of the beat it draws — the bar the sound had already reached, which
  // on a long score arrives as a seek many bars further on, and late. Read
  // after two seconds for that reason: a window of a few frames was what let
  // it through the first time.
  await page.waitForTimeout(2000);
  const stopped = await read();
  assert(Math.abs(stopped.off) < 40, `pausing leaves the playhead on the cursor (off by ${stopped.off}px)`);
  console.log('ok the score slides horizontally under a centred playhead, and stops under it');

  // Zoomed, the line ends where the score ends. alphaTab kept its surface at
  // the unscaled width: zoomed out, blank paper ran on after the last bar;
  // zoomed in, the last bars were out of reach.
  for (const zoom of ['75', '150', '100']) {
    await page.getByRole('combobox', { name: 'Tab zoom', exact: true }).selectOption(zoom);
    await page.waitForTimeout(2500);
    const line = await page.evaluate(() => {
      const parts = [...document.querySelectorAll('.score-paper div')].filter(d => 'layoutResultId' in d);
      const score = Math.max(...parts.map(p => p.offsetLeft + p.offsetWidth));
      const tail = document.querySelector('.score-tail')?.offsetWidth ?? 0;
      return { score, scrollable: document.querySelector('.score-viewport').scrollWidth - tail };
    });
    assert(Math.abs(line.scrollable - line.score) <= 2, `at ${zoom}% the line ends with the score (${JSON.stringify(line)})`);
  }
  assert.equal(await page.locator('.reader .error').count(), 0, 'zooming shows no error');
  console.log('ok zooming keeps the line exactly as long as the score');

  // The arrows: a beat at a time while paused, a bar at a time while playing.
  await (await tracks()).getByRole('button', { name: /^01 Guitar/ }).click();
  await page.getByRole('button', { name: 'Stop tablature', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.clock').textContent.startsWith('0:00'), { timeout: 10000 });
  const cursorAt = selector => page.evaluate(s => {
    const el = document.querySelector(s)?.getBoundingClientRect();
    const view = document.querySelector('.score-viewport');
    return el ? { x: Math.round(el.left - view.getBoundingClientRect().left + view.scrollLeft), width: Math.round(el.width) } : null;
  }, selector);
  await page.locator('.reader').focus();
  const paused = [];
  for (const key of ['ArrowRight', 'ArrowRight', 'ArrowLeft']) {
    await page.keyboard.press(key);
    await page.waitForTimeout(400);
    paused.push((await cursorAt('.at-cursor-beat')).x);
  }
  const bar = await cursorAt('.at-cursor-bar');
  assert(paused[1] > paused[0] && paused[0] > 0, `paused, the right arrow steps beat by beat (${paused})`);
  assert(paused[1] - paused[0] < bar.width / 2, `one beat, not a bar (${paused[1] - paused[0]}px of a ${bar.width}px bar)`);
  assert(Math.abs(paused[2] - paused[0]) <= 3, `and the left arrow steps back (${paused})`);
  assert.equal(await page.locator('.neck .core').count(), 1, 'paused, the neck lights the note under the cursor');
  await page.getByRole('button', { name: 'Play tablature', exact: true }).click();
  await page.getByRole('button', { name: 'Pause tablature', exact: true }).waitFor({ timeout: 10000 });
  // The transport's button has the focus now; the arrows are the reader's.
  await page.locator('.reader').focus();
  await page.waitForTimeout(300);
  const barBefore = await cursorAt('.at-cursor-bar');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(250);
  const barAfter = await cursorAt('.at-cursor-bar');
  await page.getByRole('button', { name: 'Pause tablature', exact: true }).click();
  assert(barAfter.x - barBefore.x >= barBefore.width * 0.9, `playing, the right arrow goes to the next bar (${barBefore.x} → ${barAfter.x}, bar ${barBefore.width}px)`);
  console.log('ok the arrows step a beat while paused and a bar while playing');

  // Up and down: a string cursor while paused, drawn on the tab's own lines,
  // lighting only that string's note; another track while playing.
  await page.getByRole('button', { name: 'Stop tablature', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.clock').textContent.startsWith('0:00'), { timeout: 10000 });
  await page.locator('.reader').focus();
  const stringMark = () => page.evaluate(() => {
    const m = document.querySelector('.string-cursor')?.getBoundingClientRect();
    return m ? Math.round(m.top + m.height / 2) : null;
  });
  const tabLinesNow = () => page.evaluate(() => {
    const svg = document.querySelector('.score-paper svg');
    return [...new Set([...svg.querySelectorAll('rect')].map(r => r.getBoundingClientRect())
      .filter(r => r.height > 0 && r.height < 3 && r.width > 40).map(r => Math.round(r.top + r.height / 2)))].sort((a, b) => a - b);
  });
  // In both views: score and tab, where the tab is the lower staff, and tab alone.
  for (const view of ['both', 'tab']) {
    await page.getByRole('combobox', { name: 'Notation view', exact: true }).selectOption(view);
    await page.waitForTimeout(2500);
    await page.locator('.reader').focus();
    const tabLines = await tabLinesNow();
    // The first beat of Guitar is one note, on its lowest string: the first press
    // puts the cursor there, the next two move it up to strings with no note.
    const stringMarks = [], stringCores = [];
    for (const key of ['ArrowUp', 'ArrowUp', 'ArrowUp']) {
      await page.keyboard.press(key);
      await page.waitForTimeout(250);
      stringMarks.push(await stringMark());
      stringCores.push(await page.locator('.neck .core').count());
    }
    const lowest = tabLines[tabLines.length - 1];
    assert(stringMarks.every(m => m !== null), `${view}: the string cursor is drawn (${stringMarks})`);
    assert(Math.abs(stringMarks[0] - lowest) <= 3, `${view}: on the lowest tab line for the lowest string (${stringMarks} against ${tabLines})`);
    assert(stringMarks.every(m => tabLines.some(l => Math.abs(l - m) <= 3)), `${view}: on the tab's own lines (${stringMarks} against ${tabLines})`);
    assert(stringMarks[1] < stringMarks[0] && stringMarks[2] < stringMarks[1], `${view}: up moves it up a string (${stringMarks})`);
    assert.deepEqual(stringCores, [1, 0, 0], `${view}: the neck lights the note on that string, and nothing on a string with none`);
    // Down, back to the lowest string, so the next view starts from the same place.
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
    await (await tracks()).getByRole('button', { name: /^01 Guitar/ }).click();
    await page.locator('.reader').focus();
  }
  await page.getByRole('button', { name: 'Play tablature', exact: true }).click();
  await page.getByRole('button', { name: 'Pause tablature', exact: true }).waitFor({ timeout: 10000 });
  assert.equal(await page.locator('.string-cursor').count(), 0, 'playing hides the string cursor');
  await page.locator('.reader').focus();
  const before = await page.locator('.tracks button[aria-pressed="true"]').innerText();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(200);
  const after = await page.locator('.tracks button[aria-pressed="true"]').innerText();
  await page.getByRole('button', { name: 'Pause tablature', exact: true }).click();
  assert.notEqual(after, before, `playing, the down arrow chooses the next track (${before.split(/\s+/)[1]} → ${after.split(/\s+/)[1]})`);
  await (await tracks()).getByRole('button', { name: /^01 Guitar/ }).click();
  console.log('ok up and down move a string cursor while paused and change track while playing');

  // The neck under the tab is the track's own: a four-string bass draws four.
  assert.equal(await page.locator('.neck .fret').count(), 24);
  assert.equal(await page.locator('.neck .string').count(), 6);
  await (await tracks()).getByRole('button', { name: /^02 Bass/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.neck .string').length === 4, { timeout: 10000 });
  await (await tracks()).getByRole('button', { name: /^01 Guitar/ }).click();
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

  /*
   * Under a neck's worth of room the neck is not squeezed into a line: it
   * leaves the stage and comes back as a window over the tab, opened from a
   * handle in the corner. The tab is what is being read; the neck is what is
   * asked for.
   */
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: viewport.width, height: 760 });
  await page.waitForFunction(() => document.querySelector('.reader .neck') === null, { timeout: 10000 });
  assert.equal(await page.locator('.neck-window').count(), 0, 'and it does not open by itself');
  await page.getByRole('button', { name: 'Show the neck', exact: true }).click();
  await page.locator('.neck-window .neck').waitFor({ timeout: 10000 });
  assert.equal(await page.locator('.neck-window .string').count(), 6, 'the window draws the track\u2019s own neck');
  const over = await page.evaluate(() => {
    const neck = document.querySelector('.neck-window')?.getBoundingClientRect();
    const paper = document.querySelector('.score-viewport')?.getBoundingClientRect();
    return neck && paper ? neck.top < paper.bottom && neck.bottom > paper.top : false;
  });
  assert(over, 'the window sits over the tab rather than taking room from it');
  assert(await fits(), 'and the studio still fits the window');
  await page.getByRole('button', { name: 'Hide the neck', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.neck-window') === null, { timeout: 10000 });
  await page.setViewportSize(viewport);
  await page.waitForFunction(() => document.querySelector('.reader .stage > .neck') !== null, { timeout: 10000 });
  assert.equal(await page.locator('.neck-handle').count(), 0, 'with the room back, the neck is under the tab and the handle is gone');
  console.log('ok with no room under the tab, the neck is a window over it, opened and closed at will');

  // Scales: every key, rings on the neck, and the note being played drawn
  // inside them rather than hidden by them — or hiding them.
  const keySelect = page.getByRole('combobox', { name: 'Scale key', exact: true });
  const scaleSelect = page.getByRole('combobox', { name: 'Scale', exact: true });
  assert.equal(await keySelect.locator('option').count(), 12, 'all twelve keys are offered');
  await keySelect.selectOption('4');
  await scaleSelect.selectOption('minor-pentatonic');
  const marks = await page.locator('.neck .scale').count();
  assert(marks > 55 && marks < 70, `E minor pentatonic lights the neck (${marks} positions)`);
  assert((await page.locator('.neck .scale.root').count()) > 0, 'and marks its roots');
  assert.equal(await page.locator('.scale-notes').innerText(), 'E · G · A · B · D');
  await page.getByRole('button', { name: 'Play tablature', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.neck .core').length > 0, { timeout: 15000 });
  const layered = await page.evaluate(() => {
    const all = [...document.querySelectorAll('.neck svg .halo, .neck svg .scale, .neck svg .core')];
    const kinds = all.map(e => ['halo', 'scale', 'core'].find(k => e.classList.contains(k)));
    return {
      scales: kinds.filter(k => k === 'scale').length,
      cores: kinds.filter(k => k === 'core').length,
      ordered: kinds.lastIndexOf('halo') < kinds.indexOf('scale') && kinds.lastIndexOf('scale') < kinds.indexOf('core'),
    };
  });
  await page.getByRole('button', { name: 'Pause tablature', exact: true }).click();
  assert(layered.scales > 55 && layered.cores > 0, 'the scale stays lit while the tab plays');
  assert(layered.ordered, 'glow under the scale, the played note on top of it');
  await scaleSelect.selectOption('');
  assert.equal(await page.locator('.neck .scale').count(), 0, 'None takes the scale off');
  console.log('ok scales in all twelve keys light the neck, under the note being played');

  // Writing a tab: behind its button, from the keyboard, on the neck, and
  // exported as Guitar Pro that opens again.
  assert.equal(await page.locator('.editor-bar').count(), 0, 'the editor waits behind its button');
  await page.getByRole('button', { name: 'Write a tab', exact: true }).click();
  const editor = page.locator('.editor-bar');
  await editor.waitFor({ timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('.tracks button').length === 1 && document.querySelector('.score-paper svg'), null, { timeout: 30000 });
  await page.locator('.reader').focus();
  // 3 on the top string; the next beat 1 then 2, twelve, made an eighth; a string down, 5.
  for (const key of ['3', 'ArrowRight', '1', '2', 'NumpadAdd', 'ArrowDown', 'Digit5']) await page.keyboard.press(key);
  await page.waitForFunction(() => {
    const texts = [...document.querySelectorAll('.score-paper svg text')].map(t => t.textContent.trim());
    return ['3', '12', '5'].every(f => texts.includes(f));
  }, null, { timeout: 15000 });
  assert.equal(await editor.getByRole('button', { name: '1/8', exact: true }).getAttribute('aria-pressed'), 'true', '+ makes the beat shorter');
  // The chord written, 12 and 5, is on the neck whole, not only the string under the cursor.
  await page.waitForFunction(() => document.querySelectorAll('.neck .core').length === 2 && document.querySelector('.string-cursor'), null, { timeout: 10000 });
  // The neck writes too: fret 7 on the lowest string joins the chord, and Delete note takes it off again.
  const picks = page.locator('.neck .pick');
  assert.equal(await picks.count(), 6 * 25, 'every string has a target at the nut and on each of the 24 frets');
  await picks.nth(5 * 25 + 7).click();
  await page.waitForFunction(() => document.querySelectorAll('.neck .core').length === 3, null, { timeout: 10000 });
  await editor.getByRole('button', { name: 'Delete note', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.neck .core').length === 2, null, { timeout: 10000 });
  assert(await editor.getByRole('button', { name: 'Delete note', exact: true }).isDisabled(), 'nothing left to delete on that string');
  await editor.getByLabel('Tempo', { exact: true }).fill('90');
  await editor.getByLabel('Tempo', { exact: true }).dispatchEvent('change');
  await editor.getByLabel('String count', { exact: true }).selectOption('7');
  await page.waitForFunction(() => document.querySelectorAll('.neck .string').length === 7, null, { timeout: 15000 });
  await editor.getByLabel('Tuning', { exact: true }).selectOption({ label: 'Drop A' });
  await editor.getByLabel('Time signature', { exact: true }).selectOption('6/8');
  assert(await editor.getByRole('button', { name: 'Delete track', exact: true }).isDisabled(), 'the last track cannot be deleted');
  await editor.getByRole('button', { name: '+ Track', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.tracks button').length === 2, null, { timeout: 15000 });
  await editor.getByRole('button', { name: 'Delete track', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.tracks button').length === 1, null, { timeout: 15000 });
  await page.waitForFunction(() => {
    const texts = [...document.querySelectorAll('.score-paper svg text')].map(t => t.textContent.trim());
    return ['3', '12', '5'].every(f => texts.includes(f));
  }, null, { timeout: 15000 });
  await editor.getByRole('button', { name: '+ Track', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.tracks button').length === 2, null, { timeout: 15000 });
  const pendingGp = page.waitForEvent('download', { timeout: 30000 });
  await editor.getByRole('button', { name: 'Export .gp', exact: true }).click();
  const gpFile = await pendingGp;
  assert.equal(gpFile.suggestedFilename(), 'Untitled.gp');
  const written = alpha.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(fs.readFileSync(await gpFile.path())), new alpha.Settings());
  const writtenStaff = written.tracks[0].staves[0];
  const writtenBeats = writtenStaff.bars[0].voices[0].beats;
  assert(written.tracks.length === 2 && written.tempo === 90 && writtenStaff.tuning.length === 7 && writtenStaff.tuning.at(-1) === 33,
    `the export keeps the tracks, the tempo and the tuning (${written.tracks.length} tracks, ${written.tempo} BPM, ${writtenStaff.tuning})`);
  assert.deepEqual(writtenBeats.slice(0, 2).map(b => b.notes.map(n => n.fret).sort((a, b) => a - b)), [[3], [5, 12]], 'and the notes written');
  assert.equal(writtenBeats[1].duration, 8, 'at the duration chosen');
  assert.equal(`${written.masterBars[0].timeSignatureNumerator}/${written.masterBars[0].timeSignatureDenominator}`, '6/8', 'in the time signature chosen');
  console.log('ok a tab written from the keyboard, on seven strings with a second track, exported as Guitar Pro');

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
  assert.equal(await page.locator('.editor-bar').count(), 0, 'opening a tab goes back to reading');
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
  await page.waitForTimeout(500); // the session write is debounced by 250 ms
  await page.reload();
  await page.getByRole('button', { name: 'Explore first' }).click();
  await page.getByRole('button', { name: 'Play tablature', exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await page.locator('.recorder polyline').count(), 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.reader').scrollIntoViewIfNeeded();
  await page.locator('.score-paper svg').first().waitFor();
  await page.waitForTimeout(500); // allow the responsive score worker to finish its layout
  await page.screenshot({ path: path.join(artifacts, 'tab-reader-mobile.png') });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal page overflow on mobile');

  // A phone and a tablet, in both layouts. The head is one object scaled whole
  // to the room it has, and the figure it is scaled by is computed from a box
  // the scale itself sizes: read the wrong way round it comes back as the scale
  // already in force, the head stays at its desktop width and a phone gets a
  // third of an amplifier. Measured, not eyeballed: the head is inside its slot
  // and no band is wider than the window.
  // Tone, where the head is the stage: Play gives it to the tab and there is no
  // head on screen to measure.
  await page.getByRole('tab', { name: 'Tone' }).click();
  await page.locator('.amp-frame').waitFor();
  for (const [width, height] of [[360, 740], [390, 844], [768, 1024], [820, 1180], [1024, 768]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(700); // the scale settles with the head's own material
    const fit = await page.evaluate(() => {
      const box = el => el.getBoundingClientRect();
      const head = document.querySelector('.amp-frame'), slot = document.querySelector('.amp-slot');
      // The three plates. Not the stage: the head's lead hangs off its side on
      // purpose, and the room around the head is where it hangs.
      const bands = [...document.querySelectorAll('.bar, .global-controls, .transport')];
      return {
        head: head ? Math.round(box(head).width) : null,
        slot: slot ? Math.round(box(slot).width) : null,
        wide: bands.filter(b => b.scrollWidth > b.clientWidth + 1).map(b => b.className.split(' ')[0]),
        page: document.documentElement.scrollWidth <= innerWidth,
      };
    });
    assert(fit.head !== null && fit.head <= fit.slot, `the head fits its slot at ${width}x${height} (${fit.head} in ${fit.slot})`);
    assert.deepEqual(fit.wide, [], `no band overflows its own width at ${width}x${height}`);
    assert(fit.page, `no horizontal page overflow at ${width}x${height}`);
  }
  await page.screenshot({ path: path.join(artifacts, 'tester-tablet.png') });
  assert.deepEqual(errors, []);
  console.log(`ok malformed import recovery, score/recording restoration, phone and tablet layout\nArtifacts: ${artifacts}`);
} catch (e) {
  await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true });
  console.error('Reader:', await page.locator('.reader').innerText());
  console.error('Recorder:', await page.locator('.recorder').innerText());
  console.error('Browser errors:', errors, 'Artifacts:', artifacts);
  throw e;
} finally { await browser.close(); server.close(); }
