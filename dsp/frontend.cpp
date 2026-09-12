/* dsp/frontend.cpp — see frontend.h. */

#include "frontend.h"

#include <cmath>

#include "pitch.h"

namespace tc {

namespace {

/* Each 2x stage is the shortest elliptic half-band whose stopband sits at or
   below -100 dB with the passband reaching 20 kHz (scripts/design-halfband.ts):
       48k  -> 96k    7 sections   -112 dB   group delay 3.7 samples at 96k
       96k  -> 192k   3 sections   -102 dB   group delay 2.2 samples at 192k
       192k -> 384k   2 sections   -102 dB   group delay 1.6 samples at 384k
   The linear-phase FIR these replaced put 36 samples — 0.76 ms at 48 kHz —
   between the pick and the amp. The phase is not linear inside the transition
   band, which starts at 20 kHz, where nothing is audible. */
const double HALFBAND_0[] = {0.033397507751963, 0.126292938978164, 0.260582948456779,
                             0.415885885622256, 0.577350269189626, 0.739707378355978,
                             0.908403153754175};
const double HALFBAND_1[] = {0.063787836824299, 0.266780962497159, 0.668548793183609};
const double HALFBAND_2[] = {0.110301209912266, 0.536772123666460};
const double* const HALFBAND[] = {HALFBAND_0, HALFBAND_1, HALFBAND_2};
const int HALFBAND_N[] = {7, 3, 2};

/* tanh: Pade 7/6 approximation, error < 1e-6 over [-4, 4]. */
double tnh(double x) {
  if (x > 4) return 1;
  if (x < -4) return -1;
  const double x2 = x * x;
  return x * (135135 + x2 * (17325 + x2 * (378 + x2))) /
         (135135 + x2 * (62370 + x2 * (3150 + x2 * 28)));
}

/* ln(cosh(x)): the antiderivative of tanh, written so it can never overflow. */
double lncosh(double x) {
  const double a = x < 0 ? -x : x;
  return a + std::log1p(std::exp(-2 * a)) - 0.6931471805599453;
}

double onePoleHP(double fc, double sr) { return 1 / (1 + 2 * M_PI * fc / sr); }
double onePoleLP(double fc, double sr) { return 1 - std::exp(-2 * M_PI * fc / sr); }

}  // namespace

/* Even-indexed coefficients form the branch that lands on the even output
   samples; odd-indexed ones the branch behind the one-sample delay. The other
   pairing is not a filter at all: 12 dB of passband ripple. */
void HalfbandStage::init(const double* coefs, int n) {
  up0 = up1 = dn0 = dn1 = AllpassChain{};
  for (int i = 0; i < n; i++) {
    AllpassChain& u = (i % 2 == 0) ? up0 : up1;
    AllpassChain& d = (i % 2 == 0) ? dn0 : dn1;
    u.a[u.count++] = coefs[i];
    d.a[d.count++] = coefs[i];
  }
  prev = 0.0;
}

/* Polyphase interpolator: both branches run at the low rate on the same input,
   and their outputs interleave. */
void HalfbandStage::up(const double* x, int n, double* out) {
  for (int i = 0; i < n; i++) {
    const double v = x[i];
    out[2 * i] = up0.tick(v);
    out[2 * i + 1] = up1.tick(v);
  }
}

/* Polyphase decimator: the even-phase samples through one branch, the
   odd-phase samples — one high-rate sample earlier — through the other. */
void HalfbandStage::down(const double* x, int n, double* out) {
  double p = prev;
  for (int i = 0; i < n; i++) {
    out[i] = 0.5 * (dn0.tick(x[2 * i]) + dn1.tick(p));
    p = x[2 * i + 1];
  }
  prev = p;
}

void Frontend::init(double sampleRate, int stages, bool adaa) {
  *this = Frontend{};
  // The wholesale reset above copies a temporary, whose `post_` pointed into
  // itself. It has to be pointed back at this object's own buffer.
  post_ = pre_;
  sr_ = sampleRate;
  stages_ = stages < 0 ? 0 : stages > MAX_STAGES ? MAX_STAGES : stages;
  adaa_ = adaa;

  attC_ = 1 - std::exp(-1 / (sr_ * 0.0012));   // open: 1.2 ms
  /* Close: 8 ms. The applied gain is gg squared, reaching -60 dB about
     28 ms after the detector closes (previously 41 ms at 12 ms).
     The 6 dB hysteresis below keeps the gate from chattering. */
  relC_ = 1 - std::exp(-1 / (sr_ * 0.008));
  envC_ = 1 - std::exp(-1 / (sr_ * 0.0025));   // detector: 2.5 ms
  dA_ = onePoleHP(18, sr_);

  for (int k = 0; k < stages_; k++) os_[k].init(HALFBAND[k], HALFBAND_N[k]);
  const double osr = sr_ * (1 << stages_);
  bA_ = onePoleHP(720, osr);          // the heart of the "TS" sound: cuts below 720 Hz
  tLP_ = onePoleLP(5200, osr);        // the pedal's tone control
  pu_ = 0.0;
  pf_ = lncosh(0.0);
  // ~12 ms: slow enough to be inaudible, fast enough to follow the hand
  smoothC_ = 1 - std::exp(-1 / (osr * 0.012));

  /* Brightness: the share of the arriving energy above 2 kHz. With a weak peak
     on an onboard device it is the signature of a guitar plugged into a
     microphone input, which loads the pickup and takes the highs with it. */
  brA_ = onePoleHP(2000, sr_);
}

void Frontend::setChannel(int code) {
  channel_ = code;
  autoAcc_[0] = autoAcc_[1] = 0.0;
  autoN_ = 0;
}

void Frontend::resetMeters() {
  peakIn = peakOut = 0.0;
  chPeak[0] = chPeak[1] = 0.0;
  eAll = eHigh = 0.0;
}

/* Antiderivative anti-aliasing: the non-linearity averaged over the interval
   between two samples, which attenuates at the source the harmonics that
   would fold back. When two samples are too close the divided difference goes
   unstable, and the midpoint is its exact limit. */
double Frontend::adaa(double u) {
  if (!adaa_) return tnh(u);
  const double F = lncosh(u);
  const double du = u - pu_;
  const double y = (du > 1e-6 || du < -1e-6) ? (F - pf_) / du : tnh(0.5 * (u + pu_));
  pu_ = u;
  pf_ = F;
  return y;
}

/* Collapses the capture to the one mono signal the chain runs on, measuring
   each channel on the way past: peaks per channel are what makes "which input
   is my guitar on" something you can see rather than guess. */
void Frontend::pick(const float* a, const float* b, int n) {
  double pA = 0.0, pB = 0.0;
  for (int i = 0; i < n; i++) {
    const double va = a[i] < 0 ? -a[i] : a[i];
    if (va > pA) pA = va;
  }
  if (b != nullptr) {
    for (int i = 0; i < n; i++) {
      const double vb = b[i] < 0 ? -b[i] : b[i];
      if (vb > pB) pB = vb;
    }
  }
  if (pA > chPeak[0]) chPeak[0] = pA;
  if (pB > chPeak[1]) chPeak[1] = pB;

  if (b == nullptr) {
    for (int i = 0; i < n; i++) mono_[i] = a[i];
    return;
  }

  int pickCh = channel_;
  if (pickCh == -2) {
    // Many interfaces present a stereo input with only one side wired. A
    // clear margin is required, so a little bleed cannot flip it.
    autoAcc_[0] += pA;
    autoAcc_[1] += pB;
    if (++autoN_ >= 30) {
      autoPick_ = autoAcc_[1] > autoAcc_[0] * 3 ? 1 : 0;
      autoAcc_[0] = autoAcc_[1] = 0.0;
      autoN_ = 0;
    }
    pickCh = autoPick_;
  }

  if (pickCh == 0) for (int i = 0; i < n; i++) mono_[i] = a[i];
  else if (pickCh == 1) for (int i = 0; i < n; i++) mono_[i] = b[i];
  else for (int i = 0; i < n; i++) mono_[i] = static_cast<float>(0.5 * (static_cast<double>(a[i]) + b[i]));
}

void Frontend::process(const float* a, const float* b, int n,
                       double gTarget, double gateDb, double boost, double tone,
                       float* out, float* tuner, Pitch* pitch) {
  pick(a, b, n);
  const float* inp = mono_;
  if (tuner != nullptr) for (int i = 0; i < n; i++) tuner[i] = inp[i];

  const double thr = gateDb <= -99 ? 0 : std::pow(10.0, gateDb / 20);

  /* --- input gain, DC blocking, noise gate --- */
  double pkIn = 0.0;
  for (int i = 0; i < n; i++) {
    const double raw = inp[i];
    // measured on what arrives, before our own gain touches it
    const double bh = brA_ * (bhy_ + raw - bhx_);
    bhx_ = raw;
    bhy_ = bh;
    eAll += raw * raw;
    eHigh += bh * bh;

    sGain_ += 0.02 * (gTarget - sGain_);
    double x = raw * sGain_;

    const double a0 = x < 0 ? -x : x;
    if (a0 > pkIn) pkIn = a0;

    const double dy = dA_ * (dy_ + x - dx_);
    dx_ = x;
    dy_ = dy;
    /* Plus a constant 360 dB below full scale. Once the gate has closed the
       chain runs on exact zeros, every filter state decays into denormal range
       and stays there, and on older cores arithmetic on a denormal is a
       microcode assist of about a hundred cycles — per state, per sample,
       across the oversampler's sections at 192 kHz. A DC far below anything
       audible keeps every state a normal number. */
    x = dy + 1e-18;

    // gate: fast attack, 6 dB of hysteresis so it cannot chatter
    const double av = x < 0 ? -x : x;
    env_ += (av > env_ ? 0.55 : envC_) * (av - env_);
    if (thr > 0) {
      open_ = env_ > (open_ ? thr * 0.5 : thr);
      const double tgt = open_ ? 1 : 0;
      gg_ += (tgt > gg_ ? attC_ : relC_) * (tgt - gg_);
      if (gg_ < 1e-20) gg_ = 0;          // a closed gate is closed, not denormal
      x *= gg_ * gg_;                    // squared: a gentler close
      if (gg_ == 0) x = 1e-18;           // the guard survives the gate
    }
    pre_[i] = x;
  }

  /* --- the transposer ---
     After the gate, so a closed gate is silence going in rather than grains of
     hiss coming out, and before the boost, where a pitch pedal sits on a
     board. It is a wire unless it is engaged (dsp/pitch.cpp). */
  const double* src = pre_;
  if (pitch != nullptr) {
    pitch->process(pre_, shifted_, n);
    src = shifted_;
  }
  post_ = src;

  /* --- boost, oversampled ---
     Controls arrive once per block. Smoothing them at the block rate would be a
     375 Hz staircase modulating the non-linearity — sidebands measured at
     -78 dBc — so the smoothing runs per sample, in the oversampled domain. */
  if (boost > 0.001 || sBoost_ > 0.001) {
    const double* cur = src;
    int cn = n;
    for (int k = 0; k < stages_; k++) {
      os_[k].up(cur, cn, up_[k]);
      cur = up_[k];
      cn *= 2;
    }
    if (stages_ == 0 && src != shifted_) {
      // No oversampling (measurement only): the boost writes in place, so it
      // needs a buffer of its own rather than the gate's.
      for (int i = 0; i < n; i++) shifted_[i] = src[i];
    }
    double* buf = stages_ > 0 ? up_[stages_ - 1] : shifted_;
    const int on = cn;
    const double cB = smoothC_;

    for (int i = 0; i < on; i++) {
      sBoost_ += cB * (boost - sBoost_);
      sTone_ += cB * (tone - sTone_);
      const double bb = sBoost_;

      const double x = buf[i];
      const double h = bA_ * (by_ + x - bx_);    // 720 Hz highpass
      bx_ = x;
      by_ = h;
      const double low = x - h;
      const double sat = adaa(h * (1 + 24 * bb));
      const double y = low * (1 - 0.55 * bb) + sat * (0.55 + 0.45 * bb);
      const double toneC = tLP_ * (0.35 + 1.3 * sTone_);   // tone control
      tl_ += (toneC < 1 ? toneC : 1) * (y - tl_);
      buf[i] = tl_ * (1 + 1.1 * bb);
    }

    if (stages_ == 0) {
      for (int i = 0; i < n; i++) outBuf_[i] = buf[i];
    } else {
      cur = buf;
      cn = on;
      for (int k = stages_ - 1; k >= 0; k--) {
        const int half = cn >> 1;
        double* dst = (k == 0) ? outBuf_ : dn_[k];
        os_[k].down(cur, half, dst);
        cur = dst;
        cn = half;
      }
    }
    for (int i = 0; i < n; i++) out[i] = static_cast<float>(outBuf_[i]);
  } else {
    for (int i = 0; i < n; i++) out[i] = static_cast<float>(src[i]);
  }

  double pkOut = 0.0;
  for (int i = 0; i < n; i++) {
    const double av = out[i] < 0 ? -out[i] : out[i];
    if (av > pkOut) pkOut = av;
  }
  if (pkIn > peakIn) peakIn = pkIn;
  if (pkOut > peakOut) peakOut = pkOut;
}

}  // namespace tc
