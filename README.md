# Tonecraft

Guitar amp in a browser tab. No install, no plugin, no driver, no account, no
server.

**It makes sound.** The amplifier is a [Neural Amp
Modeler](https://www.neuralampmodeler.com/) capture running in WebAssembly; the
cabinet, the boost, the correction and the reverb are ours. Plug a DI in, press
start, and there is a tone — or drop an audio file in and hear the same chain on
a take you already have.

With no guitar and no interface, there is still something to hear: **a demo take
ships with the site** (`public/di/demo-di.wav`, 1.6 MB, fetched only when asked
for), and the **Amp / Direct** switch plays it either through the chain or raw.
The direct path carries 4.3 dB of measured makeup so the two match in level —
otherwise the comparison is a loudness test, and louder wins every loudness test
regardless of what it sounds like.

---

## Requirements

- **Node 24 LTS** (Krypton). Checked by `engines` in `package.json`.

Nothing else. There is no C++ toolchain any more.

## Commands

```sh
npm ci            # install exactly what the lockfile pins
npm run dev       # dev server
npm run build     # check, then static build into dist/
npm test          # schema consistency, input constraints, diagnosis verdicts
npm run check     # the invariants that span files, on their own
npm run measure   # the boost's aliasing, as a table
npm run vendor    # re-fetch the NAM engine and the captures (the only network step)
npm run calibrate # re-measure every capture's level and write its trim
```

A fresh clone needs no step beyond `npm ci`: the engine and the captures are
vendored into `public/`.

`npm run test:browser` drives a real browser end to end and needs
`npx playwright install chromium` once. It is the only test that can see the
failure that matters: when the NAM engine does not come up, the chain passes the
dry signal through — there is sound, the meters move, and nothing looks wrong.
It asserts on the worklet's own confirmation that the capture is running, so
that failure goes red instead of silent.

## The chain

```
source (live DI or an audio file)
  -> frontend worklet     channel choice, trim, noise gate, TS boost (4x + ADAA)
  -> NAM worklet          the amplifier itself, WebAssembly
  -> capture trim         measured offline, so captures match each other
  -> cabinet              ConvolverNode, synthesised minimum-phase IR
  -> four-band correction native biquads, post-cabinet
  -> reverb, in parallel
  -> master + limiter     always on, no control anywhere
  -> output meter         pass-through: peak, RMS, dropouts
```

**A capture is a frozen snapshot of one amplifier at one setting.** Its gain,
its channel and its own EQ are baked into the file and cannot be driven. What is
set here is what we send into it and what we do with what comes back — which is
why the capture and the cabinet, not any fader, are the two real tone choices.

**The cabinet is not optional.** These captures are of the amplifier alone:
measured, they are still +5 dB at 7 kHz, where a capture including a cabinet
would be 25 dB down. Without one the result is not an amp sound.

## Layout

```
schema/   parameter definitions — depends on nothing
engine/   graph composition, capture loading, IR synthesis, meters, diagnosis
app/      the Svelte island — never touches the audio graph directly
site/     Astro pages (this is Astro's srcDir)
render/   measurement tools; the offline renderer is not rebuilt yet
public/   the NAM engine, the worklets and the captures, served as-is
scripts/  vendoring, calibration, measurement, checks
```

Dependencies point one way only:

```
schema ──> engine ──> app ──> site
              └──> render
```

## What is in this repository that is binary

One file: `public/nam/nam.wasm`, a pinned build of NeuralAmpModelerCore fetched
by `scripts/vendor-nam.mjs`. It is a third-party artifact rather than our build
output, and committing it is what makes a clean checkout deployable without CI
needing network access beyond npm.

## Licences

- The application — yours to do as you like with.
- **The NAM engine** — [`@opendaw/nam-wasm`](https://github.com/andremichelle/nam-wasm),
  MIT, © Steven Atkinson, a build of
  [NeuralAmpModelerCore](https://github.com/sdatkinson/NeuralAmpModelerCore).
  See `public/nam/nam-wasm-LICENSE.txt`.
- **The amp captures** — [`pelennor2170/NAM_models`](https://github.com/pelennor2170/NAM_models),
  **GNU GPL v3**. See `public/models/COPYING`.

⚠️ The captures are GPL v3. Distributing Tonecraft with `public/models/` included
brings the obligations of the GPL v3 with it. For personal use there is no
constraint. To distribute without copyleft, remove `public/models/` and let the
player supply their own captures.

## Documents

| Document | What it governs |
| --- | --- |
| `CLAUDE.md` | Working rules, non-negotiable audio and frontend constraints |
| `PRODUCT.md` | Positioning, audience, scope, metrics, legal position |
| `DESIGN.md` | The design system — the source of truth for anything visual |
| `_bmad-output/planning-artifacts/PRD.md` | 50 functional and 18 non-functional requirements |
| `_bmad-output/planning-artifacts/Architecture.md` | The spine: 21 invariants, conventions, stack |
