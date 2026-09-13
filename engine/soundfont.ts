/**
 * Makes the tab reader's soundfont play under alphaTab the way it was voiced.
 *
 * MuseScore_General is voiced for FluidSynth, and alphaTab's synthesizer
 * departs from the SoundFont specification in three ways that change what it
 * plays. Each is corrected here, on a copy in memory, before alphaTab reads
 * it: the committed file stays the unmodified third-party asset
 * `assets/README.md` records, and nothing is added to git history.
 *
 * 1. **Stereo samples.** The pianos, and a few percussion samples, are stereo
 *    pairs: a left and a right sample per note. alphaTab only loads samples
 *    typed mono and skipped these — a console warning per sample, and empty
 *    piano voices that render NaN. One NaN voice turns the whole mix to NaN,
 *    so a tab with a piano anywhere in it played nothing at all. Retyping the
 *    halves as mono is enough: each already plays from its own panned zone.
 *
 * 2. **Global zones.** A global zone holds defaults that a zone's own value
 *    replaces. alphaTab adds attenuation and tuning instead, so a value set in
 *    both counts twice: Ice Rain 100 dB down, which is silence, 5th Saw Wave
 *    27 dB, the pianos 23, Bandoneon 20, FM Electric Piano 14 dB from A4 up.
 *    Each local value has the global one taken off, so alphaTab's sum comes
 *    out as the value the SoundFont specifies.
 *
 * 3. **Modulators.** alphaTab reads them and applies none, and the soundfont
 *    uses them to open its filters: the pianos' low-pass sits at 246-300 Hz
 *    and a velocity-scaled filter envelope opens it by up to 6500 cents; synth
 *    basses, leads, brass and pads work the same way, by up to five octaves.
 *    Those that depend on velocity and key only are evaluated once per zone —
 *    at the middle of its key range, and at the velocity alphaTab gives a
 *    forte, a tab's default dynamic — and written into the cutoff and
 *    filter-envelope generators they modulate. What is lost is brightness
 *    following how hard a note is struck; loudness still follows it, as
 *    alphaTab does that itself. Controllers alphaTab never sends (CC2,
 *    pressure) are left out, and so is the specification's default
 *    velocity-to-cutoff modulator: every instrument here with a closed filter
 *    overrides it. A preset's modulators apply to every zone of the instrument
 *    under it, so where they track the key, that instrument is copied for the
 *    preset and the copy's zones carry them, each at its own key.
 *
 * Generators are added, so the preset data is rebuilt; the 38 MB of samples
 * are copied, not decoded. Checked in Node against alphaTab's own synthesizer
 * (`soundfont.test.ts`).
 */

/** Sample type bits, SoundFont 2.04 §7.10, plus the SF3 compression flag. */
const MONO = 0x0001;
const RIGHT = 0x0002;
const LEFT = 0x0004;
const LINKED = 0x0008;
const VORBIS = 0x0010;
const ROM = 0x8000;

/** Generator numbers, SoundFont 2.04 §8.1.3. */
const GEN_FILTER_FC = 8;
const GEN_MOD_ENV_TO_FILTER_FC = 11;
const GEN_INSTRUMENT = 41;
const GEN_KEY_RANGE = 43;
const GEN_VEL_RANGE = 44;
const GEN_ATTENUATION = 48;
const GEN_COARSE_TUNE = 51;
const GEN_FINE_TUNE = 52;
const GEN_SAMPLE = 53;

/** What alphaTab sums across a global and a local zone, where the local value should replace the global. */
const SUMMED = [GEN_ATTENUATION, GEN_COARSE_TUNE, GEN_FINE_TUNE];
/** The filter generators modulators are baked into. */
const BAKED = [GEN_FILTER_FC, GEN_MOD_ENV_TO_FILTER_FC];
/** The initial cutoff a zone without one has: 13500 cents, which alphaTab treats as no filter. */
const FILTER_OPEN = 13500;
/** `MidiUtils.dynamicToVelocity(DynamicValue.F)`: alphaTab's forte, the dynamic a tab has until it says otherwise. */
const FORTE = 95;

/** Sample header record: 20 bytes of name, five u32, two bytes, u16 link, u16 type. */
const SHDR_SIZE = 46;
const TYPE_OFFSET = 44;

interface Chunk { readonly at: number; readonly size: number }
interface Generator { op: number; amount: number }
interface Modulator { readonly src: number; readonly dst: number; readonly amount: number; readonly src2: number; readonly transform: number }
interface Zone { gens: Generator[]; readonly mods: Modulator[] }
interface Header { readonly raw: Uint8Array; zones: Zone[] }

const tagAt = (bytes: Uint8Array, at: number): string =>
  String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);

/** The sub-chunks of pdta, by id. Throws on bytes that are not a SoundFont. */
function hydra(bytes: Uint8Array): { view: DataView; chunks: Map<string, Chunk> } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || tagAt(bytes, 0) !== 'RIFF' || tagAt(bytes, 8) !== 'sfbk') throw new Error('not a SoundFont');
  const chunks = new Map<string, Chunk>();
  const end = Math.min(bytes.length, 8 + view.getUint32(4, true));
  for (let at = 12; at + 8 <= end;) {
    const size = view.getUint32(at + 4, true);
    if (tagAt(bytes, at) === 'LIST' && tagAt(bytes, at + 8) === 'pdta') {
      const listEnd = Math.min(end, at + 8 + size);
      for (let sub = at + 12; sub + 8 <= listEnd;) {
        const subSize = view.getUint32(sub + 4, true);
        chunks.set(tagAt(bytes, sub), { at: sub + 8, size: subSize });
        sub += 8 + subSize + (subSize & 1);
      }
    }
    at += 8 + size + (size & 1);
  }
  if (!chunks.has('shdr')) throw new Error('the SoundFont has no sample headers');
  return { view, chunks };
}

function stereoSamples(view: DataView, shdr: Chunk): Set<number> {
  const stereo = new Set<number>();
  // The last record is the terminal "EOS" header, never a sample.
  const records = Math.floor(shdr.size / SHDR_SIZE) - 1;
  for (let i = 0; i < records; i++) {
    const type = view.getUint16(shdr.at + i * SHDR_SIZE + TYPE_OFFSET, true);
    if ((type & ROM) === 0 && (type & MONO) === 0 && (type & (RIGHT | LEFT | LINKED)) !== 0) stereo.add(i);
  }
  return stereo;
}

function retype(view: DataView, shdrAt: number, samples: Set<number>): number {
  for (const i of samples) {
    const at = shdrAt + i * SHDR_SIZE + TYPE_OFFSET;
    view.setUint16(at, MONO | (view.getUint16(at, true) & VORBIS), true);
  }
  return samples.size;
}

/**
 * Retypes every stereo or linked sample as mono, in place, and nothing else.
 * Returns how many were changed. What the reader loaded before the voicing
 * was corrected, kept so the test can measure what the rest changes.
 */
export function monoSoundFont(bytes: Uint8Array): number {
  const { view, chunks } = hydra(bytes);
  const shdr = chunks.get('shdr')!;
  return retype(view, shdr.at, stereoSamples(view, shdr));
}

/** Presets or instruments, with their zones, read out of the hydra. */
function readHeaders(view: DataView, chunks: Map<string, Chunk>, [hdr, bag, mod, gen]: string[], hdrSize: number, bagOffset: number): { headers: Header[]; terminal: Uint8Array } {
  const h = chunks.get(hdr!), b = chunks.get(bag!), m = chunks.get(mod!), g = chunks.get(gen!);
  if (!h || !b || !m || !g) throw new Error(`the SoundFont has no ${hdr} list`);
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const count = Math.floor(h.size / hdrSize) - 1;
  const headers: Header[] = [];
  for (let i = 0; i < count; i++) {
    const at = h.at + i * hdrSize;
    const first = view.getUint16(at + bagOffset, true), last = view.getUint16(at + hdrSize + bagOffset, true);
    const zones: Zone[] = [];
    for (let z = first; z < last; z++) {
      const gens: Generator[] = [], mods: Modulator[] = [];
      for (let k = view.getUint16(b.at + z * 4, true); k < view.getUint16(b.at + (z + 1) * 4, true); k++) {
        gens.push({ op: view.getUint16(g.at + k * 4, true), amount: view.getInt16(g.at + k * 4 + 2, true) });
      }
      for (let k = view.getUint16(b.at + z * 4 + 2, true); k < view.getUint16(b.at + (z + 1) * 4 + 2, true); k++) {
        const a = m.at + k * 10;
        mods.push({ src: view.getUint16(a, true), dst: view.getUint16(a + 2, true), amount: view.getInt16(a + 4, true), src2: view.getUint16(a + 6, true), transform: view.getUint16(a + 8, true) });
      }
      zones.push({ gens, mods });
    }
    headers.push({ raw: bytes.slice(at, at + hdrSize), zones });
  }
  return { headers, terminal: bytes.slice(h.at + count * hdrSize, h.at + (count + 1) * hdrSize) };
}

/** The four sub-chunks of a header list, bag indices renumbered. */
function writeHeaders(headers: Header[], terminal: Uint8Array, hdrSize: number, bagOffset: number): Uint8Array[] {
  const zones = headers.reduce((n, h) => n + h.zones.length, 0);
  const gens = headers.reduce((n, h) => h.zones.reduce((k, z) => k + z.gens.length, n), 0);
  const mods = headers.reduce((n, h) => h.zones.reduce((k, z) => k + z.mods.length, n), 0);
  // Bag, generator and modulator indices are 16-bit in the file format.
  if (zones >= 0xffff || gens >= 0xffff || mods >= 0xffff) throw new Error('the corrected SoundFont does not fit its index format');
  const hdr = new Uint8Array((headers.length + 1) * hdrSize), bag = new Uint8Array((zones + 1) * 4);
  const mod = new Uint8Array((mods + 1) * 10), gen = new Uint8Array((gens + 1) * 4);
  const hv = new DataView(hdr.buffer), bv = new DataView(bag.buffer), mv = new DataView(mod.buffer), gv = new DataView(gen.buffer);
  let z = 0, g = 0, m = 0;
  headers.forEach((h, i) => {
    hdr.set(h.raw, i * hdrSize);
    hv.setUint16(i * hdrSize + bagOffset, z, true);
    for (const zone of h.zones) {
      bv.setUint16(z * 4, g, true);
      bv.setUint16(z * 4 + 2, m, true);
      z++;
      for (const x of zone.gens) { gv.setUint16(g * 4, x.op, true); gv.setInt16(g * 4 + 2, x.amount, true); g++; }
      for (const x of zone.mods) {
        mv.setUint16(m * 10, x.src, true); mv.setUint16(m * 10 + 2, x.dst, true); mv.setInt16(m * 10 + 4, x.amount, true);
        mv.setUint16(m * 10 + 6, x.src2, true); mv.setUint16(m * 10 + 8, x.transform, true);
        m++;
      }
    }
  });
  hdr.set(terminal, headers.length * hdrSize);
  hv.setUint16(headers.length * hdrSize + bagOffset, z, true);
  bv.setUint16(z * 4, g, true);
  bv.setUint16(z * 4 + 2, m, true);
  return [hdr, bag, mod, gen];
}

const find = (zone: Zone | undefined, op: number): number | undefined => zone?.gens.find((g) => g.op === op)?.amount;
const clampInt16 = (v: number): number => Math.max(-32768, Math.min(32767, Math.round(v)));

/** The first zone is global when it does not end in the generator that links it to a sample or an instrument. */
function split(zones: Zone[], link: number): { global: Zone | undefined; locals: Zone[] } {
  const global = zones.length > 0 && find(zones[0], link) === undefined ? zones[0] : undefined;
  return { global, locals: (global ? zones.slice(1) : zones).filter((z) => find(z, link) !== undefined) };
}

/** Sets a generator, adding it just before the zone's link generator, which the format wants last. */
function setGenerator(zone: Zone, op: number, amount: number): void {
  const existing = zone.gens.find((g) => g.op === op);
  if (existing) existing.amount = clampInt16(amount);
  else zone.gens.splice(Math.max(0, zone.gens.length - 1), 0, { op, amount: clampInt16(amount) });
}

/** Local values of generators alphaTab sums, minus the global zone's. Returns how many were changed. */
function replaceGlobals(zones: Zone[], link: number): number {
  const { global, locals } = split(zones, link);
  if (!global) return 0;
  let changed = 0;
  for (const op of SUMMED) {
    const value = find(global, op);
    if (value === undefined || value === 0) continue;
    for (const zone of locals) {
      const own = zone.gens.find((g) => g.op === op);
      if (own) { own.amount = clampInt16(own.amount - value); changed++; }
    }
  }
  return changed;
}

/** A key or velocity range generator as [low, high], the whole MIDI range when absent. */
function rangeOf(zone: Zone | undefined, global: Zone | undefined, op: number): [number, number] {
  const r = find(zone, op) ?? find(global, op);
  return r === undefined ? [0, 127] : [r & 0xff, (r >> 8) & 0xff];
}
const intersect = (a: [number, number], b: [number, number]): [number, number] | null => {
  const lo = Math.max(a[0], b[0]), hi = Math.min(a[1], b[1]);
  return lo <= hi ? [lo, hi] : null;
};

/**
 * A modulator source's value for one note, SoundFont 2.04 §8.2, or null for a
 * source alphaTab never sends — a MIDI controller, pressure, the pitch wheel.
 */
function sourceValue(src: number, key: number, velocity: number): number | null {
  if ((src & 0x80) !== 0) return null;
  const index = src & 0x7f;
  let x: number;
  if (index === 0) return 1;
  else if (index === 2) x = velocity / 127;
  else if (index === 3) x = key / 127;
  else return null;
  if ((src & 0x100) !== 0) x = 1 - x;
  const curve = src >> 10;
  if (curve === 1) x = x >= 1 ? 1 : Math.min(1, (-20 / 96) * Math.log10((1 - x) ** 2));
  else if (curve === 2) x = x <= 0 ? 0 : Math.max(0, 1 + (20 / 96) * Math.log10(x ** 2));
  else if (curve === 3) x = x >= 0.5 ? 1 : 0;
  return (src & 0x200) !== 0 ? 2 * x - 1 : x;
}

/** A local zone's modulators: the global zone's, replaced by the zone's own where they are the same modulator. */
function effectiveModulators(global: Zone | undefined, zone: Zone): Modulator[] {
  const byIdentity = new Map<string, Modulator>();
  for (const m of [...(global?.mods ?? []), ...zone.mods]) {
    if (BAKED.includes(m.dst)) byIdentity.set(`${m.src}:${m.dst}:${m.src2}:${m.transform}`, m);
  }
  return [...byIdentity.values()];
}

/** What a set of modulators adds to one generator, for one note. */
function modulation(mods: Modulator[], op: number, key: number, velocity: number): number {
  let sum = 0;
  for (const m of mods) {
    if (m.dst !== op || m.amount === 0) continue;
    const a = sourceValue(m.src, key, velocity);
    const b = m.src2 === 0 ? 1 : sourceValue(m.src2, key, velocity);
    if (a === null || b === null) continue;
    const value = m.amount * a * b;
    sum += m.transform === 2 ? Math.abs(value) : value;
  }
  return Math.round(sum);
}

const tracksKey = (mods: Modulator[]): boolean =>
  mods.some((m) => m.amount !== 0 && ((m.src & 0xff) === 3 || (m.src2 & 0xff) === 3));

/**
 * Writes modulation into a local instrument zone's filter generators, for a
 * note at the middle of `keys` and as close to forte as `velocities` allows.
 * Returns whether anything changed.
 */
function bakeZone(zone: Zone, global: Zone | undefined, mods: Modulator[], keys: [number, number], velocities: [number, number]): boolean {
  const key = Math.round((keys[0] + keys[1]) / 2);
  const velocity = Math.max(velocities[0], Math.min(velocities[1], FORTE));
  let changed = false;
  for (const op of BAKED) {
    const add = modulation(mods, op, key, velocity);
    if (add === 0) continue;
    const base = find(zone, op) ?? find(global, op) ?? (op === GEN_FILTER_FC ? FILTER_OPEN : 0);
    setGenerator(zone, op, base + add);
    changed = true;
  }
  return changed;
}

const cloneZone = (zone: Zone): Zone => ({ gens: zone.gens.map((g) => ({ ...g })), mods: zone.mods });

export interface Prepared {
  /** The corrected soundfont, a new buffer: the bytes given are left as they were. */
  readonly bytes: Uint8Array;
  /** Stereo or linked samples retyped as mono. */
  readonly retyped: number;
  /** Zone values alphaTab would have counted twice. */
  readonly summed: number;
  /** Zones whose filter modulation was written into their generators. */
  readonly filters: number;
  /** Instruments copied so a preset's key-tracked modulation could follow the key. */
  readonly copies: number;
}

/** Everything above. Throws on bytes that are not a SoundFont, so a soundfont that failed to arrive is a stated error rather than a silent reader. */
export function prepareSoundFont(input: Uint8Array): Prepared {
  const { view, chunks } = hydra(input);
  const presetList = readHeaders(view, chunks, ['phdr', 'pbag', 'pmod', 'pgen'], 38, 24);
  const instList = readHeaders(view, chunks, ['inst', 'ibag', 'imod', 'igen'], 22, 20);
  const presets = presetList.headers, instruments = instList.headers;

  let summed = 0, filters = 0;
  for (const p of presets) summed += replaceGlobals(p.zones, GEN_INSTRUMENT);
  for (const i of instruments) summed += replaceGlobals(i.zones, GEN_SAMPLE);

  // The instrument's own modulators, into its own zones.
  for (const inst of instruments) {
    const { global, locals } = split(inst.zones, GEN_SAMPLE);
    for (const zone of locals) {
      const mods = effectiveModulators(global, zone);
      if (mods.length && bakeZone(zone, global, mods, rangeOf(zone, global, GEN_KEY_RANGE), rangeOf(zone, global, GEN_VEL_RANGE))) filters++;
    }
  }

  // A preset's modulators, into the instrument under it: in place when they do
  // not depend on the key, into a copy made for that preset zone when they do.
  const copies = new Map<string, number>();
  const originalCount = instruments.length;
  for (const preset of presets) {
    const { global, locals } = split(preset.zones, GEN_INSTRUMENT);
    for (const pz of locals) {
      const mods = effectiveModulators(global, pz);
      if (!mods.some((m) => m.amount !== 0)) continue;
      const instIndex = find(pz, GEN_INSTRUMENT)!;
      const source = instruments[instIndex];
      if (!source) continue;
      const pKeys = rangeOf(pz, global, GEN_KEY_RANGE), pVels = rangeOf(pz, global, GEN_VEL_RANGE);
      const identity = `${instIndex}|${pKeys}|${pVels}|${mods.map((m) => `${m.src}:${m.dst}:${m.amount}:${m.src2}:${m.transform}`).join(',')}`;
      let target = copies.get(identity);
      if (target === undefined) {
        const copy: Header = { raw: source.raw, zones: source.zones.map(cloneZone) };
        const { global: iGlobal, locals: iLocals } = split(copy.zones, GEN_SAMPLE);
        let changed = 0;
        for (const zone of iLocals) {
          const keys = intersect(rangeOf(zone, iGlobal, GEN_KEY_RANGE), pKeys);
          const vels = intersect(rangeOf(zone, iGlobal, GEN_VEL_RANGE), pVels);
          if (keys && vels && bakeZone(zone, iGlobal, mods, keys, vels)) changed++;
        }
        if (changed === 0) { copies.set(identity, instIndex); continue; }
        filters += changed;
        target = instruments.push(copy) - 1;
        copies.set(identity, target);
      }
      if (target !== instIndex) pz.gens.find((g) => g.op === GEN_INSTRUMENT)!.amount = target;
    }
  }
  const shdr = chunks.get('shdr')!;
  const samples = input.slice(shdr.at, shdr.at + shdr.size);
  const retyped = retype(new DataView(samples.buffer), 0, stereoSamples(view, shdr));

  const [phdr, pbag, pmod, pgen] = writeHeaders(presets, presetList.terminal, 38, 24);
  const [inst, ibag, imod, igen] = writeHeaders(instruments, instList.terminal, 22, 20);
  const parts: [string, Uint8Array][] = [['phdr', phdr!], ['pbag', pbag!], ['pmod', pmod!], ['pgen', pgen!],
    ['inst', inst!], ['ibag', ibag!], ['imod', imod!], ['igen', igen!], ['shdr', samples]];
  const listSize = 4 + parts.reduce((n, [, body]) => n + 8 + body.length + (body.length & 1), 0);

  // Every top-level chunk copied as it is, the preset data replaced.
  const sections: Uint8Array[] = [];
  const end = Math.min(input.length, 8 + view.getUint32(4, true));
  for (let at = 12; at + 8 <= end;) {
    const size = view.getUint32(at + 4, true);
    const next = Math.min(end, at + 8 + size + (size & 1));
    if (tagAt(input, at) !== 'LIST' || tagAt(input, at + 8) !== 'pdta') sections.push(input.subarray(at, next));
    else {
      const list = new Uint8Array(8 + listSize);
      const lv = new DataView(list.buffer);
      list.set([0x4c, 0x49, 0x53, 0x54], 0); lv.setUint32(4, listSize, true);
      list.set([0x70, 0x64, 0x74, 0x61], 8);
      let w = 12;
      for (const [id, body] of parts) {
        for (let k = 0; k < 4; k++) list[w + k] = id.charCodeAt(k);
        lv.setUint32(w + 4, body.length, true);
        list.set(body, w + 8);
        w += 8 + body.length + (body.length & 1);
      }
      sections.push(list);
    }
    at = next;
  }
  const total = 12 + sections.reduce((n, s) => n + s.length, 0);
  const bytes = new Uint8Array(total);
  bytes.set(input.subarray(0, 12), 0);
  new DataView(bytes.buffer).setUint32(4, total - 8, true);
  let w = 12;
  for (const s of sections) { bytes.set(s, w); w += s.length; }

  return { bytes, retyped, summed, filters, copies: instruments.length - originalCount };
}
