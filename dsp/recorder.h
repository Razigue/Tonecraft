#pragma once
#include <algorithm>
#include <vector>

namespace tc {
// A take is the selected clean input, before trim, gate and pitch, independent
// of output power or the looper.
//
// The buffer is allocated on start, never while processing — but start runs on
// the audio thread in both hosts, and five minutes at 48 kHz is 57 MB: measured
// 35 ms the first time, one dropout at the press of Record, before anything is
// recorded. It is kept afterwards, so every later take starts in 0.00 ms. The
// alternative is holding those 57 MB for every visitor who never records, which
// is the worse of the two. Touching the fresh pages costs about 4 us a block
// during the first pass, 1.5% of a core at 48 kHz, and nothing after that.
class Recorder {
 public:
  bool start(int capacity) {
    if (capacity <= 0 || active_) return false;
    data_.resize(capacity);
    frames_ = 0;
    active_ = true;
    return true;
  }
  void stop() { active_ = false; }
  int frames() const { return frames_; }
  void process(const float* input, int n) {
    if (!active_) return;
    const int count = std::min(n, static_cast<int>(data_.size()) - frames_);
    std::copy_n(input, count, data_.data() + frames_);
    frames_ += count;
    if (frames_ == static_cast<int>(data_.size())) stop();
  }
  int read(float* out, int count, int offset) const {
    if (active_ || offset < 0 || offset >= frames_ || count <= 0) return 0;
    count = std::min(count, frames_ - offset);
    std::copy_n(data_.data() + offset, count, out);
    return count;
  }
 private:
  std::vector<float> data_;
  int frames_ = 0;
  bool active_ = false;
};
}
