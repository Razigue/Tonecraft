/* =============================================================================
   dsp/smooth.h — the one layer that smooths parameters (AD-20)
   -----------------------------------------------------------------------------
   Hosts hand the chain raw values: a fader position converted to engineering
   units, a bypass flipped, the power switched. Neither host interpolates. The
   browser used to, through AudioParam.setTargetAtTime, but the native host has
   no AudioParam — so the interpolation moved here, where both hosts get the
   same one, sample for sample.

   It is exactly setTargetAtTime: v(t) = target + (v0 - target) e^(-t / tau),
   stepped one sample at a time, or n samples at once for the controls the old
   worklet read at k-rate (one value per 128-frame quantum).
   ========================================================================== */
#pragma once

#include <cmath>

namespace tc {

struct Smoother {
  double value = 0.0;
  double target = 0.0;
  /* e^(-1 / (tau * sr)): what is left of the distance after one sample. */
  double keep = 0.0;

  void init(double tauSeconds, double sampleRate, double v) {
    keep = std::exp(-1.0 / (tauSeconds * sampleRate));
    value = target = v;
  }

  void set(double t) { target = t; }

  double tick() {
    value = target + (value - target) * keep;
    return value;
  }

  /* The value at the start of a k-rate block, then n samples of travel. */
  double block(int n) {
    const double v = value;
    value = target + (value - target) * std::pow(keep, n);
    return v;
  }

  bool settled() const { return std::fabs(value - target) <= 1e-7 * (1.0 + std::fabs(target)); }
};

}  // namespace tc
