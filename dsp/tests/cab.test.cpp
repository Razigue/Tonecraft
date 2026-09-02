// Does the cabinet do what a cabinet does?
//
// The one thing that matters most for a high-gain tone: everything the preamp
// generated above about 5 kHz has to go. A model that leaves it there is the
// difference between an amplifier and a wasp.

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <vector>

#include "cab/cab.h"

using namespace tonecraft;

static int failures = 0;
static void check(const char* name, bool ok, double got = 0) {
  if (ok) { std::printf("  ok    %s\n", name); return; }
  ++failures;
  std::printf("  FAIL  %s (got %.3f)\n", name, got);
}

static double bin(const std::vector<float>& x, double f, double rate) {
  const double w = 2.0 * M_PI * f / rate, c = 2.0 * std::cos(w);
  double s1 = 0, s2 = 0;
  for (float v : x) { const double s0 = v + c * s1 - s2; s2 = s1; s1 = s0; }
  return 2.0 * std::sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / x.size();
}

static std::vector<uint8_t> readIr() {
  std::ifstream f("assets/cab.tcir", std::ios::binary);
  return {std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>()};
}

static double responseDb(Cab& cab, double f) {
  const double rate = kInternalSampleRate;
  cab.reset();
  cab.setMix(1.0f);
  std::vector<float> in(kBlockFrames), out(kBlockFrames), got;
  const uint32_t total = (uint32_t)(rate * 0.3);
  for (uint32_t n = 0; n < total; n += kBlockFrames) {
    for (uint32_t i = 0; i < kBlockFrames; ++i)
      in[i] = (float)(0.2 * std::sin(2.0 * M_PI * f * (n + i) / rate));
    cab.process(in.data(), out.data(), kBlockFrames);
    if (n > total / 3) got.insert(got.end(), out.begin(), out.end());
  }
  return 20.0 * std::log10(bin(got, f, rate) / 0.2 + 1e-30);
}

int main() {
  const auto blob = readIr();
  if (blob.empty()) { std::printf("  FAIL  assets/cab.tcir is missing\n"); return 1; }

  Cab cab;

  // --- the loader refuses everything it should ----------------------------
  {
    auto corrupt = [&](uint32_t offset, uint32_t value) {
      auto copy = blob;
      std::memcpy(copy.data() + offset, &value, sizeof value);
      return cab.load(copy.data(), (uint32_t)copy.size());
    };
    check("a bad magic is refused", corrupt(0, 0xdeadbeef) == IrStatus::BadMagic);
    check("an unsupported version is refused", corrupt(4, 99) == IrStatus::UnsupportedVersion);
    // Refused by name, never truncated: a silently shortened cabinet is a
    // different cabinet, and switching algorithm behind the player's back is
    // exactly what AD-3 forbids.
    check("an IR longer than the FIR is sized for is refused, not truncated",
          corrupt(8, kMaxIrTaps + 1) == IrStatus::TooManyTaps);
    check("a header that lies about its length is refused",
          cab.load(blob.data(), 40) == IrStatus::TooShort);
    check("nothing partial is left loaded after a refusal", !cab.loaded());
  }

  check("the shipped IR loads", cab.load(blob.data(), (uint32_t)blob.size()) == IrStatus::Ok);
  check("and fits inside the tap budget", cab.taps() <= kMaxIrTaps, cab.taps());

  // --- it is a cabinet ----------------------------------------------------
  const double ref = responseDb(cab, 1000.0);
  std::printf("        response: ");
  for (double f : {80.0, 110.0, 700.0, 2600.0, 5000.0, 8000.0, 12000.0})
    std::printf("%.0fHz %.1f  ", f, responseDb(cab, f) - ref);
  std::printf("\n");

  check("the fizz above 8 kHz is gone", responseDb(cab, 8000.0) - ref < -18.0,
        responseDb(cab, 8000.0) - ref);
  check("and what is left at 12 kHz is inaudible",
        responseDb(cab, 12000.0) - ref < -35.0, responseDb(cab, 12000.0) - ref);
  // The corner sits at 58 Hz rather than 82: a 4x12 has real weight down to the
  // low E, and cutting into it was part of what made this sound like a small
  // amplifier. What must still go is everything below the instrument.
  check("what is below the instrument is rolled off",
        responseDb(cab, 35.0) - ref < -6.0, responseDb(cab, 35.0) - ref);
  check("and the low E still has weight",
        responseDb(cab, 82.0) - ref > -2.0, responseDb(cab, 82.0) - ref);
  check("there is a resonance where a cone and a box argue",
        responseDb(cab, 110.0) - ref > 3.0, responseDb(cab, 110.0) - ref);
  // Halved from +5 dB: at that level it was the brittle top that reads as a
  // cheap speaker rather than a loud one.
  check("and a presence peak, which is the bite",
        responseDb(cab, 2300.0) - ref > 1.5, responseDb(cab, 2300.0) - ref);
  check("unity at 1 kHz, so switching it in is not a volume change",
        std::fabs(ref) < 1.0, ref);

  // --- mix, and bypass by another name -------------------------------------
  cab.setMix(0.0f);
  {
    cab.reset();
    std::vector<float> in(kBlockFrames), out(kBlockFrames);
    for (uint32_t i = 0; i < kBlockFrames; ++i) in[i] = (float)(0.3 * std::sin(i * 0.1));
    cab.process(in.data(), out.data(), kBlockFrames);
    double worst = 0;
    for (uint32_t i = 0; i < kBlockFrames; ++i)
      worst = std::max(worst, (double)std::fabs(out[i] - in[i]));
    check("mix at zero passes the signal through untouched", worst < 1e-6, worst);
  }

  std::printf("\n%s\n", failures ? "FAILURES" : "all cab checks passed");
  return failures ? 1 : 0;
}
