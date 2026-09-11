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

**With an ASIO interface, the chain can leave the browser.** A tab cannot open
an ASIO driver, so on Windows the smallest buffers an interface offers are out
of its reach. **Tonecraft Engine** (`service/`) is a small native program that
reaches them: it runs the very same chain, and the page becomes its controls.
Choose ASIO in the audio settings; if the program is not running, the settings
say where to download it and connect by themselves once it starts. It also runs
on macOS (CoreAudio) and Linux (ALSA).

## Download

To play through an ASIO interface, download **Tonecraft Engine**:
[Tonecraft Engine 0.1.1](https://github.com/Razigue/Tonecraft/releases/tag/engine-v0.1.1).

---

## Requirements

- **Node 24 LTS** (Krypton). Checked by `engines` in `package.json`.

Nothing else, to run, test or deploy. The chain is committed as a built
`.wasm`. Rebuilding *that* is the one step that needs a C++ toolchain: an
Emscripten SDK, found through `EMSDK`, `.toolchain/emsdk` or `PATH`. See
`scripts/build-dsp.mjs` for the flags and what each one was measured to be
worth. Building Tonecraft Engine needs Rust, and on Windows LLVM (libclang,
for the ASIO SDK bindings) — see `service/README.md`.

## Commands

```sh
npm ci            # install exactly what the lockfile pins
npm run dev       # dev server
npm run build     # check, then static build into dist/
npm test          # schema consistency, the chain, input constraints, diagnosis verdicts
npm run check     # the invariants that span files, on their own
npm run test:chain   # the chain from Node: ABI, convolution, zero latency, a capture
npm run test:parity  # browser and Tonecraft Engine, bit for bit (needs service/ built)
npm run measure   # the boost's aliasing, as a table
npm run vendor    # re-fetch the captures (network)
npm run generate  # rewrite dsp/chain.generated.h from the schema
npm run build:dsp # recompile the chain to WebAssembly with SIMD (needs Emscripten)
npm run bench     # time the whole chain per 128-frame block
npm run measure:latency  # what the chain and the oversampler delay the signal by
npm run design:halfband  # the oversampler's filters, with their measured figures
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

All of it is one WebAssembly module, `public/dsp/chain.wasm`, built from
`dsp/`, and run by one AudioWorklet:

```
source (live DI or an audio file, played by the chain itself)
  -> frontend             channel choice, trim, noise gate
  -> pitch                a transposer, an octave either way; off by default
  -> boost                TS style, 4x + ADAA
  -> amp                  the NAM capture, NeuralAmpModelerCore
  -> capture trim         measured offline, so captures match each other
  -> cabinet              synthesised minimum-phase IR, zero-latency convolution
  -> four-band correction the Web Audio biquad formulas, exactly
  -> reverb, in parallel  computed only while audible
  -> looper               records what leaves the rig, plays it back under it
  -> master
  -> limiter              always on, no control anywhere; then the meter frame
```

**Nothing in the chain adds latency of its own.** `npm run test:chain` asserts
it with an impulse and `npm run measure:latency` prints it: zero frames for the
chain — the convolvers are a direct-form head plus a partitioned tail whose own
delay is exactly the head's length — and 4.6 frames (0.1 ms) inside the boost's
oversampler. What is left is the host's buffer: the browser's render quantum
and output device, which the figure at the top right reports and hover
explains — or, under Tonecraft Engine, the ASIO buffer.

**Except the transposer, which is the one stage that delays anything, and only
while it is switched on.** Shifting a note means waiting for its waveform to
come round again: measured, 8.6 ms an octave down, 14.1 ms an octave up, and
nothing at all at no shift. It ships bypassed, it costs no CPU while it is, and
what it adds goes into the figure on screen rather than into the player's
suspicion that the amp is slow.

**The looper is at the end of it**, so a part is recorded with the amplifier,
the cabinet and the reverb already on it, and stays as it was played while the
capture, the preset and the boost move on underneath. One button does record,
play and overdub — the **L** key too, because both hands are usually on the
guitar — and the metronome, added after the limiter, is never printed into a
loop.

**One chain, two hosts.** The browser's worklet and Tonecraft Engine run the
same `chain.wasm`, and neither contains a line of DSP: they move samples and
forward calls from `engine/engine.ts`. A feature therefore cannot exist in one
and be missing from the other, and `npm run test:parity` holds them to the bit —
the same calls through V8 and through wasmtime give identical output.
The whole chain costs 157 µs per 128-frame block in the browser and 171 µs
under wasmtime (`npm run bench`, Ryzen 9850X3D): about 6% of one core.

**The output follows the input.** With an interface open, the sound comes out
of that interface — where the headphones are — rather than the browser's
default device, and the choice is offered in the Out module. One clock in and
out, so nothing drifts and nothing is resampled to hide the drift. Firefox
cannot choose an output and keeps the default.

**A capture is a frozen snapshot of one amplifier at one setting.** Its gain,
its channel and its own EQ are baked into the file and cannot be driven. What is
set here is what we send into it and what we do with what comes back — which is
why the capture and the cabinet, not any fader, are the two real tone choices.

**The cabinet is not optional.** These captures are of the amplifier alone:
measured, they are still +5 dB at 7 kHz, where a capture including a cabinet
would be 25 dB down. Without one the result is not an amp sound.

## Layout

```
schema/   parameter definitions and the chain's ABI — depends on nothing
dsp/      the chain, in C++: every stage, and the flat tc_* interface
engine/   what the product does with the chain, and its two hosts
app/      the Svelte island — never touches the audio graph directly
site/     Astro pages (this is Astro's srcDir)
render/   measurement tools; the offline renderer is not rebuilt yet
public/   the chain, its one worklet, and the captures, served as-is
service/  Tonecraft Engine: the native host, for ASIO (Rust, GPLv3)
scripts/  vendoring, calibration, measurement, checks
```

Dependencies point one way only:

```
schema ──> engine ──> app ──> site
              └──> render
```

## What is in this repository that is binary

One file: `public/dsp/chain.wasm`, `dsp/` and NeuralAmpModelerCore at a pinned
tag, compiled by `scripts/build-dsp.mjs` with SIMD. Committing it is what makes
a clean checkout deployable without a C++ toolchain and without CI needing
network access beyond npm — and it is the file Tonecraft Engine is tested
against.

The NAM core is built rather than vendored because the prebuilt package was
scalar: 352 µs per 128-frame block vendored, 122 µs built with SIMD, identical
output to -115 dB. The CPU budget is the dropout budget, and that factor is the
difference between a chain that fits a weak laptop and one that crackles on
it.

## Tonecraft Engine (ASIO)

`service/` is the native host: Rust, cpal for the devices, wasmtime for the
chain, a WebSocket on the loopback address for the page. On the player's
machine it is an icon by the clock and nothing more — it starts minimized, a
click opens Tonecraft, and its menu only offers to open Tonecraft, to start
with the computer, or to quit. The interface, the buffer and the headphone
level are all set from Tonecraft's settings; the engine keeps them. It is optional — the
browser path is complete without it — and it is not a server: it runs on the
player's machine, listens on 127.0.0.1 only, and refuses any page whose origin
is not Tonecraft's. `service/README.md` covers building, installing and the
latency design; `service/PROTOCOL.md` the protocol.

Releases are built by `.github/workflows/engine.yml` when a tag `engine-v*` is
pushed, with asset names that never change, so the settings sheet links to
`releases/latest/download/…` and always offers the newest.

## Licences

- The application — yours to do as you like with.
- **The NAM engine** —
  [NeuralAmpModelerCore](https://github.com/sdatkinson/NeuralAmpModelerCore),
  MIT, © Steven Atkinson, compiled here. See `public/dsp/nam-core-LICENSE.txt`.
- **Tonecraft Engine** (`service/`) — **GNU GPL v3**, because the Steinberg
  ASIO SDK it links is freely redistributable only under the GPL v3. See
  `service/LICENSE`.
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
