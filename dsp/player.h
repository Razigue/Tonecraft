/* =============================================================================
   dsp/player.h — the file source
   -----------------------------------------------------------------------------
   A DI take played through the identical chain is how someone with no
   interface hears the product at all, and how two captures are compared on the
   same performance. It lives in the chain rather than in a host because the
   native host has no AudioBufferSourceNode — and a take that played in one
   host and not the other is exactly the drift the single chain is for.

   The host decodes and resamples the file to the chain's rate; this only
   plays samples. One or two channels, so the input stage's channel choice
   applies to a stereo take as it did before.
   ========================================================================== */
#pragma once

#include <cstdint>
#include <vector>

namespace tc {

class Player {
 public:
  /* Not real-time safe: allocates. `planar` holds `channels` runs of `frames`. */
  bool load(const float* planar, int64_t frames, int channels) {
    if (frames <= 0 || channels < 1) return false;
    channels_ = channels > 2 ? 2 : channels;
    frames_ = frames;
    for (int c = 0; c < channels_; c++) data_[c].assign(planar + c * frames, planar + (c + 1) * frames);
    if (channels_ == 1) data_[1].clear();
    pos_ = 0;
    playing_ = false;
    return true;
  }

  void play(int64_t from) {
    if (frames_ == 0) return;
    pos_ = from < 0 ? 0 : from >= frames_ ? 0 : from;   // restarting from the end starts over
    playing_ = true;
  }

  void stop() { playing_ = false; }
  void setLoop(bool loop) { loop_ = loop; }

  bool playing() const { return playing_; }
  int64_t position() const { return pos_; }

  /* Fills a (and b, for a stereo take) with n frames. Returns the channel
     count the input stage should see: a stopped take is silence on one. */
  int render(float* a, float* b, int n) {
    if (!playing_ || frames_ == 0) {
      for (int i = 0; i < n; i++) a[i] = 0.0f;
      return 1;
    }
    for (int i = 0; i < n; i++) {
      if (pos_ >= frames_) {
        if (loop_) {
          pos_ = 0;
        } else {
          playing_ = false;
          for (int j = i; j < n; j++) { a[j] = 0.0f; if (channels_ > 1) b[j] = 0.0f; }
          return channels_;
        }
      }
      a[i] = data_[0][pos_];
      if (channels_ > 1) b[i] = data_[1][pos_];
      pos_++;
    }
    return channels_;
  }

 private:
  std::vector<float> data_[2];
  int channels_ = 0;
  int64_t frames_ = 0;
  int64_t pos_ = 0;
  bool playing_ = false;
  bool loop_ = true;
};

}  // namespace tc
