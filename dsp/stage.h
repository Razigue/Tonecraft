// The contract every DSP stage obeys (AD-19).
//
// A stage is a plain struct with a `process` method. There is no base class and
// no virtual dispatch: a virtual call per block is cheap, but it defeats
// inlining across the chain and the CPU budget here is the dropout budget.
//
//     void process(const float* in, float* out, uint32_t frames);
//
// - mono `float32`, always
// - never in place: `in` and `out` never alias
// - `frames` is kBlockFrames outside the oversampling window, and
//   kOversampledBlockFrames inside it — a stage must not assume it is constant
// - no allocation, no I/O, no logging, ever (AD-13)
// - a stage never stores a pointer it was passed
// - a stage receives an already-smoothed parameter value and adds no smoothing
//   of its own (AD-20)
// - a stage may not read the device sample rate and has no rate parameter: it
//   is designed for kInternalSampleRate and nothing else (AD-18)
//
// The concept below turns those first two rules into a compile error rather
// than a convention someone can forget.

#pragma once

#include <concepts>
#include <cstdint>

namespace tonecraft {

template <typename T>
concept Stage = requires(T stage, const float* in, float* out, uint32_t frames) {
  { stage.process(in, out, frames) } -> std::same_as<void>;
  { stage.reset() } -> std::same_as<void>;
};

}  // namespace tonecraft
