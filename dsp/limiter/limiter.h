// The output limiter. Always active, never exposed (FR-18, AD-13).
//
// This is not an effect and it is not a feature. A digital feedback loop in
// headphones can injure, and it can be caused by something as ordinary as a
// user routing output back into input. So the limiter exists before any audio
// reaches a human ear, and there is no code path in the product that disables
// it, in any mode, on any path.
//
// It works in two layers, deliberately:
//
//  1. A feedforward peak limiter with a fast attack and a slow release. This is
//     the musical layer: it holds peaks down without pumping and stays out of
//     the way at normal levels.
//  2. A hard clamp at the same ceiling, applied last, unconditionally. This is
//     the safety layer. Layer 1 is a smoothing filter and can, in principle, be
//     overshot by a step faster than its attack. Layer 2 cannot be overshot by
//     anything. It is what makes the guarantee absolute rather than probable.
//
// No lookahead. Lookahead would buy transparency at the price of latency in
// every session, forever, to improve behaviour in a situation that should never
// occur. The clamp is the better trade here.

#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>

#include "params.generated.h"

namespace tonecraft {

class Limiter {
 public:
  // -0.5 dBFS. Below full scale so that a converter's reconstruction filter,
  // which can overshoot between samples, still has somewhere to go.
  static constexpr float kCeiling = 0.944060876f;

  // 0.2 ms attack: fast enough that layer 2 almost never has work to do,
  // slow enough not to distort low frequencies by tracking the waveform.
  static constexpr float kAttackMs = 0.2f;

  // 80 ms release: long enough that repeated peaks do not pump.
  static constexpr float kReleaseMs = 80.0f;

  // No constructor, deliberately. A static object's constructor only runs if
  // the loader calls the module's `_initialize`, and a loader that forgets gets
  // zeroed coefficients and a degenerate envelope follower — silently, because
  // the limiter still limits. Every value this class needs is set in reset(),
  // which tc_init always calls. See dsp/bindings.cpp.
  void reset() {
    attack_ = coefficientFor(kAttackMs);
    release_ = coefficientFor(kReleaseMs);
    envelope_ = 0.0f;
  }

  void process(const float* in, float* out, uint32_t frames) {
    for (uint32_t i = 0; i < frames; ++i) {
      const float x = in[i];
      const float magnitude = std::fabs(x);

      // One-pole envelope follower, asymmetric: seize peaks, let go slowly.
      const float coefficient = magnitude > envelope_ ? attack_ : release_;
      envelope_ = coefficient * (envelope_ - magnitude) + magnitude;

      // Layer 1. Above the ceiling, scale back by exactly the excess.
      const float gain = envelope_ > kCeiling ? kCeiling / envelope_ : 1.0f;

      // Layer 2. Unconditional, and last. Nothing leaves above the ceiling.
      out[i] = std::clamp(x * gain, -kCeiling, kCeiling);
    }
  }

 private:
  // The one-pole coefficient for a time constant, from kInternalSampleRate and
  // never the device rate (AD-18). Evaluated twice per engine init, so there is
  // no reason to approximate it — process() itself does no transcendental work.
  static float coefficientFor(float milliseconds) {
    const float samples =
        milliseconds * static_cast<float>(kInternalSampleRate) * 0.001f;
    return std::exp(-1.0f / samples);
  }

  float attack_;
  float release_;
  float envelope_;
};

}  // namespace tonecraft
