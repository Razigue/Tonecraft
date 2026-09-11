/* =============================================================================
   dsp/limiter.h — the safety limiter, always on (FR-18)
   -----------------------------------------------------------------------------
   Identity to 0.7 (-3 dBFS), then a tanh knee that reaches 1.0 asymptotically.
   It has no parameter, no bypass and no control anywhere in the product: a
   digital feedback loop in headphones can injure.

   Sample by sample, at zero latency. The WaveShaperNode it replaced delayed the
   signal by 192 frames at 4x in Chromium. The aliasing that oversampling was
   there for is handled by first-order antiderivative anti-aliasing on the
   *residual* above the knee only, so below the knee the stage is exactly
   transparent rather than transparent to within a half-sample average.
   ========================================================================== */
#pragma once

#include <cmath>

namespace tc {

class Limiter {
 public:
  float tick(float in) {
    const double x = in;
    const double F = residualIntegral(x);
    const double dx = x - px_;
    /* The residual averaged over the interval between two samples. When two
       samples are too close the divided difference is unstable, and the
       midpoint value is its exact limit. */
    const double r = (dx > 1e-6 || dx < -1e-6) ? (F - pF_) / dx : residual(0.5 * (x + px_));
    px_ = x;
    pF_ = F;
    /* The averaged residual can overshoot the pointwise curve on a fast peak,
       so the knee's asymptote alone is not a ceiling. Safety needs one; this
       clip only engages beyond the knee, where limiting has already begun. */
    const double y = x + r;
    return static_cast<float>(y > 1.0 ? 1.0 : y < -1.0 ? -1.0 : y);
  }

  void reset() { px_ = pF_ = 0.0; }

 private:
  static constexpr double KNEE = 0.7;
  static constexpr double SPAN = 1.0 - KNEE;

  /* ln(cosh(x)), the antiderivative of tanh, written so it can never overflow. */
  static double lncosh(double x) {
    const double a = x < 0 ? -x : x;
    return a + std::log1p(std::exp(-2.0 * a)) - 0.6931471805599453;
  }

  /* What the limiter adds to the identity: zero below the knee. */
  static double residual(double x) {
    const double a = x < 0 ? -x : x;
    if (a <= KNEE) return 0.0;
    const double y = KNEE + SPAN * std::tanh((a - KNEE) / SPAN);
    return x < 0 ? -(y - a) : (y - a);
  }

  /* Its antiderivative: even, zero below the knee. */
  static double residualIntegral(double x) {
    const double a = x < 0 ? -x : x;
    if (a <= KNEE) return 0.0;
    const double over = a - KNEE;
    return KNEE * over + SPAN * SPAN * lncosh(over / SPAN) - 0.5 * (a * a - KNEE * KNEE);
  }

  double px_ = 0.0;
  double pF_ = 0.0;
};

}  // namespace tc
