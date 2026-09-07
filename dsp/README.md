# `dsp/` — the amplifier, in C++

**Depends on `schema/` (for the generated bounds header).**

One module. `model/wavenet.h` is NAM's Standard WaveNet run as inference, and
its header comment carries the reasoning and the measurements.

```
npm run model:build      # dsp/build.sh -> public/nam/wavenet.wasm
npm run model:verify     # against NeuralAmpModelerCore's own output
npm run bench:model      # what it costs, as a share of one core
```

The build needs emsdk (`.toolchain/emsdk`, git-ignored). Nothing else does: the
8 kB artifact is committed, so a clean checkout tests, builds and deploys with
no toolchain at all. Run the build only when `dsp/` or the schema's model bounds
change.

## Why this is here at all

The product shipped a vendored build of NeuralAmpModelerCore
(`@opendaw/nam-wasm`) until 2026-09-07 and it was too slow: 58 to 75 % of one
core on the floor machine for the four captures we ship, against a 25 % budget
for the whole chain. That is not a latency problem — in an AudioWorklet the
quantum is fixed at 128 frames and there is no dial to trade — it is a dropout
problem, and dropouts are what make someone put the guitar down.

This kernel runs the same four at 31 to 43 %, and agrees with NAM core to
111-115 dB. The difference is one decision, `accumulateScaled`: Eigen blocks its
GEMM for cache, and at eight or sixteen channels there is no cache problem to
solve, only a horizontal reduction at the end of every dot product.

Compiler flags were tried first and do not close it. A build of NAM core with
`-O3 -msimd128 -flto` measured *slower* than the vendored `-Os` one.

## It does not read `.nam` files

A `.nam` is JSON, and parsing JSON needs an allocator, a string parser and
exceptions — none of which this module has, and none of which it should acquire
to read a file once at startup. `scripts/nam-to-tcnm.ts` does it at vendor time
and writes a flat blob:

```
npm run model:convert -- some-model.nam public/models/some-model.tcnm
```

The converter refuses anything that is not a Standard model, **by name**. Every
A2 feature — FiLM conditioning, gating, bottlenecks, grouped convolutions, a
nested condition DSP — is a shape this kernel does not implement, and a model
read with the wrong shape does not fail, it plays a different amplifier.

## Checking it

`npm run model:verify` renders three seconds of `public/di/demo-di.wav` through
each capture and compares the last 16 384 samples to `assets/golden/*.f32`,
which is what the vendored NAM core build produced from the same input. The
floor is 80 dB SNR and the current margin is 111. It is falsifiable: pointing a
golden vector at the wrong capture scores -6.6 dB.
