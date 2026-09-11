/* =============================================================================
   dsp/biquad.h — the four-band correction and the low cut
   -----------------------------------------------------------------------------
   These were native BiquadFilterNodes, and a tone shared before this file
   existed must still sound the same after it. So the coefficients are the Web
   Audio specification's, formula for formula, including its two quirks:

     - shelves use a slope S = 1, so alpha = sin(w0) / 2 * sqrt(2);
     - lowpass and highpass read Q in decibels: the low cut's "Q 0.707" is a
       resonance of 10^(0.707 / 20) = 1.085, not a Butterworth 0.707.

   Double precision, transposed direct form II: the shelves sit at 110 Hz, where
   a float state loses resolution against a 48 kHz sample rate.
   ========================================================================== */
#pragma once

#include <cmath>

namespace tc {

struct Biquad {
  enum Type { LowShelf, Peaking, HighShelf, HighPass };

  Type type = Peaking;
  double f0 = 1000.0;
  double q = 1.0;
  double b0 = 1.0, b1 = 0.0, b2 = 0.0, a1 = 0.0, a2 = 0.0;
  double z1 = 0.0, z2 = 0.0;

  void setup(Type t, double frequency, double quality) {
    type = t;
    f0 = frequency;
    q = quality;
  }

  void design(double gainDb, double sampleRate) {
    const double A = std::pow(10.0, gainDb / 40.0);
    const double w0 = 2.0 * M_PI * f0 / sampleRate;
    const double cw = std::cos(w0);
    const double sw = std::sin(w0);
    double nb0, nb1, nb2, na0, na1, na2;

    switch (type) {
      case HighPass: {
        const double alpha = sw / (2.0 * std::pow(10.0, q / 20.0));
        nb0 = (1.0 + cw) / 2.0;
        nb1 = -(1.0 + cw);
        nb2 = (1.0 + cw) / 2.0;
        na0 = 1.0 + alpha;
        na1 = -2.0 * cw;
        na2 = 1.0 - alpha;
        break;
      }
      case Peaking: {
        const double alpha = sw / (2.0 * q);
        nb0 = 1.0 + alpha * A;
        nb1 = -2.0 * cw;
        nb2 = 1.0 - alpha * A;
        na0 = 1.0 + alpha / A;
        na1 = -2.0 * cw;
        na2 = 1.0 - alpha / A;
        break;
      }
      case LowShelf: {
        const double k = 2.0 * std::sqrt(A) * (sw / 2.0 * std::sqrt(2.0));
        nb0 = A * ((A + 1.0) - (A - 1.0) * cw + k);
        nb1 = 2.0 * A * ((A - 1.0) - (A + 1.0) * cw);
        nb2 = A * ((A + 1.0) - (A - 1.0) * cw - k);
        na0 = (A + 1.0) + (A - 1.0) * cw + k;
        na1 = -2.0 * ((A - 1.0) + (A + 1.0) * cw);
        na2 = (A + 1.0) + (A - 1.0) * cw - k;
        break;
      }
      case HighShelf:
      default: {
        const double k = 2.0 * std::sqrt(A) * (sw / 2.0 * std::sqrt(2.0));
        nb0 = A * ((A + 1.0) + (A - 1.0) * cw + k);
        nb1 = -2.0 * A * ((A - 1.0) + (A + 1.0) * cw);
        nb2 = A * ((A + 1.0) + (A - 1.0) * cw - k);
        na0 = (A + 1.0) - (A - 1.0) * cw + k;
        na1 = 2.0 * ((A - 1.0) - (A + 1.0) * cw);
        na2 = (A + 1.0) - (A - 1.0) * cw - k;
        break;
      }
    }
    b0 = nb0 / na0;
    b1 = nb1 / na0;
    b2 = nb2 / na0;
    a1 = na1 / na0;
    a2 = na2 / na0;
  }

  float tick(float x) {
    const double y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    return static_cast<float>(y);
  }

  void reset() { z1 = z2 = 0.0; }
};

}  // namespace tc
