// Does the amplifier behave like an amplifier?
//
// It cannot be judged by ear from here, and "sounds good" is not a number. But
// several things that would make it definitively *not* an amp are measurable:
// a distortion that generates no harmonics, a gain control that does not change
// how much it distorts, tone controls that move the wrong bands, or an output
// that runs away.

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <vector>

#include "amp/amp.h"

using namespace tonecraft;

static int failures = 0;
static void check(const char* name, bool ok, double got = 0) {
  if (ok) { std::printf("  ok    %s\n", name); return; }
  ++failures;
  std::printf("  FAIL  %s (got %.4f)\n", name, got);
}

static double bin(const std::vector<float>& x, double f, double rate) {
  const double w = 2.0 * M_PI * f / rate;
  const double c = 2.0 * std::cos(w);
  double s1 = 0, s2 = 0;
  for (float v : x) { const double s0 = v + c * s1 - s2; s2 = s1; s1 = s0; }
  return std::sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / x.size();
}
static double db(double a, double ref) { return 20.0 * std::log10(a / ref + 1e-30); }

struct Result { std::vector<float> out; double peak; };

/// The amp lives inside the 4x window, so it is designed for — and must be
/// driven at — the oversampled rate. Feeding it at the chain's rate puts every
/// probe two octaves away from the filter it is meant to be measuring, which is
/// how this test started reporting that the tone controls did nothing.
static Result run(Amp& amp, double gainDb, double bassDb, double midDb,
                  double trebleDb, double amplitude, double freq, double seconds = 0.4) {
  amp.reset();
  amp.setControls((float)gainDb, (float)bassDb, (float)midDb, (float)trebleDb, 0.0f);
  const double rate = kOversampledSampleRate;
  const uint32_t total = (uint32_t)(rate * seconds);
  std::vector<float> in(kBlockFrames), out(kBlockFrames), collected;
  double peak = 0;
  for (uint32_t n = 0; n < total; n += kBlockFrames) {
    for (uint32_t i = 0; i < kBlockFrames; ++i)
      in[i] = (float)(amplitude * std::sin(2.0 * M_PI * freq * (n + i) / rate));
    amp.process(in.data(), out.data(), kBlockFrames);
    if (n > total / 3) {
      collected.insert(collected.end(), out.begin(), out.end());
      for (float v : out) peak = std::max(peak, (double)std::fabs(v));
    }
  }
  return {collected, peak};
}

int main() {
  const double rate = kOversampledSampleRate;
  Amp amp;
  amp.init();

  // A distortion generates harmonics. One that does not is a filter.
  {
    const auto r = run(amp, 30, 0, 0, 0, 0.3, 220.0);
    const double f1 = bin(r.out, 220.0, rate);
    const double h2 = bin(r.out, 440.0, rate);
    const double h3 = bin(r.out, 660.0, rate);
    std::printf("        harmonics at gain 30: 2nd %.1f dB, 3rd %.1f dB\n",
                db(h2, f1), db(h3, f1));
    check("the amp generates harmonics", db(h2, f1) > -40.0 && db(h3, f1) > -40.0,
          db(h3, f1));
    check("and keeps even harmonics, which is what asymmetry is for",
          db(h2, f1) > -40.0, db(h2, f1));
  }

  // More gain, more distortion. If this does not hold, the control is a lie.
  {
    const auto low = run(amp, 5, 0, 0, 0, 0.3, 220.0);
    const auto high = run(amp, 40, 0, 0, 0, 0.3, 220.0);
    const double lowRatio = db(bin(low.out, 660.0, rate), bin(low.out, 220.0, rate));
    const double highRatio = db(bin(high.out, 660.0, rate), bin(high.out, 220.0, rate));
    std::printf("        third harmonic: gain 5 -> %.1f dB, gain 40 -> %.1f dB\n",
                lowRatio, highRatio);
    check("turning gain up distorts more", highRatio > lowRatio + 6.0,
          highRatio - lowRatio);
  }

  // Tone controls move the bands they are named after, and only those.
  {
    const double probeLow = 100.0, probeMid = 650.0, probeHigh = 5000.0;
    auto level = [&](double b, double m, double t, double f) {
      const auto r = run(amp, 12, b, m, t, 0.05, f);
      return db(bin(r.out, f, rate), 1.0);
    };
    const double flatLow = level(0, 0, 0, probeLow);
    const double flatMid = level(0, 0, 0, probeMid);
    const double flatHigh = level(0, 0, 0, probeHigh);

    check("bass lifts the low end", level(12, 0, 0, probeLow) > flatLow + 4.0,
          level(12, 0, 0, probeLow) - flatLow);
    check("and cutting it drops the low end", level(-12, 0, 0, probeLow) < flatLow - 4.0,
          level(-12, 0, 0, probeLow) - flatLow);
    check("mid moves the middle", level(0, 12, 0, probeMid) > flatMid + 4.0,
          level(0, 12, 0, probeMid) - flatMid);
    check("treble lifts the top", level(0, 0, 12, probeHigh) > flatHigh + 4.0,
          level(0, 0, 12, probeHigh) - flatHigh);
    check("and bass leaves the top alone",
          std::fabs(level(12, 0, 0, probeHigh) - flatHigh) < 3.0,
          level(12, 0, 0, probeHigh) - flatHigh);
  }

  // Nothing runs away, at any setting, with any input.
  {
    double worst = 0;
    for (double g : {0.0, 20.0, 40.0})
      for (double a : {0.05, 0.5, 1.0})
        for (double f : {80.0, 440.0, 3000.0}) {
          const auto r = run(amp, g, 12, 12, 12, a, f, 0.15);
          worst = std::max(worst, r.peak);
          for (float v : r.out)
            if (!std::isfinite(v)) { check("output stays finite", false); return 1; }
        }
    std::printf("        worst peak across 27 settings: %.3f\n", worst);
    check("the amp stays bounded at every setting", worst < 4.0, worst);
  }

  std::printf("\n%s\n", failures ? "FAILURES" : "all amp checks passed");
  return failures ? 1 : 0;
}
