// The 4x oversampling window (FR-16, AD-2).
//
// One contiguous region of the chain runs at four times the internal rate:
// the drive waveshaper and the neural amp, and nothing else. The gate, the
// cab, the reverb and the limiter are linear or already band-limited — they do
// not alias, and running them at 4x would be five times the cost for nothing.
//
// One upsampler in, one downsampler out. That the two non-linear stages are
// adjacent is what makes this possible: a chain that interleaved a linear
// stage between them would need two windows, two upsamplers and two
// downsamplers, and the CPU budget has no room for that. It is also why no
// future reordering feature may separate them.

#pragma once

#include <cstdint>

#include "halfband.h"
#include "params.generated.h"

namespace tonecraft {

class OversampleWindow {
 public:
  static_assert(kOversampleFactor == 4, "this window is built from two 2x stages");

  void init() {
    kernel_.init();
    up1_.init(&kernel_);
    up2_.init(&kernel_);
    down1_.init(&kernel_);
    down2_.init(&kernel_);
    reset();
  }

  void reset() {
    up1_.reset();
    up2_.reset();
    down1_.reset();
    down2_.reset();
  }

  /// Group delay of the whole round trip, in samples at the base rate.
  /// Reported rather than absorbed: the player's round trip should be the
  /// truth, and this is part of it (FR-35).
  static constexpr float latencySamples() {
    // A symmetric FIR of length L delays by (L - 1) / 2 samples at the rate it
    // runs — kHalfBandCenter here. Converting each stage's delay to base-rate
    // samples: the two outer stages run at 2x and the two inner ones at 4x.
    constexpr float d = static_cast<float>(kHalfBandCenter);
    return d * (0.5f + 0.25f + 0.25f + 0.5f);
  }

  /// Runs `body` at 4x. `in` and `out` hold `frames` samples at the base rate.
  template <typename Body>
  void process(const float* in, float* out, uint32_t frames, Body&& body) {
    up1_.process(in, stage2x_, frames);
    up2_.process(stage2x_, stage4x_, frames * 2);

    body(stage4x_, stage4xOut_, frames * kOversampleFactor);

    down1_.process(stage4xOut_, stage2xOut_, frames * 2);
    down2_.process(stage2xOut_, out, frames);
  }

 private:
  HalfBandKernel kernel_;
  HalfBandUp up1_;
  HalfBandUp up2_;
  HalfBandDown down1_;
  HalfBandDown down2_;

  // Static, sized for the largest block the chain can be handed (AD-13).
  alignas(16) float stage2x_[kBlockFrames * 2]{};
  alignas(16) float stage4x_[kBlockFrames * 4]{};
  alignas(16) float stage4xOut_[kBlockFrames * 4]{};
  alignas(16) float stage2xOut_[kBlockFrames * 2]{};
};

}  // namespace tonecraft
