// What calibration needs to know about the input signal.
//
// Level and bandwidth, measured on the raw input before anything touches it.
// Together with the device label and the measured round trip, these are enough
// to recognise a guitar plugged into a laptop's microphone input — the failure
// the user cannot diagnose and will blame on the engine (FR-11).
//
// No `AnalyserNode` and no FFT. The product has neither, by decision: the whole
// visualisation layer is the cord, and an analyser would be a second audio
// graph paid for continuously to answer a question asked once. A single
// one-pole highpass answers "are the highs missing" well enough to tell a
// pickup on a 1 MΩ input from one on a few kΩ, and costs two multiplies per
// sample.

#pragma once

#include <cmath>
#include <cstdint>

#include "params.generated.h"

namespace tonecraft {

class InputProbe {
 public:
  /// Corner of the highpass used to judge brightness. Above the fundamental
  /// range of a guitar's top string, so what passes is overtones — exactly what
  /// an impedance mismatch eats first.
  static constexpr float kBrightnessHz = 2000.0f;

  /// How long a peak is held before it decays, in seconds. Long enough that a
  /// player strumming once every second sees a stable reading.
  static constexpr float kPeakHoldSeconds = 1.5f;

  void reset() {
    const float w = 6.28318530717958647692f * kBrightnessHz / kInternalSampleRate;
    // One-pole highpass: y = a * (y_prev + x - x_prev).
    highpass_ = 1.0f / (1.0f + w);
    peakDecay_ = std::exp(-1.0f / (kPeakHoldSeconds * kInternalSampleRate));
    lastIn_ = 0.0f;
    lastOut_ = 0.0f;
    peak_ = 0.0f;
    total_ = 0.0f;
    bright_ = 0.0f;
    counted_ = 0;
  }

  void process(const float* in, uint32_t frames) {
    for (uint32_t i = 0; i < frames; ++i) {
      const float x = in[i];

      lastOut_ = highpass_ * (lastOut_ + x - lastIn_);
      lastIn_ = x;

      total_ += x * x;
      bright_ += lastOut_ * lastOut_;

      const float magnitude = std::fabs(x);
      peak_ = magnitude > peak_ ? magnitude : peak_ * peakDecay_;
    }
    counted_ += frames;
  }

  /// Highest amplitude seen recently, 0 to 1. Too low means the player will
  /// turn everything up and amplify their noise floor with it.
  float peak() const { return peak_; }

  /// Share of energy above the brightness corner, 0 to 1. A guitar on a proper
  /// instrument input sits well above a guitar on a microphone input, which has
  /// had its overtones loaded away by an impedance it was never meant to see.
  float brightness() const {
    return total_ > 1e-12f ? std::sqrt(bright_ / total_) : 0.0f;
  }

  /// Frames measured since the last clear — calibration needs to know it has
  /// heard enough before it says anything.
  uint32_t counted() const { return counted_; }

  /// Starts a fresh measurement. The peak is cleared too: the hold exists so a
  /// player strumming once a second sees a stable reading, not so a previous
  /// measurement can leak into the next one.
  void clear() {
    total_ = 0.0f;
    bright_ = 0.0f;
    peak_ = 0.0f;
    counted_ = 0;
  }

 private:
  float highpass_ = 0.0f;
  float peakDecay_ = 0.0f;
  float lastIn_ = 0.0f;
  float lastOut_ = 0.0f;
  float peak_ = 0.0f;
  float total_ = 0.0f;
  float bright_ = 0.0f;
  uint32_t counted_ = 0;
};

}  // namespace tonecraft
