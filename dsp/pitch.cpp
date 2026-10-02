#include "pitch.h"
#include <algorithm>
#include <cmath>

namespace tc {
void Pitch::init(double sampleRate) {
  engine_.setEnabled(false);
  params_ = {};
  engine_.setParams(params_);
  engine_.prepare(sampleRate);
  mix_.init(0.012, sampleRate, 0.0);
}
void Pitch::setShift(double semitones) {
  params_.semitones = static_cast<float>(std::clamp(semitones, -12.0, 12.0));
  engine_.setParams(params_);
}
void Pitch::setWet(double wet) {
  mix_.set(std::clamp(wet, 0.0, 1.0));
  engine_.setEnabled(wet > 0.0 && std::abs(params_.semitones) > 1e-6f);
}
void Pitch::process(const double* in, double* out, int n) {
  // Chunking keeps this adapter safe for any host block size, with no audio
  // thread allocation. The frontend normally supplies at most 128 samples.
  for (int base = 0; base < n; base += 128) {
    const int count = std::min(128, n - base);
    if (!engine_.isRunning()) {
      for (int i = 0; i < count; ++i) {
        mix_.tick();
        out[base + i] = in[base + i];
      }
      continue;
    }
    for (int i = 0; i < count; ++i) scratch_[i] = static_cast<float>(in[base + i]);
    engine_.process(scratch_, count);
    for (int i = 0; i < count; ++i) {
      const double dry = in[base + i];
      out[base + i] = dry + mix_.tick() * (scratch_[i] - dry);
    }
  }
}
double Pitch::delayFrames() const {
  return engine_.isRunning() ? engine_.latencySamples() : 0.0;
}
} // namespace tc
