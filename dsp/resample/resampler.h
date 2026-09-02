// Sample-rate conversion at the chain boundary (AD-18).
//
// Every stage is designed for kInternalSampleRate and nothing else. A device at
// 44.1 or 96 kHz is converted here, on the way in and on the way out, so that
// no stage ever learns what rate the hardware runs at. This is not a
// convenience: an LSTM amp model is a rate-dependent non-linear system, and the
// same weights at 44.1 and at 48 kHz are audibly different amplifiers. Without
// this, two players with different interfaces would hear different things from
// the same tone link — the exact divergence NFR-9 exists to prevent, arriving
// through a door no other invariant watches.
//
// Windowed-sinc interpolation with a precomputed polyphase table. Deterministic
// by construction: the table is built from the two integer rates, so the same
// pair of rates always produces the same coefficients, on every machine.
//
// Not used at all when the device already runs at the internal rate. That is
// the common case, and it must cost exactly nothing — no filter, no buffering,
// no added latency, and output bit-identical to a build without this file.

#pragma once

#include <cmath>
#include <cstdint>

namespace tonecraft {

/// 24 taps, 256 phases: 24 kB of table, stopband deep enough that the
/// conversion is inaudible against a guitar amp's own noise floor.
inline constexpr uint32_t kResampleTaps = 24;
inline constexpr uint32_t kResamplePhases = 256;

class SincResampler {
 public:
  /// Builds the table. Called from tc_init and never from the audio path —
  /// this is where the transcendental work happens, once.
  void init(uint32_t inputRate, uint32_t outputRate) {
    ratio_ = static_cast<double>(inputRate) / static_cast<double>(outputRate);

    // Cut below the lower of the two Nyquist limits, with a margin for the
    // filter's transition band. Downsampling has to band-limit first or it
    // aliases; upsampling only has to reject the images.
    const double cutoff = 0.5 * (ratio_ > 1.0 ? 1.0 / ratio_ : 1.0) * 0.92;

    for (uint32_t phase = 0; phase < kResamplePhases; ++phase) {
      const double offset = static_cast<double>(phase) / kResamplePhases;
      double sum = 0.0;
      for (uint32_t tap = 0; tap < kResampleTaps; ++tap) {
        const double x =
            static_cast<double>(tap) - static_cast<double>(kResampleTaps / 2) + 1.0 - offset;
        const double s = sinc(2.0 * cutoff * x);
        // Blackman window: -58 dB sidelobes, which is what keeps images out.
        const double w = blackman(
            (x + static_cast<double>(kResampleTaps / 2)) / static_cast<double>(kResampleTaps));
        const double h = 2.0 * cutoff * s * w;
        table_[phase][tap] = static_cast<float>(h);
        sum += h;
      }
      // Normalise each phase to unity gain, so a constant input comes out
      // constant and the conversion adds no level ripple.
      if (sum != 0.0) {
        for (uint32_t tap = 0; tap < kResampleTaps; ++tap) {
          table_[phase][tap] = static_cast<float>(table_[phase][tap] / sum);
        }
      }
    }
    reset();
  }

  void reset() {
    for (uint32_t i = 0; i < kResampleTaps; ++i) history_[i] = 0.0f;
    position_ = 0.0;
  }

  /// The filter's own delay, in input frames. Reported so the round trip the
  /// player sees includes it rather than hiding it (FR-35).
  static constexpr uint32_t latencyFrames() { return kResampleTaps / 2; }

  /// Consumes `inputFrames` and writes as many output frames as the ratio
  /// yields, up to `maxOutput`. Returns how many it wrote. No allocation.
  uint32_t process(const float* input, uint32_t inputFrames, float* output,
                   uint32_t maxOutput) {
    uint32_t written = 0;

    while (written < maxOutput) {
      const double index = position_;
      const uint32_t whole = static_cast<uint32_t>(index);
      if (whole >= inputFrames) break;

      const double fraction = index - static_cast<double>(whole);
      const uint32_t phase =
          static_cast<uint32_t>(fraction * kResamplePhases) & (kResamplePhases - 1);
      const float* coefficients = table_[phase];

      float sum = 0.0f;
      for (uint32_t tap = 0; tap < kResampleTaps; ++tap) {
        // Samples before the start of this block come from the history the
        // previous call left behind, so blocks join seamlessly.
        const int32_t at = static_cast<int32_t>(whole) + static_cast<int32_t>(tap) -
                           static_cast<int32_t>(kResampleTaps) + 1;
        const float sample = at < 0
                                 ? history_[static_cast<uint32_t>(at + static_cast<int32_t>(kResampleTaps))]
                                 : input[at];
        sum += sample * coefficients[tap];
      }

      output[written++] = sum;
      position_ += ratio_;
    }

    // Carry the tail of this block into the next one.
    for (uint32_t i = 0; i < kResampleTaps; ++i) {
      const int32_t at = static_cast<int32_t>(inputFrames) - static_cast<int32_t>(kResampleTaps) +
                         static_cast<int32_t>(i);
      history_[i] = at < 0
                        ? history_[static_cast<uint32_t>(at + static_cast<int32_t>(kResampleTaps))]
                        : input[at];
    }
    position_ -= static_cast<double>(inputFrames);
    if (position_ < 0.0) position_ = 0.0;

    return written;
  }

 private:
  static double sinc(double x) {
    if (x == 0.0) return 1.0;
    const double pix = 3.14159265358979323846 * x;
    return std::sin(pix) / pix;
  }

  static double blackman(double t) {
    const double two_pi = 6.28318530717958647692;
    return 0.42 - 0.5 * std::cos(two_pi * t) + 0.08 * std::cos(2.0 * two_pi * t);
  }

  float table_[kResamplePhases][kResampleTaps]{};
  float history_[kResampleTaps]{};
  double ratio_ = 1.0;
  double position_ = 0.0;
};

static_assert((kResamplePhases & (kResamplePhases - 1)) == 0,
              "phase count must be a power of two — the phase index masks rather than divides");

}  // namespace tonecraft
