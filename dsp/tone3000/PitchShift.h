// Adapted from tone-3000/tone3000-plugin, commit ef6f178ae1ac6412b55fec6f058d86e640e5aaaf.
// Copyright (c) 2026 TONE3000. MIT; see dsp/tone3000/LICENSE.txt.
// Portable Tonecraft adaptation: see dsp/tone3000/README.md.
#pragma once
#include <array>
#include <memory>

namespace tc::tone3000 {
// Correlation-spliced delay with onset re-sync, from TONE3000.
// Pure shift (upstream's default tonality=off), mono host buffer.
class PitchShift {
 public:
  static constexpr int kMaxChannels = 1;
  enum class Window { ms20, ms30, ms40, ms60 };
  static constexpr std::array<int, 4> kWindowMs{20, 30, 40, 60};
  static constexpr double kMinDelayMs = 2.0;
  struct Params { float semitones = 0; Window window = Window::ms30; };
  PitchShift();
  ~PitchShift();
  void prepare(double sampleRate);
  void setEnabled(bool on);
  bool isRunning() const;
  void setParams(const Params& p);
  void process(float* samples, int numSamples);
  int latencySamples() const;
  static int minDelaySamples(double sr) { return static_cast<int>(sr * kMinDelayMs * 0.001); }
  static int windowSamples(Window w, double sr) {
    return static_cast<int>(sr * kWindowMs[static_cast<size_t>(w)] * 0.001);
  }
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
} // namespace tc::tone3000
