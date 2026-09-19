/* =============================================================================
   dsp/doubler.h — the doubler, the one stage that makes the output stereo
   -----------------------------------------------------------------------------
   A rhythm part recorded twice and panned hard left and right is the widest
   sound a guitar makes, and it is wide because the two takes never line up:
   one is always a few milliseconds behind the other, by an amount that keeps
   changing. This fakes the second take. The left ear gets the rig; the right
   ear gets the same rig, delayed by an offset that wanders at random between
   3 ms and the Spread control (at most 20 ms).

   Why that range. Below about 3 ms the two ears' copies fuse into one guitar
   that has merely moved to the left; above about 20 ms the ear stops fusing
   them and hears an echo. In between is the precedence effect: one wide
   guitar, located by the first arrival. Neural DSP's Archetype: Tim Henson X
   ships the same feature with the same range, 3 to 20 ms, and the same random
   offset "within the range specified by the SPREAD knob".

   Why it wanders. A fixed copy is a comb filter: the same notches every note,
   which sounds like a small room, not like a second player. A moving offset
   also moves the pitch, by the slope of the motion — so the motion is a
   raised cosine between random targets, slowed so that its steepest point
   never exceeds MAX_SLOPE. 0.002 is 3.5 cents at the worst moment, the order
   of what separates two real takes, and well under what reads as chorus.

   Latency: none. The left ear is the rig undelayed, and the precedence effect
   places the sound at the first arrival — the right ear's copy widens it, it
   does not make it late. So nothing is added to the displayed round trip.

   Bypassed, it costs nothing: no write, no read, and the chain copies the left
   channel to the right. Waking up, it clears the line, so nothing played
   before it was switched off ever comes back.

   Deterministic: the random wander comes from a fixed-seed generator, reset at
   init, so both hosts produce the same samples (npm run test:parity).

   Real time: the line is allocated once, at init. tick() allocates nothing.
   ========================================================================== */
#pragma once

#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>

#include "smooth.h"

namespace tc {

class Doubler {
 public:
  static constexpr double MIN_MS = 3.0;
  static constexpr double MAX_MS = 20.0;

  /* Allocates. Called from tc_init, never from the audio path. */
  void init(double sampleRate) {
    sr_ = sampleRate > 0 ? sampleRate : 48000.0;
    // The longest offset, plus the two samples the interpolator reads ahead.
    const auto need = static_cast<size_t>(std::ceil(MAX_MS * 1e-3 * sr_)) + 4;
    size_t size = 1;
    while (size < need) size <<= 1;
    line_.assign(size, 0.0f);
    mask_ = size - 1;
    write_ = 0;
    seed_ = SEED;
    lo_ = MIN_MS * 1e-3 * sr_;
    hi_ = lo_;
    // 20 ms, as every other switch in the chain fades.
    wet_.init(0.02, sr_, 0.0);
    minSegment_ = MIN_SEGMENT_S * sr_;
    restart();
  }

  /* Between blocks, from tc_set_param. */
  void set(bool on, double spreadMs) {
    const double ms = spreadMs < MIN_MS ? MIN_MS : spreadMs > MAX_MS ? MAX_MS : spreadMs;
    const double hi = ms * 1e-3 * sr_;
    if (on && idle()) {
      std::memset(line_.data(), 0, sizeof(float) * line_.size());
      write_ = 0;
      hi_ = hi;
      restart();
    } else if (hi != hi_) {
      hi_ = hi;
      // A shorter range takes effect now, gliding from wherever the offset is.
      if (to_ > hi_) retarget(current());
    }
    wet_.set(on ? 1.0 : 0.0);
  }

  /* Nothing to do: the right channel is the left one. */
  bool idle() const { return wet_.target == 0.0 && wet_.value == 0.0; }

  /* One sample of the rig in; the right channel out. */
  float tick(float x) {
    line_[write_ & mask_] = x;

    const double d = current();
    phase_ += step_;
    if (phase_ >= 1.0) retarget(to_);

    // Catmull-Rom between the four samples around the read point: linear
    // interpolation would low-pass the copy by an amount that moves with the
    // offset, a flanger's shimmer on every held note.
    const double at = static_cast<double>(write_) - d;
    const double base = std::floor(at);
    const double t = at - base;
    const auto i = static_cast<size_t>(static_cast<long long>(base));
    const double y0 = line_[(i - 1) & mask_], y1 = line_[i & mask_];
    const double y2 = line_[(i + 1) & mask_], y3 = line_[(i + 2) & mask_];
    const double copy = y1 + 0.5 * t * (y2 - y0 + t * (2.0 * y0 - 5.0 * y1 + 4.0 * y2 - y3 + t * (3.0 * (y1 - y2) + y3 - y0)));
    write_++;

    const double w = wet_.tick();
    if (wet_.target == 0.0 && w < 1e-6) wet_.value = 0.0;
    return static_cast<float>(x + w * (copy - x));
  }

 private:
  static constexpr uint32_t SEED = 0x9E3779B9u;
  /* The steepest the offset may move, in samples per sample: see above. */
  static constexpr double MAX_SLOPE = 0.002;
  /* No glide shorter than this, however small the step: a quicker one is
     heard as a flutter even when its pitch deviation is tiny. */
  static constexpr double MIN_SEGMENT_S = 0.5;

  double current() const {
    return from_ + (to_ - from_) * 0.5 * (1.0 - std::cos(PI * phase_));
  }

  /* xorshift32: cheap, and the same sequence in every host. */
  double uniform() {
    seed_ ^= seed_ << 13;
    seed_ ^= seed_ >> 17;
    seed_ ^= seed_ << 5;
    return static_cast<double>(seed_) / 4294967296.0;
  }

  /* A new target, reached along a raised cosine whose steepest point is
     (pi / 2) * distance / length: the length is chosen to keep that under
     MAX_SLOPE. */
  void retarget(double from) {
    from_ = from;
    to_ = lo_ + (hi_ - lo_) * uniform();
    const double distance = std::fabs(to_ - from_);
    double length = 0.5 * PI * distance / MAX_SLOPE;
    if (length < minSegment_) length = minSegment_;
    step_ = 1.0 / length;
    phase_ = 0.0;
  }

  /* Wake-up: start at a random offset, not gliding from 0 ms. */
  void restart() {
    const double start = lo_ + (hi_ - lo_) * uniform();
    to_ = start;
    retarget(start);
  }

  static constexpr double PI = 3.14159265358979323846;

  double sr_ = 48000.0;
  std::vector<float> line_;
  size_t mask_ = 0;
  size_t write_ = 0;
  uint32_t seed_ = SEED;
  double lo_ = 0.0, hi_ = 0.0;
  double from_ = 0.0, to_ = 0.0, phase_ = 0.0, step_ = 0.0;
  double minSegment_ = 0.0;
  Smoother wet_;
};

}  // namespace tc
