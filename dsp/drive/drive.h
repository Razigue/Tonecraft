// The boost in front of the amplifier.
//
// Not a second distortion for its own sake. Measured against a commercial
// plugin on the same DI, the amplifier alone was 12 to 35 dB short above 1.6
// kHz with both cabinets bypassed, and the gap could not be closed with amp
// gain: past about 20 dB of drive the cascade stops responding to the pick.
// The band has to be made without spending the dynamics on it, and that is
// exactly what a boost in front of a high-gain amp is for.
//
// The trick is what gets clipped, not how much. A screamer does not highpass
// the signal — it *emphasises* the mids and highs and clips the result, so the
// low end passes at unity and never sees the non-linearity. Clipping a full low
// end is what turns bass to mud; leaving it out of the clipped path is what
// makes a boosted amp tight rather than thin.
//
//     driven  = x + (emphasis - 1) * highpass(x)   unity at DC, boosted above
//     clipped = saturate(gain * driven)
//     out     = lowpass(clipped, tone) * level
//
// It sits inside the 4x window with the amp (AD-2). That the two non-linear
// stages are adjacent is what lets one window serve both: the resampling is
// already paid for, so this stage costs only its own arithmetic.

#pragma once

#include <cmath>
#include <cstdint>

#include "params.generated.h"

namespace tonecraft {

class Drive {
 public:
  /// Where the emphasis starts. A boost's whole character is here: below this
  /// the signal passes untouched and stays tight, above it the clipper works.
  /// 720 Hz is low enough to include the body of a note and high enough to
  /// leave the fundamental of the lowest string — 73 Hz in D standard — out of
  /// the clipped path entirely.
  static constexpr float kEmphasisHz = 720.0f;

  /// How much the emphasised band is lifted before clipping, as a ratio. This
  /// is not the gain control: it sets the *shape* the clipper sees, and the
  /// player's gain multiplies it afterwards.
  static constexpr float kEmphasis = 6.0f;

  /// This stage lives inside the oversampling window, so its coefficients are
  /// designed for four times the chain rate (AD-19). Designing them at the
  /// chain rate would put every corner four times too high — silent as a bug,
  /// devastating as a sound.
  void reset() {
    emphasis_ = coefficient(kEmphasisHz);
    highpassX_ = 0.0f;
    highpassY_ = 0.0f;
    toneY_ = 0.0f;
    setTone(2200.0f);
  }

  /// Already smoothed at the worklet boundary (AD-20).
  void setGain(float linear) { gain_ = linear; }
  void setLevel(float linear) { level_ = linear; }

  /// Cutoff of the post-clip lowpass, in Hz — the control a screamer actually
  /// offers. Clipping generates harmonics far above anything musical, and this
  /// is what decides how much of that reaches the amplifier.
  void setTone(float hz) { tone_ = 1.0f - coefficient(hz); }

  void process(const float* in, float* out, uint32_t frames) {
    for (uint32_t i = 0; i < frames; ++i) {
      const float x = in[i];

      // One-pole highpass. The emphasised path only.
      highpassY_ = emphasis_ * (highpassY_ + x - highpassX_);
      highpassX_ = x;

      const float driven = x + (kEmphasis - 1.0f) * highpassY_;

      // The same curve as the amplifier's stages, for the same measured
      // reason: a softer one rounds the wave instead of enriching it, and
      // rounding is what this stage exists not to do.
      const float driveIn = gain_ * driven;
      const float squared = driveIn * driveIn;
      const float clipped = driveIn / std::sqrt(std::sqrt(1.0f + squared * squared));

      toneY_ += tone_ * (clipped - toneY_);
      out[i] = toneY_ * level_;
    }
  }

 private:
  /// One-pole coefficient for a corner frequency, at the rate this stage runs
  /// at. Evaluated at init only — process() does no transcendental work.
  static float coefficient(float hz) {
    return std::exp(-2.0f * 3.14159265358979323846f * hz /
                    static_cast<float>(kOversampledSampleRate));
  }

  float emphasis_ = 0.0f;
  float highpassX_ = 0.0f;
  float highpassY_ = 0.0f;
  float tone_ = 0.0f;
  float toneY_ = 0.0f;
  float gain_ = 1.0f;
  float level_ = 1.0f;
};

}  // namespace tonecraft
