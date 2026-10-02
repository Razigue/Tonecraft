#pragma once
#include <algorithm>
#include <cmath>
#include <numbers>
#include <vector>

namespace tc::tone3000 {
// Tonecraft-owned portable primitives, not JUCE source. LR4 is two cascaded
// Butterworth biquads per band; summing the bands is magnitude-flat/allpass.
class CrossoverLR4 {
  struct Section {
    double b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0, z1 = 0, z2 = 0;
    double tick(double x) {
      const double y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      return y;
    }
  } low_[2], high_[2];
  double rate_ = 48000;
 public:
  void prepare(double rate, float hz) { rate_ = rate; setCutoffFrequency(hz); reset(); }
  void setCutoffFrequency(float hz) {
    const double w = 2 * std::numbers::pi * std::clamp<double>(hz, 1, rate_ * 0.49) / rate_;
    const double c = std::cos(w), alpha = std::sin(w) / std::numbers::sqrt2;
    const double inv = 1 / (1 + alpha);
    for (int i = 0; i < 2; ++i) {
      auto& l = low_[i]; auto& h = high_[i];
      l.b0 = l.b2 = (1 - c) * 0.5 * inv; l.b1 = 2 * l.b0;
      h.b0 = h.b2 = (1 + c) * 0.5 * inv; h.b1 = -2 * h.b0;
      l.a1 = h.a1 = -2 * c * inv; l.a2 = h.a2 = (1 - alpha) * inv;
    }
  }
  void reset() { for (int i = 0; i < 2; ++i) low_[i].z1 = low_[i].z2 = high_[i].z1 = high_[i].z2 = 0; }
  void processSample(int, float x, float& low, float& high) {
    low = static_cast<float>(low_[1].tick(low_[0].tick(x)));
    high = static_cast<float>(high_[1].tick(high_[0].tick(x)));
  }
};

// Four-point Lagrange interpolation through adjacent historical samples.
// All storage is allocated in prepare(); one push and one pop per sample.
class FractionalDelay {
  std::vector<float> line_;
  size_t write_ = 0;
 public:
  void prepare(int maxDelay) { line_.assign(static_cast<size_t>(maxDelay) + 4, 0); write_ = 0; }
  void reset() { std::fill(line_.begin(), line_.end(), 0); write_ = 0; }
  void pushSample(int, float x) { line_[write_] = x; }
  float popSample(int, float delay) {
    const double d = std::clamp<double>(delay, 0, line_.size() - 4);
    const int base = std::max(0, static_cast<int>(std::floor(d)) - 1);
    const double t = d - base;
    double y = 0;
    for (int k = 0; k < 4; ++k) {
      double weight = 1;
      for (int j = 0; j < 4; ++j) if (j != k) weight *= (t - j) / (k - j);
      const auto at = (write_ + line_.size() - static_cast<size_t>(base + k)) % line_.size();
      y += weight * line_[at];
    }
    if (++write_ == line_.size()) write_ = 0;
    return static_cast<float>(y);
  }
};
} // namespace tc::tone3000
