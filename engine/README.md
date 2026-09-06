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
  -> master + limiter                 WaveShaper, no added latency
  -> public/nam/output-worklet.js     pass-through: peak, RMS, dropouts
```

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
