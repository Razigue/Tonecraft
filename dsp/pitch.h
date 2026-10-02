#pragma once
#include "smooth.h"
#include "tone3000/PitchShift.h"

namespace tc {
// Host adapter for TONE3000's shifter. The existing transpose and pitch-mix
// controls share this stage. Zero shift and bypass settle to a dry wire.
class Pitch {
 public:
  void init(double sampleRate);
  void setShift(double semitones);
  void setWet(double wet);
  void process(const double* in, double* out, int n);
  double delayFrames() const;
 private:
  tone3000::PitchShift engine_;
  tone3000::PitchShift::Params params_;
  Smoother mix_;
  float scratch_[128] = {};
};
} // namespace tc
