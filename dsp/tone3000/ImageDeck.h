// Adapted from tone-3000/tone3000-plugin, commit ef6f178ae1ac6412b55fec6f058d86e640e5aaaf.
// Copyright (c) 2026 TONE3000. MIT; see LICENSE.txt and README.md in dsp/tone3000.
#pragma once
#include <algorithm>
#include <numbers>
#include <cstdint>
#include <array>
#include <cmath>

namespace tc::tone3000 {

/**
 * Shared DSP primitives for the two stereo-image engines: Spread (mono
 * chain mode, Spread.h) and Align (stereo chain mode, StereoOffset.h). The
 * features are independent (separate parameters, separate lifecycles), but
 * their advanced "deck" sections are deliberately the same circuit so the
 * two faces of the stereo-image slot sound and read alike: a wobbling
 * delay, a crossover that keeps lows out of the treatment, and an allpass
 * diffusion cascade. Design notes in plugin/docs/stereo-image.md.
 *
 * The portable subset here is audio-thread only and allocation-free.
 */

/** Crossover knob log map, mirrored by the UI scale (crossoverHzScale):
    32.5-520 Hz with the 130 Hz default exactly at center
    (32.5 * 16^0.5 = 130; 4x per half turn). */
constexpr float kDeckCrossoverMinHz = 32.5f;
constexpr float kDeckCrossoverMaxHz = 520.0f;
inline float deckCrossoverHz(float norm) {
  return kDeckCrossoverMinHz * std::pow(kDeckCrossoverMaxHz / kDeckCrossoverMinHz,
                                        std::clamp(norm, 0.0f, 1.0f));
}

/** Wobble depth span: 100% = ±1.2 ms of slow drift around the dialed delay
    (≈ ±2-4 cents of continuous pitch wander; pitch shift is the derivative
    of delay time). Absolute, not relative to the delay, so a small offset
    can still carry a full-depth wobble. */
constexpr float kDeckWobbleMaxMs = 1.2f;

/** Section engage/bypass blend time. The deck switches are ~25 ms blends,
    not hard toggles: both endpoints are magnitude-flat but differ in phase,
    so an instant switch would step the waveform. */
constexpr double kDeckFadeSeconds = 0.025;

/** First-order allpass (transposed direct form II, one state). Static
    coefficients: movement comes from the delay wobble; modulating allpass
    coefficients would reintroduce phasiness. */
struct DeckAllpass {
  float a = 0.0f;
  float z = 0.0f;
  float process(float x) noexcept {
    const float v = x - a * z;
    const float y = a * v + z;
    z = v;
    return y;
  }
};

/** Six-stage phase-diffusion cascade, corner frequencies log-spaced over
    300 Hz - 6 kHz. Decorrelates phase without touching magnitude, the same
    principle as the allpass decorrelators evaluated in O. Das, "An
    Open-Source Stereo Widening Plugin", Proc. 27th Int. Conf. on Digital
    Audio Effects (DAFx24), Guildford, UK, 2024
    (https://www.dafx.de/paper-archive/2024/papers/DAFx24_paper_92.pdf). */
struct DeckDiffuser {
  static constexpr int kNumStages = 6;
  static constexpr double kLowHz = 300.0;
  static constexpr double kHighHz = 6000.0;

  void prepare(double sampleRate) {
    for (int i = 0; i < kNumStages; ++i) {
      const double fc =
          kLowHz * std::pow(kHighHz / kLowHz, static_cast<double>(i) / (kNumStages - 1));
      // Corners above Nyquist (hosts below ~12 kHz) put tan() past π/2 and
      // the allpass coefficient outside |a| < 1: unstable. Pin just under
      // Nyquist; the top stages collapse toward a=0 (transparent) there.
      const double fcSafe = std::min(fc, sampleRate * 0.49);
      const double t = std::tan(std::numbers::pi * fcSafe / sampleRate);
      stages[static_cast<size_t>(i)].a = static_cast<float>((t - 1.0) / (t + 1.0));
    }
  }
  void reset() {
    for (auto& stage : stages)
      stage.z = 0.0f;
  }
  float process(float x) noexcept {
    for (auto& stage : stages)
      x = stage.process(x);
    return x;
  }

  std::array<DeckAllpass, kNumStages> stages;
};

/** Random-walk wobble source: white noise through two cascaded 0.3 Hz
    one-poles. One pole is not enough: its 6 dB/oct tail leaves ~1% of the
    noise variance above 20 Hz, and audio-rate delay-time noise FMs the
    delayed channel into broadband fizz (regression covered by
    SpreadTest.WobbleAddsNoBroadbandFizz).

    next() returns the normalized walk in -1..1; callers scale it by
    kDeckWobbleMaxMs and their depth. The normalization is analytic: the
    shaper's impulse response is h[n] = k²(n+1)aⁿ with a = 1-k, so the
    steady-state output variance for unit-variance input is
    Σh² = k⁴(1+a²)/(1-a²)³. Uniform [-1,1] noise has σ² = 1/3; scale so 3σ
    reaches the ±1 clamp. Only then does a depth knob actually span the
    full ±kDeckWobbleMaxMs at any sample rate. */
struct DeckWobble {
  static constexpr double kRateHz = 0.3;

  void prepare(double sampleRate) {
    coeff = 1.0f - std::exp(static_cast<float>(
        -(2.0 * std::numbers::pi) * kRateHz / sampleRate));
    const double k = coeff, a = 1.0 - k;
    const double gainSq = k * k * k * k * (1.0 + a * a) /
                          ((1.0 - a * a) * (1.0 - a * a) * (1.0 - a * a));
    const double sigma = std::sqrt(gainSq / 3.0);
    norm = static_cast<float>(1.0 / (3.0 * sigma));
  }
  void reset() { state1 = state2 = 0.0f; seed = 0x9E3779B9u; }
  float next() noexcept {
    state1 += coeff * (nextRandom() * 2.0f - 1.0f - state1);
    state2 += coeff * (state1 - state2);
    return std::clamp(state2 * norm, -1.0f, 1.0f);
  }

  // Tonecraft: deterministic across hosts and re-engagements.
  uint32_t seed = 0x9E3779B9u;
  float nextRandom() noexcept {
    seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5;
    return static_cast<float>(seed >> 8) / 16777216.0f;
  }
  float state1{0.0f}, state2{0.0f};
  float coeff{0.0f};
  float norm{1.0f};
};


} // namespace tc::tone3000
