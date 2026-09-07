# `engine/` — the chain, the captures, the meters

**Depends on `schema/`.**

Builds the audio graph on the main thread, opens the input, hands the WASM bytes
and the capture to the worklets, and reads metering back.

```
source (live DI or an audio file)
  -> public/nam/frontend-worklet.js   channel choice, trim, gate, TS boost (4x + ADAA)
  -> public/nam/nam-processor.js      the capture — NeuralAmpModelerCore in WASM
  -> capture trim                     measured offline, so captures match each other
  -> cabinet                          ConvolverNode, IR synthesised in ir.ts
  -> four-band correction             native biquads, post-cabinet
  -> reverb, in parallel
  -> master
  -> public/nam/output-worklet.js     the limiter, then peak, RMS, dropouts
```

The limiter is in the output worklet rather than in a `WaveShaperNode` because
a WaveShaperNode at 4x delays the signal by 192 frames in Chromium — 4 ms at
48 kHz, measured by `scripts/measure-latency.mjs`. Inside the worklet it runs
sample by sample at zero latency; the residual above the knee goes through
antiderivative anti-aliasing, and below the knee the stage is exactly
transparent.

The reverb is connected only while its mix is above zero. A `ConvolverNode`
with a live input renders its whole 1.3 s tail on every quantum whether or
not anything listens; disconnected, the browser lets it finish its tail and
then stops calling it.

The output device follows the input's hardware (`groupId`) unless the player
chose one: the headphones are in the interface, and one clock in and out
means no drift and no resampling to hide it. `Engine.canChooseOutput` is false
on Firefox, which has no `setSinkId` on AudioContext; nothing is offered or
said there.

The worklets live in `public/` because an AudioWorklet module is loaded by URL
and evaluated in its own global scope; they are plain JS and go out untouched.
The order they are added in matters: `nam-glue.js` publishes `createNamModule`
on the worklet's globalThis and `nam-processor.js` reads it from there.

`ir.ts` synthesises both impulse responses — no `.wav` to download, and a
minimum-phase cabinet, which is the most compact transient response a given
magnitude admits. Without a cabinet these captures are not an amp sound: they
are captures of the amplifier alone and still +5 dB at 7 kHz.

Continuous parameters cross as `AudioParam` values so they interpolate
sample-accurately (AD-20). `postMessage` carries only discrete changes — a
capture, a channel, a bypass — and the metering return. Metering is one-way and
lossy-tolerant: a dropped frame must never affect audio, state or correctness
(AD-12).

`diagnosis.ts` turns measurements into sentences and nothing else. Every
function in it is pure, and no verdict it can return stops anyone playing.

**Nothing displays those sentences at the moment.** The rig used to carry a
permanent report at the foot of the page — the latency tier, the impedance
diagnosis, the dropout warning — and it was removed: on a healthy machine it
named the operating system's buffering on every frame, which is nagging rather
than informing. `engine.health` still computes all of it for whoever wants it
back, and `app/` deliberately reads `roundTripMs` instead, so the metering loop
does not run four verdicts thirty times a second for nobody.
