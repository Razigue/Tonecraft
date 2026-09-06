# `dsp/model/` — the amplifier

One file. `wavenet.h` is NAM's Standard WaveNet, run as inference, and its
header comment carries the reasoning and the measurements.

**It does not read `.nam` files.** A `.nam` is JSON, and parsing JSON needs an
allocator, a string parser and exceptions — none of which this module has, and
none of which it should acquire to read a file once at startup.
`scripts/nam-to-tcnm.ts` does that at build time and writes a flat `.tcnm` blob:

```
npm run model:convert -- some-model.nam public/models/lead.tcnm
```

The converter refuses anything that is not a Standard model, by name. Every A2
feature — FiLM conditioning, gating, bottlenecks, grouped convolutions, a nested
condition DSP — is a shape this kernel does not implement, and a model read with
the wrong shape does not fail, it plays wrong.

## Checking it against NAM

`../tests/wavenet.test.cpp` renders the committed fixture and compares it to a
vector produced by NeuralAmpModelerCore itself. It currently agrees to 99.5 dB,
where a transposed weight matrix scores -5 dB and a reversed convolution tap
scores -2 dB.

Regenerating the fixture needs a checkout of NeuralAmpModelerCore and the
renderer that produced it; the golden file is committed precisely so that the
everyday test run does not.

## What this replaced

`dsp/amp/faust/` — a hand-tuned cascade of four preamp stages, a tone stack and
a power stage. It is still what `chain.cpp` calls; wiring this in and deleting
it is the next change, not this one.
