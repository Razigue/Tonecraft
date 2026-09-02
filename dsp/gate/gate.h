// The noise gate, at the head of the chain.
//
// Structural rather than a comfort. A high-gain amplifier multiplies
// everything, including the hum a single-coil picks up from a laptop screen and
// the fan two feet away. Without a gate the product is unusable in the room the
// player is actually in — which is the room scene A happens in.
//
// Everything about its timing is fixed. FR-11's Gate row exposes a threshold
// and nothing else: a player should not have to know what a gate release is to
// make high gain usable, and a release control is the first thing that gets set
// wrong and blamed on the amp.
//
// It sits before the drive and outside the oversampling window (AD-2). A gate
// is a time-varying gain, not a non-linearity that generates harmonics, so
// running it at 4x would be four times the cost for nothing.

#pragma once

#include <cmath>
#include <cstdint>

#include "params.generated.h"

namespace tonecraft {

class Gate {
 public:
  /// Opens in a millisecond: fast enough that no pick attack is clipped off
  /// the front of a note.
  static constexpr float kAttackMs = 1.0f;

  /// Holds open for a third of a second after the signal drops. Without this,
  /// the tail of a sustained note gets chopped the moment it crosses the
  /// threshold on the way down — the single most common way a gate ruins a
  /// lead line.
  static constexpr float kHoldMs = 320.0f;

  /// Then closes slowly, so the noise floor fades rather than switching off.
  static constexpr float kReleaseMs = 260.0f;

  /// Hysteresis. The level that closes the gate sits below the level that
  /// opens it, so a signal sitting exactly at the threshold cannot chatter.
  static constexpr float kHysteresisDb = 6.0f;

  /// Envelope follower time constant. Short enough to catch a pick attack,
  /// long enough not to track individual cycles of a low E.
  static constexpr float kDetectorMs = 2.0f;

  void reset() {
    attack_ = coefficient(kAttackMs);
    release_ = coefficient(kReleaseMs);
    detector_ = coefficient(kDetectorMs);
    hysteresis_ = std::pow(10.0f, -kHysteresisDb * 0.05f);
    holdSamples_ = static_cast<uint32_t>(kHoldMs * kInternalSampleRate * 0.001f);
    envelope_ = 0.0f;
    gain_ = 0.0f;
    held_ = 0;
  }

  /// Threshold in linear amplitude, already smoothed by the worklet boundary
  /// (AD-20). The stage adds no smoothing of its own.
  ///
  /// Only meaningful after reset(): the hysteresis ratio is established there.
  /// It cannot be a static initialiser, because a standalone WASM module runs
  /// static constructors only if the loader calls `_initialize`, and nothing in
  /// this build may depend on that. See scripts/check-static-init.sh.
  void setThreshold(float linear) {
    openAt_ = linear;
    closeAt_ = linear * hysteresis_;
  }

  void process(const float* in, float* out, uint32_t frames) {
    for (uint32_t i = 0; i < frames; ++i) {
      const float x = in[i];
      const float magnitude = std::fabs(x);

      envelope_ = magnitude > envelope_
                      ? magnitude
                      : detector_ * (envelope_ - magnitude) + magnitude;

      if (envelope_ >= openAt_) {
        held_ = holdSamples_;
      } else if (envelope_ < closeAt_ && held_ > 0) {
        --held_;
      }

      const float target = (envelope_ >= closeAt_ || held_ > 0) ? 1.0f : 0.0f;
      const float coefficient = target > gain_ ? attack_ : release_;
      gain_ = coefficient * (gain_ - target) + target;

      out[i] = x * gain_;
    }
  }

  /// How open the gate is, 0 to 1. Drives the cord: between the input and the
  /// gate the strand is grey when the gate is closed (DESIGN.md section 5).
  float openness() const { return gain_; }

 private:
  static float coefficient(float milliseconds) {
    return std::exp(-1.0f / (milliseconds * kInternalSampleRate * 0.001f));
  }

  float hysteresis_ = 0.0f;
  float attack_ = 0.0f;
  float release_ = 0.0f;
  float detector_ = 0.0f;
  float openAt_ = 0.0f;
  float closeAt_ = 0.0f;
  float envelope_ = 0.0f;
  float gain_ = 0.0f;
  uint32_t holdSamples_ = 0;
  uint32_t held_ = 0;
};

}  // namespace tonecraft
