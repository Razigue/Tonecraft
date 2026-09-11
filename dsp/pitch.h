/* =============================================================================
   dsp/pitch.h — the transposer, between the gate and the boost
   -----------------------------------------------------------------------------
   An octave either way, on a guitar, in real time. See pitch.cpp for how it
   works and what it costs; the short version is two read heads crawling
   through a delay line at the shifted speed, crossfaded, with each splice
   placed where the waveform repeats so the two copies add in phase instead of
   combing.

   It is the only stage in the chain that delays the signal, and only while it
   is engaged: bypassed, or set to no shift at all, it hands the input straight
   back and `delayFrames()` is zero. `tc_process` reports the delay in the
   meter frame so the interface can add it to the round trip it shows.
   ========================================================================== */
#pragma once

#include <cstdint>
#include <vector>

#include "smooth.h"

namespace tc {

/* RBJ lowpass, double, transposed direct form II. Two of these in series make
   the fourth-order anti-image filter an upward shift needs. */
struct LowPass {
  double b0 = 1.0, b1 = 0.0, b2 = 0.0, a1 = 0.0, a2 = 0.0, z1 = 0.0, z2 = 0.0;
  void design(double cutoff, double sampleRate, double q);
  double tick(double x) {
    const double y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    return y;
  }
};

class Pitch {
 public:
  void init(double sampleRate);

  /* Semitones, glided. Any value: the whole-semitone grid is the interface's. */
  void setShift(double semitones) { shift_.set(semitones); }
  /* 0..1, glided. The stage's bypass is folded in here by chain.cpp: a
     bypassed shifter is a wet level of zero, which fades out and then costs
     nothing at all. */
  void setWet(double wet) { wet_.set(wet); }

  /* n samples, in place-safe (in and out may be the same buffer). */
  void process(const double* in, double* out, int n);

  /* What the wet path is delaying by right now, in samples. Zero when silent. */
  double delayFrames() const;

 private:
  double read(double position) const;
  void splice(int tap, double ratio);
  int64_t align(int64_t reference, int64_t newest, int span);
  void start(double ratio);

  double sr_ = 48000.0;
  std::vector<float> buf_;
  int64_t mask_ = 0;
  /* Absolute write counter. It starts a whole buffer in, so the first reads
     land on zeros rather than on a negative index. */
  int64_t w_ = 0;

  Smoother shift_, wet_;
  LowPass lp1_, lp2_;
  double designedFor_ = 0.0;

  /* The two read heads: absolute fractional positions in the same timeline. */
  double pos_[2] = {0.0, 0.0};
  /* cos(2 pi phi) for head 0, stepped by a rotator. Head 1 is half a turn
     behind, so its window gain is exactly one minus head 0's. */
  double cos_ = 1.0, sin_ = 0.0;
  double rotC_ = 1.0, rotS_ = 0.0;
  /* Where head 0 is in its life, in samples. Head 1 is half a life behind. */
  int phase_ = 0;
  bool running_ = false;

  /* Scratch for the splice search, allocated once: the audio path never does. */
  std::vector<float> ref_, refFine_;

  int grain_ = 0;      // samples a head lives before it is spliced again
  int search_ = 0;     // how far back a splice may look for a matching point
  int corr_ = 0;       // samples compared when it looks
  int stride_ = 1;     // resolution of the coarse search
  double maxDelay_ = 0.0;
};

}  // namespace tc
