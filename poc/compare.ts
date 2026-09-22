/**
 * The listening set: the same passages through each candidate, level-matched,
 * plus a local page to switch between them.
 *
 *   npx tsx poc/compare.ts <file.gp>
 *
 * Writes poc/out/listen/*.wav and poc/out/listen/index.html (open it locally:
 * the sampler's notes are CC BY-NC-ND and are not to be published).
 */
import fs from 'node:fs';
import { loadScore, trackEvents, tempoMap, type TrackEvents } from './tab-events.ts';
import { renderModel, DEFAULT_PARAMS, type ModelParams } from './string-model.ts';
import { renderSampler } from './sampler.ts';
import { renderAlphaTab } from './baseline.ts';
import { throughChain, RATE } from './chain.ts';
import { activeRms } from './analysis.ts';
import { writeWav } from '../render/wav.ts';

const TARGET_DI_DB = -36.1;
const LISTEN_DB = -20;
const OUT = 'poc/out/listen';
const file = process.argv[2]!;
const score = loadScore(new Uint8Array(fs.readFileSync(file)));
const time = tempoMap(score);
const fitted: ModelParams = { ...DEFAULT_PARAMS, ...(fs.existsSync('poc/out/model-params.json') ? JSON.parse(fs.readFileSync('poc/out/model-params.json', 'utf8')) : {}) };

interface Section { id: string; title: string; tracks: number[]; bars: [number, number]; band: boolean; /** Rhythm on Modern metal, leads on Lead: asked for. */ preset: string }
const SECTIONS: Section[] = [
  { id: 'riff', title: 'Rythmique — deux guitares, gauche et droite (mesures 30-45)', tracks: [0, 1], bars: [30, 45], band: false, preset: 'Modern metal' },
  { id: 'solo', title: 'Leads en harmonie — legato, tapping, harmoniques (mesures 20-30)', tracks: [2, 3], bars: [20, 30], band: false, preset: 'Lead' },
  { id: 'mix', title: 'Dans le morceau — guitares + basse et batterie de la soundfont (mesures 30-45)', tracks: [0, 1], bars: [30, 45], band: true, preset: 'Modern metal' },
];
const ENGINES = [
  { id: 'soundfont', name: "Aujourd'hui : soundfont MuseScore (sans ampli)" },
  { id: 'model', name: 'B · Modèle physique → chaîne Tonecraft' },
  { id: 'sampler', name: 'A · Sampler DI réel → chaîne Tonecraft' },
];

const lead = 0.25;
const scale = (x: Float32Array, g: number) => { for (let i = 0; i < x.length; i++) x[i]! *= g; return x; };
const stereoRms = (l: Float32Array, r: Float32Array) => { const m = new Float32Array(l.length); for (let i = 0; i < l.length; i++) m[i] = (l[i]! + r[i]!) / 2; return activeRms(m); };
const db = (v: number) => 20 * Math.log10(v);

fs.mkdirSync(OUT, { recursive: true });
const bandCache = new Map<string, [Float32Array, Float32Array]>();
function band(s: Section, length: number): [Float32Array, Float32Array] {
  const key = s.bars.join('-');
  if (!bandCache.has(key)) {
    const rest = score.tracks.map((t) => t.index).filter((i) => i >= 5);
    const [l, r] = renderAlphaTab(score, rest, s.bars[0], s.bars[1]);
    const pad = Math.round(lead * RATE);
    const L = new Float32Array(length), R = new Float32Array(length);
    L.set(l.subarray(0, length - pad), pad); R.set(r.subarray(0, length - pad), pad);
    bandCache.set(key, [L, R]);
  }
  return bandCache.get(key)!;
}

const rows: { section: Section; files: { engine: string; name: string; file: string }[]; di: { name: string; file: string }[] }[] = [];
for (const s of SECTIONS) {
  const t0 = time(score.masterBars[s.bars[0]]!.start);
  const mb = score.masterBars[s.bars[1]]!;
  const t1 = time(mb.start + mb.calculateDuration());
  const seconds = t1 - t0 + 1.5;
  const length = Math.ceil((seconds + 2) * RATE);
  const row = { section: s, files: [] as { engine: string; name: string; file: string }[], di: [] as { name: string; file: string }[] };
  for (const e of ENGINES) {
    let L = new Float32Array(length), R = new Float32Array(length);
    if (e.id === 'soundfont') {
      const [l, r] = renderAlphaTab(score, s.tracks, s.bars[0], s.bars[1]);
      const pad = Math.round(lead * RATE);
      L.set(l.subarray(0, length - pad), pad); R.set(r.subarray(0, length - pad), pad);
    } else {
      for (const [k, ti] of s.tracks.entries()) {
        const t = trackEvents(score, ti, k + 1);
        const events = t.events.filter((x) => x.start >= t0 - 0.01 && x.start < t1)
          .map((x) => ({ ...x, start: x.start - t0 + lead, end: Math.min(x.end, t1 + 1) - t0 + lead }));
        const tr: TrackEvents = { ...t, events };
        const di = e.id === 'model' ? renderModel(tr, seconds, fitted, k + 1) : renderSampler(tr, seconds, k + 1);
        scale(di, Math.pow(10, TARGET_DI_DB / 20) / activeRms(di));
        if (k === 0 && s.id !== 'mix') {
          const f = `${s.id}-${e.id}-di.wav`;
          // The DI itself, brought up to listening level: what the amp is fed.
          writeWav(`${OUT}/${f}`, RATE, [scale(di.slice(), Math.pow(10, (LISTEN_DB - TARGET_DI_DB) / 20))]);
          row.di.push({ name: `${e.id === 'model' ? 'B · Modèle physique' : 'A · Sampler'} — DI brut, piste ${ti}`, file: f });
        }
        const wet = await throughChain(di, s.preset);
        const pan = s.tracks.length === 1 ? 0 : k === 0 ? -0.8 : 0.8;
        const gl = Math.cos((pan + 1) * Math.PI / 4) * Math.SQRT2, gr = Math.sin((pan + 1) * Math.PI / 4) * Math.SQRT2;
        for (let i = 0; i < wet.length && i < length; i++) { L[i]! += wet[i]! * gl; R[i]! += wet[i]! * gr; }
      }
    }
    const g = Math.pow(10, LISTEN_DB / 20) / stereoRms(L, R);
    scale(L, g); scale(R, g);
    if (s.band) {
      const [bl, br] = band(s, length);
      const bg = Math.pow(10, (LISTEN_DB - 1) / 20) / stereoRms(bl, br);
      L = L.map((v, i) => v + bl[i]! * bg); R = R.map((v, i) => v + br[i]! * bg);
      const g2 = Math.pow(10, (LISTEN_DB + 2) / 20) / stereoRms(L, R);
      scale(L, g2); scale(R, g2);
    }
    const peak = Math.max(...[L, R].map((c) => c.reduce((m, v) => Math.max(m, Math.abs(v)), 0)));
    if (peak > 0.98) { scale(L, 0.98 / peak); scale(R, 0.98 / peak); }
    const f = `${s.id}-${e.id}.wav`;
    writeWav(`${OUT}/${f}`, RATE, [L, R]);
    row.files.push({ engine: e.id, name: e.name, file: f });
    console.log(`${f}  peak ${db(peak).toFixed(1)} dBFS`);
  }
  rows.push(row);
}

const html = `<!doctype html><html lang="fr"><meta charset="utf-8"><title>Tab DI — écoute</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#111;--fg:#e8e8ea;--mute:#9a9aa3;--line:#2a2a30;--accent:#9b7bff}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){--bg:#f6f6f7;--fg:#141416;--mute:#5d5d66;--line:#dcdce0;--accent:#6b4bd8}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px;max-width:880px;margin-inline:auto}
h1{font-weight:500;font-size:22px;margin:0 0 4px}p{color:var(--mute);margin:0 0 24px}
section{border-top:1px solid var(--line);padding:18px 0}h2{font-weight:500;font-size:16px;margin:0 0 12px}
.row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:12px;align-items:center;margin:8px 0}
.row span{font-size:14px}.row.sampler span{color:var(--accent)}audio{width:100%}
details{margin-top:10px;color:var(--mute)}kbd{border:1px solid var(--line);border-radius:4px;padding:0 5px;font-size:12px}
@media (max-width:560px){.row{grid-template-columns:1fr}}
</style>
<h1>Tablature → guitare → ampli</h1>
<p>Même passage, même niveau d'écoute (${LISTEN_DB} dBFS RMS). Les versions A et B passent dans la vraie chaîne Tonecraft : rythmiques sur le preset Modern metal, leads sur Lead, aucune reverb. First Fragment, <em>De chair et de haine</em>, 7 cordes en F#. Lecture synchronisée : changer de lecteur reprend au même instant. <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> pour basculer dans la section en cours.</p>
${rows.map((r) => `<section><h2>${r.section.title}</h2><p>Preset ${r.section.preset}, sans reverb.</p>
${r.files.map((f) => `<div class="row ${f.engine}"><span>${f.name}</span><audio controls preload="none" src="${f.file}"></audio></div>`).join('\n')}
${r.di.length ? `<details><summary>Le DI brut, avant l'ampli</summary>${r.di.map((d) => `<div class="row"><span>${d.name}</span><audio controls preload="none" src="${d.file}"></audio></div>`).join('')}</details>` : ''}
</section>`).join('\n')}
<script>
// Switching player keeps the position: an A/B is only fair at the same bar.
let current = null;
document.querySelectorAll('audio').forEach((a) => a.addEventListener('play', () => {
  if (current && current !== a) { if (current.closest('section') === a.closest('section')) a.currentTime = current.currentTime; current.pause(); }
  current = a;
}));
addEventListener('keydown', (e) => {
  if (!current || !'123'.includes(e.key)) return;
  const list = current.closest('section').querySelectorAll('.row:not(details .row) audio');
  const next = list[Number(e.key) - 1];
  if (next && next !== current) { const t = current.currentTime; current.pause(); next.currentTime = t; next.play(); }
});
</script></html>`;
fs.writeFileSync(`${OUT}/index.html`, html);
console.log(`open ${OUT}/index.html`);
