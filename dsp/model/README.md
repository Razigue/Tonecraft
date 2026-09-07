# `dsp/model/` — the amplifier

`wavenet.h` is NAM's Standard WaveNet, run as inference. Its header comment
carries the reasoning, the measurements and the reason this is ours rather than
a build of NeuralAmpModelerCore.

`bindings.cpp` is the flat C surface the worklet instantiates: static buffers
exported as pointers, no malloc, no runtime, no imports.

`params.generated.h` is written from `schema/params.ts` by
`scripts/generate-model-header.ts` and is neither edited nor committed. A bound
that disagreed between the converter and the kernel would not fail the build —
it would write a blob the kernel reads with the wrong shape.

Everything else — how to build it, how to check it, why `.nam` never reaches
it — is in `../README.md`.
