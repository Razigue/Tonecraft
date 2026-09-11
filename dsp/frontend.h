/* =============================================================================
   dsp/frontend.h — the input stage, ahead of the amplifier
   -----------------------------------------------------------------------------
   A NAM capture is a frozen snapshot: it has no controls. What can be set is
   what goes into it. This stage holds the two blocks that matter before the
   amp — a noise gate, which high gain cannot do without, and a Tube Screamer
   style boost that cuts the low end before the saturation — plus the choice of
   which captured channel feeds the chain at all.

   It is a port of what was public/nam/frontend-worklet.js, line for line: the
   same constants, the same double-precision state, the same float32 at the
   places the worklet crossed a Float32Array. Only the host changed.

   The boost is the only hand-written non-linearity in the chain. It runs at 4x
   oversampling with antiderivative anti-aliasing. Measured by
   `npm run measure` (worst case of three test notes, in-band aliasing relative
   to the fundamental): naive -24 dBc, 4x alone -68 dBc, 4x + ADAA -94 dBc.
   ========================================================================== */
#pragma once

namespace tc {

class Pitch;

/* A cascade of first-order all-pass sections, (a + z^-1) / (1 + a z^-1). */
struct AllpassChain {
  static constexpr int MAX = 4;
  int count = 0;
  double a[MAX] = {};
  double x1[MAX] = {};
  double y1[MAX] = {};

  double tick(double v) {
    for (int k = 0; k < count; k++) {
      const double y = a[k] * (v - y1[k]) + x1[k];
      x1[k] = v;
      y1[k] = y;
      v = y;
    }
    return v;
  }
};

/* One 2x stage: an elliptic half-band split into two all-pass branches
   (Valenzuela & Constantinides). Group delay of a few samples at the high rate,
   not half a filter length — see HALFBAND in frontend.cpp. */
struct HalfbandStage {
  AllpassChain up0, up1, dn0, dn1;
  double prev = 0.0;

  void init(const double* coefs, int n);
  /* x: n samples -> out: 2n. */
  void up(const double* x, int n, double* out);
  /* x: 2n samples -> out: n. */
  void down(const double* x, int n, double* out);
};

class Frontend {
 public:
  static constexpr int BLOCK = 128;
  static constexpr int MAX_STAGES = 3;

  /* `stages` is log2 of the oversampling factor. What ships is 2 (4x) with
     ADAA; the other combinations exist for `tc_measure_boost` only. */
  void init(double sampleRate, int stages = 2, bool adaa = true);

  /* a, b: the captured channels (b null for a mono source); n <= BLOCK.
     out: what goes to the amplifier. tuner: the selected channel, clean.
     pitch: the transposer, between the gate and the boost — the gate decides
     on the clean guitar, and what the boost drives is the shifted note. */
  void process(const float* a, const float* b, int n,
               double inputGain, double gateDb, double boost, double tone,
               float* out, float* tuner, Pitch* pitch = nullptr);

  void setChannel(int code);

  /* The gated signal of the last block: input gain, DC blocker, gate. */
  const double* gated() const { return pre_; }
  /* The same, after the transposer — what the boost was actually given. */
  const double* shifted() const { return post_; }

  /* Metering, accumulated since the last reset. */
  double peakIn = 0.0, peakOut = 0.0;
  double chPeak[2] = {0.0, 0.0};
  double eAll = 0.0, eHigh = 0.0;
  double gateGain() const { return gg_; }
  int following() const { return channel_ == -2 ? autoPick_ : -1; }
  void resetMeters();

 private:
  void pick(const float* a, const float* b, int n);
  double adaa(double u);

  double sr_ = 48000.0;
  int stages_ = 2;
  bool adaa_ = true;

  // noise gate
  double env_ = 0.0, gg_ = 0.0;
  bool open_ = false;
  double attC_ = 0.0, relC_ = 0.0, envC_ = 0.0;
  // DC blocker
  double dx_ = 0.0, dy_ = 0.0, dA_ = 0.0;
  // control smoothing
  double sGain_ = 1.0, sBoost_ = 0.0, sTone_ = 0.5;
  double smoothC_ = 0.0;
  // boost
  HalfbandStage os_[MAX_STAGES];
  double bA_ = 0.0, bx_ = 0.0, by_ = 0.0;
  double tLP_ = 0.0, tl_ = 0.0;
  double pu_ = 0.0, pf_ = 0.0;   // ADAA state
  // brightness detector
  double brA_ = 0.0, bhx_ = 0.0, bhy_ = 0.0;
  // channel choice
  int channel_ = -2;
  double autoAcc_[2] = {0.0, 0.0};
  int autoN_ = 0, autoPick_ = 0;

  float mono_[BLOCK] = {};
  double pre_[BLOCK] = {};
  double shifted_[BLOCK] = {};
  const double* post_ = pre_;
  double outBuf_[BLOCK] = {};
  double up_[MAX_STAGES][BLOCK << MAX_STAGES] = {};
  double dn_[MAX_STAGES][BLOCK << MAX_STAGES] = {};
};

}  // namespace tc
