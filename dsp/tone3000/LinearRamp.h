#pragma once
#include <algorithm>
#include <cmath>

namespace tc::tone3000 {
// Host-owned replacement for JUCE's linear smoothing utility. No JUCE code.
class LinearRamp {
 public:
  void reset(double rate, double seconds) {
    steps_ = std::max(1, static_cast<int>(std::floor(rate * seconds)));
    setCurrentAndTargetValue(target_);
  }
  void setCurrentAndTargetValue(float value) {
    value_ = target_ = value;
    left_ = 0;
  }
  void setTargetValue(float target) {
    if (target == target_) return;
    target_ = target;
    left_ = steps_;
    step_ = (target_ - value_) / static_cast<float>(left_);
  }
  float getNextValue() {
    if (left_ > 0) {
      if (--left_ == 0) value_ = target_;
      else value_ += step_;
    }
    return value_;
  }
  float getCurrentValue() const { return value_; }
  bool isSmoothing() const { return left_ > 0; }
 private:
  float value_ = 0, target_ = 0, step_ = 0;
  int steps_ = 1, left_ = 0;
};
} // namespace tc::tone3000
