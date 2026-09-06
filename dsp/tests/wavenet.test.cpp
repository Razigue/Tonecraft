// Does our WaveNet compute the same amplifier NAM does?
//
// This is the only question that matters about the port, and it is not one that
// can be answered by ear or by a spectrum. A network read with one dimension
// transposed, or a convolution tap off by one, does not fail: it produces
// plausible audio that is not the model anyone trained. So the test is an
// equivalence check against NAM core itself.
//
// `fixtures/feather.golden.f32` is the last 1024 frames of 8192 rendered by
// NeuralAmpModelerCore through `fixtures/feather.tcnm`'s source model, with
// fast tanh on, in 128-frame blocks, after its own prewarm. The input is
// generated here by an integer LCG so both sides see identical bits with no
// dependence on anyone's libm, and it is committed rather than regenerated
// because the point is to notice when *we* change.
//
// Bit equality is not the bar and should not be. NAM reaches its dot products
// through Eigen's GEMM and we reach ours through four hand-split accumulators
// (AD-4), so the two sum the same products in a different order. The bar is
// that the difference stays at the level float arithmetic explains.

#include <cmath>
#include <cstdio>
#include <cstdint>
#include <fstream>
#include <vector>

#include "model/wavenet.h"

using namespace tonecraft;

static int failures = 0;
static void check(const char* name, bool ok, double got = 0) {
  if (ok) { std::printf("  ok    %s\n", name); return; }
  ++failures;
  std::printf("  FAIL  %s (got %g)\n", name, got);
}

static std::vector<uint8_t> readBytes(const char* path) {
  std::ifstream f(path, std::ios::binary);
  return {std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>()};
}

/// The same generator the golden renderer used. Integer arithmetic throughout,
/// so it is identical on every machine and every compiler.
struct Input {
  uint32_t state = 0x12345678u;
  uint32_t n = 0;
  float next() {
    state = state * 1664525u + 1013904223u;
    const int32_t v = static_cast<int32_t>(state >> 8) - (1 << 23);
    const float noise = static_cast<float>(v) * (1.0f / static_cast<float>(1 << 24));
    // A ramp, so the test covers the quiet playing where a network's behaviour
    // is least like a static curve, not only the loud part where a tanh
    // flattens every difference away.
    const float ramp = static_cast<float>(n % 1024) * (1.0f / 1024.0f);
    ++n;
    return noise * ramp;
  }
};

int main() {
  WaveNetAmp amp;
  amp.init();

  // --- the loader refuses everything it should ----------------------------
  {
    const auto good = readBytes("dsp/tests/fixtures/feather.tcnm");
    if (good.empty()) {
      std::printf("  FAIL  dsp/tests/fixtures/feather.tcnm is missing\n");
      return 1;
    }

    check("a truncated blob is refused",
          amp.load(good.data(), 8) == ModelStatus::TooShort);

    auto corrupt = [&](uint32_t offset, uint32_t value) {
      auto copy = good;
      std::memcpy(copy.data() + offset, &value, sizeof value);
      return amp.load(copy.data(), static_cast<uint32_t>(copy.size()));
    };
    check("a foreign magic is refused", corrupt(0, 0xDEADBEEF) == ModelStatus::BadMagic);
    check("a future version is refused", corrupt(4, kModelBlobVersion + 1) == ModelStatus::UnsupportedVersion);
    check("too many layer arrays is refused", corrupt(20, kModelMaxLayerArrays + 1) == ModelStatus::TooLarge);
    check("too many weights is refused", corrupt(24, kModelMaxWeights + 1) == ModelStatus::TooLarge);
    // Byte 28 is the first array's input_size. Anything but 1 means the first
    // array is not being fed the mono chain.
    check("a first array that is not mono is refused", corrupt(28, 2) == ModelStatus::ShapeMismatch);
    // Byte 40 is the first array's head_size, which has to equal the second
    // array's channel count or the head accumulator does not line up.
    check("mismatched array widths are refused", corrupt(40, 5) == ModelStatus::ShapeMismatch);
    // Byte 44 is the kernel size.
    check("an over-long kernel is refused", corrupt(44, kModelMaxKernelSize + 1) == ModelStatus::TooLarge);
    // Byte 8 is the rate the model was trained at. A model trained elsewhere is
    // a different amplifier, and adapting to it silently is the one failure
    // this loader exists to make loud.
    check("a model trained at another rate is refused",
          corrupt(8, 44100) == ModelStatus::WrongDesignRate);

    // A blob whose header is intact but whose weights were cut short: the
    // shape says one thing and the file carries another.
    {
      auto shortened = good;
      shortened.resize(good.size() - 4);
      check("a blob short of its declared weights is refused",
            amp.load(shortened.data(), static_cast<uint32_t>(shortened.size())) == ModelStatus::TooShort);
    }

    check("the fixture loads",
          amp.load(good.data(), static_cast<uint32_t>(good.size())) == ModelStatus::Ok);
  }

  check("a refused load leaves nothing loaded behind", amp.loaded());
  check("the loudness the trainer measured survives",
        amp.hasLoudness() && std::fabs(amp.loudnessDb() + 20.0f) < 1e-4f, amp.loudnessDb());
  // Two arrays of ten layers, kernel 3, dilations 1..512: 2 * 2 * 1023, plus
  // the one sample NAM adds for a model with no condition DSP.
  check("the receptive field matches NAM's", amp.receptiveField() == 4093, amp.receptiveField());

  // --- the equivalence check ---------------------------------------------
  std::vector<float> golden(1024);
  {
    std::ifstream f("dsp/tests/fixtures/feather.golden.f32", std::ios::binary);
    f.read(reinterpret_cast<char*>(golden.data()), static_cast<std::streamsize>(golden.size() * sizeof(float)));
    if (!f) { std::printf("  FAIL  dsp/tests/fixtures/feather.golden.f32 is missing\n"); return 1; }
  }

  Input input;
  std::vector<float> in(kBlockFrames), out(kBlockFrames), rendered;
  rendered.reserve(8192);
  for (uint32_t n = 0; n < 8192; n += kBlockFrames) {
    for (uint32_t i = 0; i < kBlockFrames; ++i) in[i] = input.next();
    amp.process(in.data(), out.data(), kBlockFrames);
    rendered.insert(rendered.end(), out.begin(), out.end());
  }

  double worst = 0.0, energy = 0.0, error = 0.0;
  for (size_t i = 0; i < golden.size(); ++i) {
    const double a = rendered[rendered.size() - golden.size() + i];
    const double b = golden[i];
    worst = std::fmax(worst, std::fabs(a - b));
    energy += b * b;
    error += (a - b) * (a - b);
  }
  const double peak = [&] {
    double p = 0.0;
    for (float v : golden) p = std::fmax(p, std::fabs(static_cast<double>(v)));
    return p;
  }();
  const double snrDb = 10.0 * std::log10(energy / (error + 1e-30));

  // The model is not silent, or every check below passes trivially.
  check("the reference render is not silence", peak > 1e-3, peak);
  // 90 dB, and the margin either side of it was measured rather than guessed.
  // Single-precision reassociation over a stack this deep lands around 99 dB
  // and moves by a decibel or so whenever the accumulation order changes, which
  // is a legitimate thing to do (AD-4). The failures this test exists to catch
  // are nowhere near: transposing the weight matrix scores -5 dB and reversing
  // the convolution's causal tap order scores -2 dB. There is a hundred
  // decibels of empty space between the two, so the threshold sits in it.
  check("our render matches NAM's", snrDb > 90.0, snrDb);
  check("no single sample diverges", worst < peak * 1e-3, worst / peak);
  std::printf("        agreement with NeuralAmpModelerCore: %.1f dB, worst sample %.2e\n", snrDb, worst);

  // --- the block size must not change the result -------------------------
  // The history rewind is the only thing in here whose behaviour depends on
  // where a block boundary falls, and a rewind that dropped or duplicated a
  // frame would still produce plausible audio.
  {
    amp.reset();
    Input again;
    std::vector<float> small(32), smallOut(32), second;
    second.reserve(8192);
    for (uint32_t n = 0; n < 8192; n += 32) {
      for (uint32_t i = 0; i < 32; ++i) small[i] = again.next();
      amp.process(small.data(), smallOut.data(), 32);
      second.insert(second.end(), smallOut.begin(), smallOut.end());
    }
    double drift = 0.0;
    for (size_t i = 4096; i < second.size(); ++i) {
      drift = std::fmax(drift, std::fabs(static_cast<double>(second[i]) - rendered[i]));
    }
    check("32-frame blocks give the same audio as 128", drift < peak * 1e-4, drift / peak);
  }

  // --- reset is repeatable ------------------------------------------------
  // A model that settles somewhere slightly different each time it is reset
  // would make the build-time render and the real-time path disagree, which is
  // the one thing the listen path cannot survive.
  {
    amp.reset();
    Input again;
    std::vector<float> third;
    third.reserve(8192);
    for (uint32_t n = 0; n < 8192; n += kBlockFrames) {
      for (uint32_t i = 0; i < kBlockFrames; ++i) in[i] = again.next();
      amp.process(in.data(), out.data(), kBlockFrames);
      third.insert(third.end(), out.begin(), out.end());
    }
    double drift = 0.0;
    for (size_t i = 0; i < third.size(); ++i) {
      drift = std::fmax(drift, std::fabs(static_cast<double>(third[i]) - rendered[i]));
    }
    check("reset settles to the same state every time", drift == 0.0, drift);
  }

  // --- an unloaded model passes audio through, it does not go silent ------
  {
    WaveNetAmp empty;
    empty.init();
    for (uint32_t i = 0; i < kBlockFrames; ++i) in[i] = 0.25f;
    empty.process(in.data(), out.data(), kBlockFrames);
    check("an unloaded model is a wire, not a mute", out[0] == 0.25f, out[0]);
  }

  std::printf(failures == 0 ? "\n  all good\n" : "\n  %d failed\n", failures);
  return failures == 0 ? 0 : 1;
}
