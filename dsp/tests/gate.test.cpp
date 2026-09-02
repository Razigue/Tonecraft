// Does the gate behave like a gate, and does it do it without a release knob?
//
// FR-11 exposes a threshold and nothing else. Everything below is therefore a
// claim about fixed constants, and the point of testing it is that a player
// cannot compensate for a bad choice here — they have no control to turn.

#include <cmath>
#include <cstdio>
#include <vector>
#include <functional>
#include <algorithm>

#include "gate/gate.h"

using namespace tonecraft;

static int failures = 0;
static void check(const char* name, bool ok, double got = 0) {
  if (ok) { std::printf("  ok    %s\n", name); return; }
  ++failures;
  std::printf("  FAIL  %s (got %.6f)\n", name, got);
}

static double dbToLin(double db) { return std::pow(10.0, db * 0.05); }

/// Runs `seconds` of a signal through a gate and returns the output RMS of the
/// final tenth, past any transient.
static double run(Gate& g, double thresholdDb, double seconds,
                  const std::function<float(uint32_t)>& source) {
  g.setThreshold(static_cast<float>(dbToLin(thresholdDb)));
  const uint32_t total = static_cast<uint32_t>(kInternalSampleRate * seconds);
  std::vector<float> in(kBlockFrames), out(kBlockFrames);
  double sum = 0.0;
  uint32_t counted = 0;
  const uint32_t tail = total - total / 10;
  for (uint32_t n = 0; n < total; n += kBlockFrames) {
    for (uint32_t i = 0; i < kBlockFrames; ++i) in[i] = source(n + i);
    g.process(in.data(), out.data(), kBlockFrames);
    if (n >= tail) {
      for (uint32_t i = 0; i < kBlockFrames; ++i) { sum += out[i] * out[i]; ++counted; }
    }
  }
  return counted ? std::sqrt(sum / counted) : 0.0;
}

int main() {
  const double rate = kInternalSampleRate;
  auto sine = [rate](double amp, double f) {
    return [rate, amp, f](uint32_t n) {
      return static_cast<float>(amp * std::sin(2.0 * M_PI * f * n / rate));
    };
  };

  // Noise well under the threshold is silenced.
  { Gate g; g.reset();
    const double out = run(g, -40.0, 1.0, sine(dbToLin(-60.0), 440.0));
    check("hum 20 dB below the threshold is silenced", out < 1e-4, out); }

  // Signal well above it passes at full level.
  { Gate g; g.reset();
    const double amp = 0.5;
    const double out = run(g, -40.0, 1.0, sine(amp, 440.0));
    check("a note above the threshold passes unattenuated",
          std::fabs(out - amp / M_SQRT2) / (amp / M_SQRT2) < 0.02, out); }

  // A note decaying through the threshold must not be chopped: the hold keeps
  // the gate open long enough for the tail to fade on its own.
  { Gate g; g.reset();
    g.setThreshold(static_cast<float>(dbToLin(-40.0)));
    std::vector<float> in(kBlockFrames), out(kBlockFrames);
    double worstJump = 0.0;
    float previous = 0.0f;
    const uint32_t total = static_cast<uint32_t>(rate * 1.5);
    for (uint32_t n = 0; n < total; n += kBlockFrames) {
      for (uint32_t i = 0; i < kBlockFrames; ++i) {
        const double t = static_cast<double>(n + i) / rate;
        const double env = 0.6 * std::exp(-t * 3.0);  // a plucked note decaying
        in[i] = static_cast<float>(env * std::sin(2.0 * M_PI * 220.0 * (n + i) / rate));
      }
      g.process(in.data(), out.data(), kBlockFrames);
      for (uint32_t i = 0; i < kBlockFrames; ++i) {
        worstJump = std::max(worstJump, static_cast<double>(std::fabs(out[i] - previous)));
        previous = out[i];
      }
    }
    // A chopped tail shows up as a step far larger than one cycle's slew.
    check("a decaying note is not chopped as it falls through the threshold",
          worstJump < 0.05, worstJump); }

  // Hysteresis: a signal parked exactly at the threshold must not chatter.
  { Gate g; g.reset();
    g.setThreshold(static_cast<float>(dbToLin(-40.0)));
    std::vector<float> in(kBlockFrames), out(kBlockFrames);
    int crossings = 0;
    bool open = false;
    for (uint32_t n = 0; n < rate; n += kBlockFrames) {
      for (uint32_t i = 0; i < kBlockFrames; ++i) {
        in[i] = static_cast<float>(dbToLin(-40.0) * std::sin(2.0 * M_PI * 440.0 * (n + i) / rate));
      }
      g.process(in.data(), out.data(), kBlockFrames);
      const bool nowOpen = g.openness() > 0.5f;
      if (nowOpen != open) { ++crossings; open = nowOpen; }
    }
    check("a signal sitting on the threshold does not chatter", crossings <= 2, crossings); }

  // The threshold means what the schema says it means.
  { Gate g; g.reset();
    const double justUnder = run(g, -40.0, 1.0, sine(dbToLin(-50.0), 440.0));
    Gate h; h.reset();
    const double justOver = run(h, -40.0, 1.0, sine(dbToLin(-30.0), 440.0));
    check("the threshold separates 10 dB below from 10 dB above",
          justUnder < justOver * 0.01, justUnder / (justOver + 1e-12)); }

  std::printf("\n%s\n", failures ? "FAILURES" : "all gate checks passed");
  return failures ? 1 : 0;
}
