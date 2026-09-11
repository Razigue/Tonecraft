/* =============================================================================
   dsp/looper.h — the looper, at the end of the chain
   -----------------------------------------------------------------------------
   It records what leaves the rig, not what arrives at it: the amplifier, the
   cabinet and the reverb are printed into the loop. That is what makes the
   obvious thing possible — lay down a rhythm part, change the capture, the
   preset and the boost, and solo over it — and it is also the only order that
   works. Recording the dry guitar and replaying it through the amplifier would
   send the loop and the live playing into the same saturation together, where
   they would intermodulate: a chord played over a recorded chord is not two
   chords through a distorted amp, it is mud.

   It sits before the master and the limiter, so the output fader still moves
   everything at once and the ceiling still holds. The metronome is added after
   it, so the click is never printed into the loop.

   One button, as every looper pedal has: record, then play, then overdub, then
   play again. That is the shape that can be operated while both hands are on
   the guitar, and `press()` is the whole of it.

   Real time: the buffer is allocated once, at init — a minute of audio, which
   is 11 MB at 48 kHz. Nothing here allocates, and nothing here can throw.
   ========================================================================== */
#pragma once

#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>

#include "chain.generated.h"
#include "smooth.h"

namespace tc {

class Looper {
 public:
  /* Allocates. Called from tc_init, never from the audio path. */
  void init(double sampleRate) {
    sr_ = sampleRate > 0 ? sampleRate : 48000.0;
    fade_ = static_cast<int64_t>(0.010 * sr_);
    min_ = static_cast<int64_t>(0.200 * sr_);
    max_ = static_cast<int64_t>(TC_LOOP_MAX_SECONDS * sr_);
    buf_.assign(static_cast<size_t>(max_ + fade_ + 4), 0.0f);
    /* Equal power across the seam: the end of the loop and its beginning are
       different music, so a linear crossfade would dip where they meet. */
    fadeIn_.assign(static_cast<size_t>(fade_ + 1), 0.0f);
    for (int64_t i = 0; i <= fade_; i++) {
      fadeIn_[static_cast<size_t>(i)] =
          static_cast<float>(std::sin(0.5 * M_PI * static_cast<double>(i) / static_cast<double>(fade_)));
    }
    // 6 ms: short enough to be a button press, long enough not to click.
    play_.init(0.006, sr_, 0.0);
    dub_.init(0.006, sr_, 0.0);
    level_.init(0.020, sr_, 1.0);
    state_ = TC_LOOP_EMPTY;
    len_ = pos_ = over_ = 0;
    sealed_ = false;
    emptying_ = false;
  }

  /* The one button. Empty -> recording -> playing -> overdubbing -> playing. */
  void press() {
    switch (state_) {
      case TC_LOOP_EMPTY:
        len_ = pos_ = over_ = 0;
        sealed_ = false;
        emptying_ = false;
        play_.value = play_.target = 0.0;
        dub_.value = dub_.target = 0.0;
        state_ = TC_LOOP_RECORDING;
        break;
      case TC_LOOP_RECORDING:
        close();
        break;
      case TC_LOOP_PLAYING:
        dub_.set(1.0);
        state_ = TC_LOOP_OVERDUBBING;
        break;
      case TC_LOOP_OVERDUBBING:
        dub_.set(0.0);
        state_ = TC_LOOP_PLAYING;
        break;
      default:                       // stopped: from the top
        if (len_ == 0) break;
        pos_ = 0;
        dub_.set(0.0);
        play_.set(1.0);
        state_ = TC_LOOP_PLAYING;
        break;
    }
  }

  /* Stops playback and keeps the loop. While recording it closes it first:
     what was played is not thrown away by the button that says stop. */
  void stop() {
    if (state_ == TC_LOOP_RECORDING) close();
    if (state_ == TC_LOOP_EMPTY) return;
    dub_.set(0.0);
    play_.set(0.0);
    state_ = TC_LOOP_STOPPED;
  }

  /* Throws the loop away. The audio fades out first, so clearing a loud loop
     is not a click. */
  void clear() {
    dub_.set(0.0);
    play_.set(0.0);
    state_ = TC_LOOP_EMPTY;
    emptying_ = len_ > 0;
    if (!emptying_) {
      len_ = pos_ = over_ = 0;
    }
  }

  /* Playback level, 0..1. Not tone state: it is how loud the loop sits under
     the playing, which belongs to the session and never to a tone link. */
  void setLevel(double level) { level_.set(level < 0.0 ? 0.0 : level > 1.0 ? 1.0 : level); }

  int state() const { return state_; }
  double positionSeconds() const {
    const int64_t p = state_ == TC_LOOP_RECORDING ? pos_ : (len_ == 0 ? 0 : pos_);
    return static_cast<double>(p) / sr_;
  }
  double lengthSeconds() const {
    return static_cast<double>(state_ == TC_LOOP_RECORDING ? pos_ : len_) / sr_;
  }

  /* One sample of what leaves the rig. Returns what the loop adds to it. */
  float tick(float in) {
    const float level = static_cast<float>(level_.tick());

    if (state_ == TC_LOOP_RECORDING) {
      buf_[static_cast<size_t>(pos_)] = in;
      if (++pos_ >= max_) close();       // the ceiling closes the loop rather than cutting it
      play_.tick();
      dub_.tick();
      return 0.0f;
    }

    const float gain = static_cast<float>(play_.tick());
    const float dub = static_cast<float>(dub_.tick());
    if (len_ == 0) return 0.0f;
    if (gain <= 1e-4f && play_.target <= 0.0) {
      // Silent and not on its way anywhere: the loop waits at its beginning.
      pos_ = 0;
      if (emptying_) {
        emptying_ = false;
        len_ = over_ = 0;
      }
      return 0.0f;
    }

    const int64_t p = pos_;
    float v = buf_[static_cast<size_t>(p)];

    /* The seam. Closing a loop cuts the waveform wherever the button was
       pressed, and that step is a click on every pass. So the first pass keeps
       recording past the end, into `fade_` samples of overhang, and the
       beginning is crossfaded with it — the loop turns over through the
       playing that actually followed it. */
    if (p < fade_) {
      if (!sealed_ && over_ == p) {
        buf_[static_cast<size_t>(len_ + p)] = in;
        over_ = p + 1;
      }
      const float f = fadeIn_[static_cast<size_t>(p)];
      v = v * f + buf_[static_cast<size_t>(len_ + p)] * (1.0f - f);
    }

    if (dub > 1e-4f) {
      // The live signal is already in the output; the overdub is for the next
      // pass, and is written into the overhang too so the seam keeps matching.
      const float add = in * dub;
      buf_[static_cast<size_t>(p)] += add;
      if (p < fade_) buf_[static_cast<size_t>(len_ + p)] += add;
    }

    if (++pos_ >= len_) {
      pos_ = 0;
      sealed_ = true;
    }
    return v * gain * level;
  }

 private:
  /* Turns what has been recorded into a loop. A press too quick to be a bar is
     a mistake, not a loop: it is thrown away rather than left as a stutter. */
  void close() {
    if (pos_ < min_) {
      state_ = TC_LOOP_EMPTY;
      len_ = pos_ = over_ = 0;
      return;
    }
    len_ = pos_;
    pos_ = 0;
    over_ = 0;
    sealed_ = false;
    // Zeros where the overhang has not been played yet: a seam that never got
    // recorded fades the loop in from silence instead of from stale audio.
    std::memset(&buf_[static_cast<size_t>(len_)], 0, sizeof(float) * static_cast<size_t>(fade_));
    play_.set(1.0);
    dub_.set(0.0);
    state_ = TC_LOOP_PLAYING;
  }

  double sr_ = 48000.0;
  std::vector<float> buf_;
  std::vector<float> fadeIn_;
  int64_t fade_ = 0, min_ = 0, max_ = 0;
  int64_t len_ = 0, pos_ = 0, over_ = 0;
  /* Whether the first pass is done, and with it the chance to record a seam. */
  bool sealed_ = false;
  /* A cleared loop still fading out: the buffer goes when it is silent. */
  bool emptying_ = false;
  int state_ = TC_LOOP_EMPTY;
  Smoother play_, dub_, level_;
};

}  // namespace tc
