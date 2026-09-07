# `engine/` — the chain, the captures, the meters

**Depends on `schema/`.**

Builds the audio graph on the main thread, opens the input, hands the WASM bytes
and the capture to the worklets, and reads metering back.

```
source (live DI or an audio file)
  -> public/nam/frontend-worklet.js   channel choice, trim, gate, TS boost (4x + ADAA)
  -> public/nam/nam-processor.js      the capture — dsp/model/ in WASM
  -> capture trim                     measured offline, so captures match each other
  -> cabinet                          ConvolverNode, IR synthesised in ir.ts
  -> four-band correction             native biquads, post-cabinet
  -> reverb, in parallel
  -> master + limiter                 WaveShaper, no added latency
  -> public/nam/output-worklet.js     pass-through: peak, RMS, dropouts
```

The worklets live in `public/` because an AudioWorklet module is loaded by URL
and evaluated in its own global scope; they are plain JS and go out untouched.
`nam-processor.js` instantiates `public/nam/wavenet.wasm` itself from bytes the
main thread hands over — a standalone module with no imports and no runtime, so
there is no glue file and no order to get wrong.

The capture crosses as a `.tcnm` blob, not as the `.nam` it came from: the JSON
is parsed once at vendor time by `scripts/nam-to-tcnm.ts`, which is both seven
times less to download and the moment a capture whose shape the kernel does not
implement gets refused, with someone watching.

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
