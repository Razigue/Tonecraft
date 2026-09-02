// Half-band filters for 2x up- and downsampling.
//
// A half-band lowpass has its cutoff exactly at a quarter of the sample rate,
// and that symmetry makes every other coefficient zero. Decomposed into
// polyphase branches, one branch collapses to a pure delay and the other
// carries all the work — so 2x conversion costs roughly a quarter of what a
// general resampler would. That is what makes 4x oversampling around the
// non-linear stages affordable at all (FR-16, AD-2).
//
// Coefficients are computed at init from the tap count, so the same build
// produces the same filter on every machine (AD-4). Nothing here is tabulated
// by hand.

#pragma once

#include <cmath>
#include <cstdint>

namespace tonecraft {

/// 23 taps: 12 multiply-accumulates per input sample per stage, a stopband
/// deep enough that what it leaves behind sits under a guitar amp's own noise,
/// and a group delay of 11 samples at the stage's own rate. Two stages up and
/// two down come to roughly 0.34 ms round trip at 48 kHz — the price of
/// oversampling is paid in dropouts, not in latency.
inline constexpr uint32_t kHalfBandTaps = 23;
inline constexpr uint32_t kHalfBandCenter = (kHalfBandTaps - 1) / 2;
/// The branch that does the work: every coefficient at an even index. The odd
/// indices are all zero except the centre tap, which is exactly why a half-band
/// is cheap.
inline constexpr uint32_t kHalfBandBranch = (kHalfBandTaps + 1) / 2;

/// Where the pure-delay branch reads from. Upsampling delays by (c-1)/2 input
/// samples; downsampling reads the odd phase at (c+1)/2.
inline constexpr uint32_t kHalfBandUpDelay = (kHalfBandCenter - 1) / 2;
inline constexpr uint32_t kHalfBandDownDelay = (kHalfBandCenter + 1) / 2;

/// Shared coefficient design. A windowed sinc at a quarter of the rate, which
/// is what makes the alternate coefficients vanish.
class HalfBandKernel {
 public:
  void init() {
    double sum = 0.0;
    for (uint32_t i = 0; i < kHalfBandBranch; ++i) {
      const int32_t n = static_cast<int32_t>(2 * i) - static_cast<int32_t>(kHalfBandCenter);
      const double x = static_cast<double>(n) * 0.5;
      const double s = (x == 0.0) ? 1.0 : std::sin(3.14159265358979323846 * x) /
                                              (3.14159265358979323846 * x);
      const double t = static_cast<double>(2 * i) / static_cast<double>(kHalfBandTaps - 1);
      // Blackman-Harris: deeper stopband than Blackman for the same length,
      // which matters because whatever this leaves through comes back as
      // aliasing after the non-linearity.
      const double w = 0.35875 - 0.48829 * std::cos(6.28318530717958647692 * t) +
                       0.14128 * std::cos(2.0 * 6.28318530717958647692 * t) -
                       0.01168 * std::cos(3.0 * 6.28318530717958647692 * t);
      taps[i] = static_cast<float>(0.5 * s * w);
      sum += 0.5 * s * w;
    }
    // Unity gain at DC across both branches: the delay branch contributes 0.5.
    const double correction = 0.5 / sum;
    for (uint32_t i = 0; i < kHalfBandBranch; ++i) {
      taps[i] = static_cast<float>(static_cast<double>(taps[i]) * correction);
    }
  }

  float taps[kHalfBandBranch]{};
};

/// 1x in, 2x out.
class HalfBandUp {
 public:
  void init(const HalfBandKernel* kernel) {
    kernel_ = kernel;
    reset();
  }

  void reset() {
    for (uint32_t i = 0; i < kHalfBandBranch; ++i) history_[i] = 0.0f;
  }

  /// Writes 2 * `frames` samples.
  void process(const float* in, float* out, uint32_t frames) {
    for (uint32_t n = 0; n < frames; ++n) {
      // Shift in. A ring buffer would avoid the copy, but at 12 floats the
      // move stays in cache and the straight-line version vectorises better.
      for (uint32_t i = kHalfBandBranch - 1; i > 0; --i) history_[i] = history_[i - 1];
      history_[0] = in[n];

      float filtered = 0.0f;
      for (uint32_t i = 0; i < kHalfBandBranch; ++i) {
        filtered += history_[i] * kernel_->taps[i];
      }

      // Zero-stuffing then filtering means the even output falls entirely on
      // the even-index taps, and the odd output on the centre tap alone. The
      // upsampling gain of two cancels that centre tap's 0.5, so one of the two
      // output samples is a plain delayed copy and costs nothing.
      out[2 * n] = 2.0f * filtered;
      out[2 * n + 1] = history_[kHalfBandUpDelay];
    }
  }

 private:
  const HalfBandKernel* kernel_ = nullptr;
  float history_[kHalfBandBranch]{};
};

/// 2x in, 1x out.
class HalfBandDown {
 public:
  void init(const HalfBandKernel* kernel) {
    kernel_ = kernel;
    reset();
  }

  void reset() {
    for (uint32_t i = 0; i < kHalfBandBranch; ++i) even_[i] = 0.0f;
    for (uint32_t i = 0; i < kHalfBandBranch; ++i) odd_[i] = 0.0f;
  }

  /// Reads 2 * `frames` samples and writes `frames`.
  void process(const float* in, float* out, uint32_t frames) {
    for (uint32_t n = 0; n < frames; ++n) {
      for (uint32_t i = kHalfBandBranch - 1; i > 0; --i) {
        even_[i] = even_[i - 1];
        odd_[i] = odd_[i - 1];
      }
      even_[0] = in[2 * n];
      odd_[0] = in[2 * n + 1];

      // Mirror of the upsampler: the even-index taps act on the even phase,
      // and the centre tap alone on the odd phase.
      float filtered = 0.0f;
      for (uint32_t i = 0; i < kHalfBandBranch; ++i) {
        filtered += even_[i] * kernel_->taps[i];
      }
      out[n] = filtered + 0.5f * odd_[kHalfBandDownDelay];
    }
  }

 private:
  const HalfBandKernel* kernel_ = nullptr;
  float even_[kHalfBandBranch]{};
  float odd_[kHalfBandBranch]{};
};

}  // namespace tonecraft
