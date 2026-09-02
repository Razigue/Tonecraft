// Does the oversampling window actually remove aliasing?
//
// FR-16 asks for 4x around every non-linearity because aliasing is the first
// cause of a "cheap" sounding amp simulator. A non-linearity generates
// harmonics above Nyquist; without headroom those fold back down as inharmonic
// tones that sit at no musical interval and that no amount of EQ can remove.
//
// This drives a known non-linearity — tanh, which is what a drive pedal is —
// rather than the neural amp, whose behaviour with placeholder weights is not
// predictable enough to assert on. It measures energy at the exact frequencies
// the folded harmonics land on, with and without the window.

#include <cmath>
#include <cstdio>
#include <vector>
#include "oversample/window.h"
using namespace tonecraft;

// Goertzel: energy at one frequency, without pulling in an FFT.
static double bin(const std::vector<float>& x, double f, double rate) {
  const double w = 2.0 * M_PI * f / rate;
  const double c = 2.0 * std::cos(w);
  double s1 = 0, s2 = 0;
  for (float v : x) { const double s0 = v + c * s1 - s2; s2 = s1; s1 = s0; }
  return std::sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / x.size();
}
static double db(double a, double ref) { return 20.0 * std::log10(a / ref + 1e-30); }

// The non-linearity a drive pedal actually is.
static inline float shape(float x) { return std::tanh(3.0f * x); }

int main() {
  const double rate = kInternalSampleRate;
  const double f = 7000.0;      // 5th harmonic at 35k folds to 13k, 7th to 1k
  const uint32_t blocks = 200;
  std::vector<float> in(kBlockFrames), naive, oversampled;

  OversampleWindow w; w.init();
  std::vector<float> out(kBlockFrames);

  uint32_t n = 0;
  for (uint32_t b = 0; b < blocks; ++b) {
    for (uint32_t i = 0; i < kBlockFrames; ++i, ++n)
      in[i] = (float)(0.7 * std::sin(2.0 * M_PI * f * n / rate));

    // Naive: shape at the base rate.
    for (uint32_t i = 0; i < kBlockFrames; ++i) out[i] = shape(in[i]);
    if (b > 20) naive.insert(naive.end(), out.begin(), out.end());

    // Windowed: shape at 4x.
    w.process(in.data(), out.data(), kBlockFrames,
              [](const float* a, float* o, uint32_t nf) {
                for (uint32_t i = 0; i < nf; ++i) o[i] = shape(a[i]);
              });
    if (b > 20) oversampled.insert(oversampled.end(), out.begin(), out.end());
  }

  const double fund_n = bin(naive, f, rate), fund_o = bin(oversampled, f, rate);
  std::printf("  fundamental preserved:   naive %.1f dB   oversampled %.1f dB\n",
              db(fund_n, 1.0), db(fund_o, 1.0));

  std::printf("\n  %-28s %10s %12s %10s\n", "alias product", "naive", "oversampled", "removed");
  int wins = 0, total = 0;
  for (auto [name, af] : std::initializer_list<std::pair<const char*, double>>{
           {"5th harmonic -> 13 kHz", 13000.0},
           {"7th harmonic -> 1 kHz", 1000.0},
           {"9th harmonic -> 15 kHz", 15000.0},
           {"11th harmonic -> 29->19 kHz", 19000.0}}) {
    const double a = db(bin(naive, af, rate), fund_n);
    const double o = db(bin(oversampled, af, rate), fund_o);
    std::printf("  %-28s %8.1f dB %10.1f dB %8.1f dB\n", name, a, o, a - o);
    ++total; if (o < a - 6.0) ++wins;
  }

  std::printf("\n  window latency: %.1f base samples = %.3f ms\n",
              OversampleWindow::latencySamples(),
              OversampleWindow::latencySamples() * 1000.0 / rate);
  std::printf("\n  %d of %d alias products reduced by more than 6 dB\n", wins, total);
  // The window must not cost more latency than it is worth. The price of
  // oversampling is paid in dropouts, not in delay (addendum section A).
  const double latencyMs = OversampleWindow::latencySamples() * 1000.0 / rate;
  const bool latencyOk = latencyMs < 0.5;
  if (!latencyOk) std::printf("  FAIL  window latency %.3f ms exceeds 0.5 ms\n", latencyMs);

  // And it must not change the signal it is supposed to leave alone.
  const bool fundamentalOk = std::fabs(db(fund_o, fund_n)) < 0.2;
  if (!fundamentalOk) std::printf("  FAIL  fundamental moved by %.2f dB\n", db(fund_o, fund_n));

  return (wins == total && latencyOk && fundamentalOk) ? 0 : 1;
}
