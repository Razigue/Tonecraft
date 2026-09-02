# `dsp/` — the C++ signal stages

**Depends on `schema/` only.** Never imports TypeScript.

One module per stage, each with a flat C interface. A stage is:

```c
void process(const float* in, float* out, uint32_t frames);
```

Mono `float32`, never in place, buffers never aliasing. `frames` is 128 outside
the oversampling window and 512 inside it (AD-19).

A stage never allocates, never stores a pointer it was passed, never logs, and
never throws — compiled `-fno-exceptions -fno-rtti`, failures are resolved at
init and reported as status codes (AD-13). A stage receives already-smoothed
parameter values and adds no smoothing of its own (AD-20). A stage may not read
the device sample rate and has no rate parameter: everything runs at the fixed
internal 48 kHz design rate (AD-18).

`chain.cpp` is the only file that knows the stage order.

Arrives in story 1.3.
