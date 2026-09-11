/* =============================================================================
   dsp/pitch.cpp — see pitch.h
   -----------------------------------------------------------------------------
   How it works
   ------------
   The input is written into a delay line at the host's rate and read back at
   2^(semitones/12) times that rate, which transposes it and, on its own, would
   run off the end of the line in a fraction of a second. So there are two read
   heads: each lives `grain_` samples, then jumps back to where it started
   while the other one carries the sound, and a raised-cosine window crossfades
   between them. The two windows are exactly complementary, so a steady signal
   comes out at a steady level.

   What makes a splice audible is phase: two copies of the same note added at
   an arbitrary offset comb. Each jump therefore does not land on a fixed
   point. It searches back over `search_` samples for the offset whose waveform
   best matches what the other head is playing — normalised cross-correlation,
   coarse on a stride grid and then refined sample by sample — and lands there.
   For anything periodic, which a guitar is, that is a whole number of periods
   away, and the crossfade adds two copies in phase. This is the difference
   between "an octave pedal" and the warble a plain delay-line shifter makes.

   What it costs
   -------------
   Latency, and only while it is engaged. Two things add to it: the delay a
   head travels over its life, which is |1 - ratio| * grain, and the distance
   the search had to go back to find a matching point — which, for a periodic
   signal, settles at about one period of the note being played. There is no
   way round the second one: aligning two copies of a waveform means waiting
   for it to come round again.

   Measured on a low A, `npm run measure:latency`, worst case at 48 kHz:

       no shift            0.00 ms      a wire, nothing runs
       one semitone        8.65 ms
       an octave down      8.62 ms
       a fifth up          9.04 ms
       an octave up       14.10 ms      the delay travels a whole grain here

   The chain reports the live figure in the meter frame and the interface adds
   it to the round trip it shows, because a delay nobody mentions is a delay
   the player blames on the product. Bypassed, and at a shift of zero, the
   stage is a wire: no delay, no filter, nothing to read back.

   CPU: about 40 flops a sample for the two heads and the anti-image filter,
   plus one correlation search every `grain_ / 2` samples — roughly 20k
   multiply-adds, a hundred times a second. Measured by `npm run bench`.

   Why not a phase vocoder: an FFT of a size that holds a low E is 40 ms of
   latency before any of the above, which is the whole budget (CLAUDE.md
   section 3) spent on one stage, and its transient smearing is exactly what a
   pick attack is made of.
   ========================================================================== */

#include "pitch.h"

#include <cmath>
#include <cstring>

namespace tc {

namespace {

/* A head's life, and so the distance it travels before it is spliced again.
   It is the whole trade: longer splices less often and sounds smoother, and
   costs latency at an octave up, where the delay travels a whole grain. 20 ms
   measured 22 ms of delay there and 12 ms everywhere else; 14 ms brings that
   to 14 and 9 for a tenth of a dB of ripple and a few dB of splice noise. */
constexpr double GRAIN_SECONDS = 0.014;
/* How far back a splice may look for a matching point: one period of the
   lowest note a six-string plays (82 Hz is 12.2 ms). */
constexpr double SEARCH_SECONDS = 0.012;
/* How much waveform the match is judged on. */
constexpr double CORR_SECONDS = 0.010;
/* The interpolator reads one sample either side of the fraction. */
constexpr double MIN_DELAY = 4.0;
/* Below this the input is silence and any splice point is as good as another. */
constexpr double QUIET = 1e-9;

int64_t pow2AtLeast(double n) {
  int64_t p = 1;
  while (static_cast<double>(p) < n) p <<= 1;
  return p;
}

}  // namespace

void LowPass::design(double cutoff, double sampleRate, double q) {
  const double nyquist = sampleRate * 0.49;
  const double f = cutoff > nyquist ? nyquist : (cutoff < 20.0 ? 20.0 : cutoff);
  const double w = 2.0 * M_PI * f / sampleRate;
  const double cw = std::cos(w);
  const double sw = std::sin(w);
  const double alpha = sw / (2.0 * q);
  const double a0 = 1.0 + alpha;
  b0 = ((1.0 - cw) / 2.0) / a0;
  b1 = (1.0 - cw) / a0;
  b2 = b0;
  a1 = (-2.0 * cw) / a0;
  a2 = (1.0 - alpha) / a0;
}

void Pitch::init(double sampleRate) {
  sr_ = sampleRate > 0 ? sampleRate : 48000.0;
  grain_ = static_cast<int>(GRAIN_SECONDS * sr_) & ~1;   // even: half a life is a whole sample
  search_ = static_cast<int>(SEARCH_SECONDS * sr_);
  corr_ = static_cast<int>(CORR_SECONDS * sr_);
  /* The coarse search compares one sample in `stride_`, which is chosen so the
     work is the same at every rate: about 12 kHz of resolution, then refined
     sample by sample. Guitar content that matters to a correlation is an order
     of magnitude below that. */
  stride_ = static_cast<int>(sr_ / 12000.0);
  if (stride_ < 1) stride_ = 1;

  const double needed = MIN_DELAY + search_ + 1.5 * grain_ + corr_ + 16.0;
  const int64_t size = pow2AtLeast(needed);
  buf_.assign(static_cast<size_t>(size), 0.0f);
  mask_ = size - 1;
  maxDelay_ = static_cast<double>(size) - corr_ - 16.0;
  w_ = size;   // a whole buffer of zeros behind the first sample ever written

  shift_.init(0.020, sr_, 0.0);
  wet_.init(0.020, sr_, 0.0);
  designedFor_ = 0.0;
  lp1_ = LowPass{};
  lp2_ = LowPass{};
  lp1_.design(sr_ * 0.45, sr_, 0.5412);   // Butterworth pair, fourth order
  lp2_.design(sr_ * 0.45, sr_, 1.3066);

  const double step = 2.0 * M_PI / grain_;
  rotC_ = std::cos(step);
  rotS_ = std::sin(step);
  cos_ = 1.0;
  sin_ = 0.0;
  phase_ = 0;
  pos_[0] = pos_[1] = static_cast<double>(w_) - MIN_DELAY;
  running_ = false;
  ref_.assign(static_cast<size_t>(corr_ / stride_ + 1), 0.0f);
  refFine_.assign(static_cast<size_t>(corr_ + 1), 0.0f);
}

/* Catmull-Rom between the four samples around `position`. Cubic rather than
   linear because a linear interpolator is a lowpass whose cutoff moves with
   the fraction, which on a sweeping read head is audible as a flutter in the
   top end. */
double Pitch::read(double position) const {
  const int64_t i = static_cast<int64_t>(position);
  const double f = position - static_cast<double>(i);
  const float* b = buf_.data();
  const double y0 = b[(i - 1) & mask_];
  const double y1 = b[i & mask_];
  const double y2 = b[(i + 1) & mask_];
  const double y3 = b[(i + 2) & mask_];
  const double c0 = y1;
  const double c1 = 0.5 * (y2 - y0);
  const double c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
  const double c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
  return ((c3 * f + c2) * f + c1) * f + c0;
}

/* The splice point: the index, no further back than `span`, whose waveform
   best matches the one the other head is playing. Normalised by the
   candidate's own energy, or a loud passage anywhere in the window would win
   on volume rather than on shape. */
int64_t Pitch::align(int64_t reference, int64_t newest, int span) {
  if (span < stride_) return newest;

  const int points = corr_ / stride_;
  float* ref = ref_.data();
  double refEnergy = 0.0;
  for (int k = 0; k < points; k++) {
    const double v = buf_[(reference - static_cast<int64_t>(k) * stride_) & mask_];
    ref[k] = static_cast<float>(v);
    refEnergy += v * v;
  }
  if (refEnergy < QUIET) return newest;

  int64_t best = newest;
  double bestScore = -1e30;
  for (int j = 0; j <= span; j += stride_) {
    const int64_t c = newest - j;
    double num = 0.0;
    double den = 0.0;
    for (int k = 0; k < points; k++) {
      const double v = buf_[(c - static_cast<int64_t>(k) * stride_) & mask_];
      num += ref[k] * v;
      den += v * v;
    }
    /* Everything else equal, the nearest match wins: a periodic signal offers
       the same alignment every period, and the closest one is the one that
       delays the player least. The bias is far too small to beat a genuinely
       better match. */
    const double score = (num / std::sqrt(den + 1e-12)) * (1.0 - 0.2 * j / span);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  if (stride_ == 1) return best;

  /* The coarse grid can only place the splice within `stride_` samples, which
     at 48 kHz is a third of a millisecond — a whole cycle at 3 kHz. Refine at
     full resolution over the neighbours it skipped. */
  float* fine = refFine_.data();
  for (int k = 0; k < corr_; k++) {
    fine[k] = buf_[(reference - static_cast<int64_t>(k)) & mask_];
  }
  const int64_t oldest = newest - span;
  int64_t refined = best;
  double refinedScore = -1e30;
  for (int64_t c = best - (stride_ - 1); c <= best + (stride_ - 1); c++) {
    if (c > newest || c < oldest) continue;
    double num = 0.0;
    double den = 0.0;
    for (int k = 0; k < corr_; k++) {
      const double v = buf_[(c - static_cast<int64_t>(k)) & mask_];
      num += fine[k] * v;
      den += v * v;
    }
    const double score = num / std::sqrt(den + 1e-12);
    if (score > refinedScore) {
      refinedScore = score;
      refined = c;
    }
  }
  return refined;
}

void Pitch::splice(int tap, double ratio) {
  const int other = tap ^ 1;
  /* An upward shift eats delay as it plays, so the head has to start far
     enough back to still be behind the write pointer at the end of its life.
     A downward shift is the other way round and only needs room ahead. */
  const double shrink = ratio > 1.0 ? (ratio - 1.0) * grain_ : 0.0;
  const double grow = ratio < 1.0 ? (1.0 - ratio) * grain_ : 0.0;
  const double lo = MIN_DELAY + shrink;
  int span = search_;
  const int room = static_cast<int>(maxDelay_ - lo - grow);
  if (span > room) span = room < 0 ? 0 : room;

  const int64_t newest = w_ - static_cast<int64_t>(lo);
  const int64_t reference = static_cast<int64_t>(pos_[other]);
  const double frac = pos_[other] - static_cast<double>(reference);
  /* The fraction is carried over from the other head so the two differ by a
     whole number of samples: the correlation was computed on integers, and a
     sub-sample slip would undo the alignment it just found. */
  pos_[tap] = static_cast<double>(align(reference, newest, span)) + frac;
}

void Pitch::start(double ratio) {
  const double shrink = ratio > 1.0 ? (ratio - 1.0) * grain_ : 0.0;
  const double grow = ratio < 1.0 ? (1.0 - ratio) * grain_ : 0.0;
  const double lo = MIN_DELAY + shrink;
  // Head 0 starts its life; head 1 is half a life into its own.
  pos_[0] = static_cast<double>(w_) - lo;
  pos_[1] = static_cast<double>(w_) - (lo - shrink * 0.5 + grow * 0.5);
  phase_ = 0;
  cos_ = 1.0;
  sin_ = 0.0;
  running_ = true;
}

void Pitch::process(const double* in, double* out, int n) {
  const double semitones = shift_.block(n);
  const double ratio = std::pow(2.0, semitones / 12.0);
  /* Reading faster compresses the spectrum upwards, so anything above
     Nyquist / ratio would fold back. The guitar has little up there and the
     cabinet would bury it, but folded content is inharmonic and a saturated
     capture multiplies it. */
  const double cutoff = sr_ * 0.45 / (ratio > 1.0 ? ratio : 1.0);
  if (std::fabs(cutoff - designedFor_) > 1.0) {
    lp1_.design(cutoff, sr_, 0.5412);
    lp2_.design(cutoff, sr_, 1.3066);
    designedFor_ = cutoff;
  }

  const int half = grain_ / 2;
  for (int i = 0; i < n; i++) {
    const double x = in[i];
    buf_[static_cast<size_t>(w_) & mask_] = static_cast<float>(lp2_.tick(lp1_.tick(x)));
    w_++;

    const double wet = wet_.tick();
    if (wet <= 1e-5 && wet_.target <= 1e-9) {
      // Fully dry: the line keeps filling, nothing else runs, and the stage
      // costs a filter. Engaging it starts from live audio, not from a stale
      // buffer.
      running_ = false;
      out[i] = x;
      continue;
    }
    if (!running_) start(ratio);

    const double g0 = 0.5 * (1.0 - cos_);
    const double y = g0 * read(pos_[0]) + (1.0 - g0) * read(pos_[1]);

    for (int t = 0; t < 2; t++) {
      pos_[t] += ratio;
      const double delay = static_cast<double>(w_) - pos_[t];
      // A ratio that moved mid-life can walk a head out of the line. Clamping
      // is audible once, at the edge of a sweep; reading past the write
      // pointer would not be.
      if (delay < MIN_DELAY) pos_[t] = static_cast<double>(w_) - MIN_DELAY;
      else if (delay > maxDelay_) pos_[t] = static_cast<double>(w_) - maxDelay_;
    }

    if (++phase_ >= grain_) phase_ = 0;
    if (phase_ == 0) {
      splice(0, ratio);
      cos_ = 1.0;
      sin_ = 0.0;
    } else if (phase_ == half) {
      splice(1, ratio);
      cos_ = -1.0;
      sin_ = 0.0;
    } else {
      const double c = cos_ * rotC_ - sin_ * rotS_;
      sin_ = sin_ * rotC_ + cos_ * rotS_;
      cos_ = c;
    }

    out[i] = x * (1.0 - wet) + y * wet;
  }
}

double Pitch::delayFrames() const {
  if (!running_ || wet_.value <= 1e-5) return 0.0;
  const double g0 = 0.5 * (1.0 - cos_);
  const double d0 = static_cast<double>(w_) - pos_[0];
  const double d1 = static_cast<double>(w_) - pos_[1];
  return g0 * d0 + (1.0 - g0) * d1;
}

}  // namespace tc
