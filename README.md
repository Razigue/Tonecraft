# Tonecraft

Guitar amp in a browser tab. No install, no plugin, no driver, no account, no
server.

**It makes sound.** The amplifier is a [Neural Amp
Modeler](https://www.neuralampmodeler.com/) capture running in WebAssembly; the
cabinet, the boost, the correction and the reverb are ours. Plug a DI in, press
start, and there is a tone — or drop an audio file in and hear the same chain on
a take you already have.

The opening sheet asks which of those two you are, and they are not the same
product: **I have a guitar** opens your input, **Just let me hear it** loads a
take and **never calls `getUserMedia` at all** — no prompt, no device, nothing
listening. It does not start playing on its own either; press play when you
want it. What is not left to you is the chain: it is on, so the first press is
Tonecraft, and turning it off is the deliberate act. A permission dialog in front of a demonstration is a
toll gate, and the browser test counts the calls rather than trusting the claim.

So with no guitar and no interface, there is still something to hear: **a demo
take ships with the site** (`public/di/demo-di.wav`, 1.6 MB, fetched only when asked
for), and one button in the top right — **Tonecraft / Direct**, or the **B** key —
turns the whole simulation on and off so the difference is one click away rather
than a description. Off means off: the chain is muted **and the live input is
closed with it**, because monitoring a laptop's built-in microphone through the
speakers is a feedback path, not a comparison. With a file loaded you hear that
file raw; with the live input as the source there is nothing to hear, and the
rig says so.
The direct path carries 5.9 dB of measured makeup so the two match in level —
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
public/   the amp model, the worklets and the captures, served as-is
scripts/  vendoring, calibration, measurement, checks
```

Dependencies point one way only:

```
schema ──> engine ──> app ──> site
   │          └──> render
   └──> dsp/model (generated header)
```

## What is in this repository that is binary

- `public/nam/wavenet.wasm` — the amp model, 8 kB, built from `dsp/model/` by
  `npm run model:build`. It is our build output and it is committed anyway: the
  alternative is emsdk in CI and on GitHub Pages for an artifact that changes
  only when `dsp/` does. `npm run model:verify` fails if what is committed stops
  agreeing with NeuralAmpModelerCore.
- `public/models/*.tcnm` — the captures, flattened out of their JSON at vendor
  time. 55 kB each, against 407 kB of `.nam`.
- `assets/models/*.nam` — the captures as they were downloaded. In the
  repository, not served: they are the GPL source of the blobs above, and
  shipping 1.6 MB of JSON for the browser to re-parse would be paying twice.
- `assets/golden/*.f32` — what NeuralAmpModelerCore produces from three seconds
  of the demo DI, so `npm run model:verify` needs no checkout of it.

## Licences

- The application — yours to do as you like with.
- **The amp model** — ours (`dsp/model/wavenet.h`), an implementation of the
  Standard WaveNet architecture defined by
  [NeuralAmpModelerCore](https://github.com/sdatkinson/NeuralAmpModelerCore)
  (MIT, © Steven Atkinson), which is also what it is checked against. Tonecraft
  shipped a vendored build of that core until 2026-09-07; see
  `dsp/model/wavenet.h` for why it no longer does.
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
