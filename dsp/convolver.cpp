/* dsp/convolver.cpp — see convolver.h. */

#include "convolver.h"

#include <wasm_simd128.h>

#include <algorithm>
#include <cmath>
#include <cstring>

namespace tc {

namespace {

/* A 2P-point complex radix-2 transform. The inverse is unscaled; the caller
   divides by N once, on the samples it keeps. */
struct Fft {
  static constexpr int N = Convolver::N;
  float cosT[N / 2];
  float sinT[N / 2];
  int rev[N];

  Fft() {
    for (int j = 0; j < N / 2; j++) {
      cosT[j] = static_cast<float>(std::cos(2.0 * M_PI * j / N));
      sinT[j] = static_cast<float>(std::sin(2.0 * M_PI * j / N));
    }
    int bits = 0;
    while ((1 << bits) < N) bits++;
    for (int i = 0; i < N; i++) {
      int r = 0;
      for (int b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      rev[i] = r;
    }
  }

  void run(float* re, float* im, bool inverse) const {
    for (int i = 0; i < N; i++) {
      const int j = rev[i];
      if (i < j) {
        float t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (int len = 2; len <= N; len <<= 1) {
      const int half = len >> 1;
      const int step = N / len;
      for (int i = 0; i < N; i += len) {
        for (int k = 0; k < half; k++) {
          const float wr = cosT[k * step];
          const float wi = inverse ? sinT[k * step] : -sinT[k * step];
          const int a = i + k, b = a + half;
          const float vr = re[b] * wr - im[b] * wi;
          const float vi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - vr; im[b] = im[a] - vi;
          re[a] += vr;        im[a] += vi;
        }
      }
    }
  }
};

const Fft& fft() {
  static const Fft instance;
  return instance;
}

/* Four partial sums in a fixed order, then the lanes in a fixed order: the same
   float result on every engine (AD-4). */
float dot(const float* a, const float* b, int n) {
  v128_t s = wasm_f32x4_splat(0.0f);
  for (int i = 0; i < n; i += 4) {
    s = wasm_f32x4_add(s, wasm_f32x4_mul(wasm_v128_load(a + i), wasm_v128_load(b + i)));
  }
  return ((wasm_f32x4_extract_lane(s, 0) + wasm_f32x4_extract_lane(s, 1)) +
          wasm_f32x4_extract_lane(s, 2)) + wasm_f32x4_extract_lane(s, 3);
}

}  // namespace

Convolver::Convolver() { (void)fft(); }

void Convolver::setIR(const float* h, int length) {
  length_ = length > 0 ? length : 0;

  headZero_ = true;
  for (int j = 0; j < P; j++) {
    const int tap = P - 1 - j;
    head_[j] = tap < length_ ? h[tap] : 0.0f;
    if (head_[j] != 0.0f) headZero_ = false;
  }

  parts_ = length_ > P ? (length_ - P + P - 1) / P : 0;
  hRe_.assign(static_cast<size_t>(parts_) * BINS_PAD, 0.0f);
  hIm_.assign(static_cast<size_t>(parts_) * BINS_PAD, 0.0f);
  xRe_.assign(static_cast<size_t>(parts_) * BINS_PAD, 0.0f);
  xIm_.assign(static_cast<size_t>(parts_) * BINS_PAD, 0.0f);

  for (int p = 0; p < parts_; p++) {
    for (int i = 0; i < N; i++) {
      const int tap = P + p * P + i;
      re_[i] = (i < P && tap < length_) ? h[tap] : 0.0f;
      im_[i] = 0.0f;
    }
    fft().run(re_, im_, false);
    for (int k = 0; k < BINS; k++) {
      hRe_[static_cast<size_t>(p) * BINS_PAD + k] = re_[k];
      hIm_[static_cast<size_t>(p) * BINS_PAD + k] = im_[k];
    }
  }
  reset();
}

void Convolver::reset() {
  std::memset(hist_, 0, sizeof hist_);
  std::memset(block_, 0, sizeof block_);
  std::memset(tailOut_, 0, sizeof tailOut_);
  std::fill(xRe_.begin(), xRe_.end(), 0.0f);
  std::fill(xIm_.begin(), xIm_.end(), 0.0f);
  idx_ = 0;
  slot_ = 0;
  fill_ = 0;
}

void Convolver::process(const float* in, float* out, int n) {
  while (n > 0) {
    const int m = n < P - fill_ ? n : P - fill_;
    if (headZero_) {
      for (int i = 0; i < m; i++) out[i] = tailOut_[fill_ + i];
    } else {
      for (int i = 0; i < m; i++) {
        idx_ = (idx_ + 1) & (P - 1);
        hist_[idx_] = hist_[idx_ + P] = in[i];
        out[i] = dot(head_, hist_ + idx_ + 1, P) + tailOut_[fill_ + i];
      }
    }
    std::memcpy(block_ + P + fill_, in, sizeof(float) * static_cast<size_t>(m));
    fill_ += m;
    in += m;
    out += m;
    n -= m;
    if (fill_ == P) {
      if (parts_ > 0) tail();
      fill_ = 0;
    }
  }
}

/* One overlap-save step: the spectrum of the last 2P inputs joins the delay
   line, every partition multiplies its matching past spectrum, and the last P
   samples of the inverse are the tail's output for the next block. */
void Convolver::tail() {
  std::memcpy(re_, block_, sizeof re_);
  std::memset(im_, 0, sizeof im_);
  fft().run(re_, im_, false);

  float* xr = xRe_.data() + static_cast<size_t>(slot_) * BINS_PAD;
  float* xi = xIm_.data() + static_cast<size_t>(slot_) * BINS_PAD;
  for (int k = 0; k < BINS; k++) { xr[k] = re_[k]; xi[k] = im_[k]; }

  std::memset(accRe_, 0, sizeof accRe_);
  std::memset(accIm_, 0, sizeof accIm_);
  for (int p = 0; p < parts_; p++) {
    const int s = (slot_ - p + parts_) % parts_;
    const float* ar = xRe_.data() + static_cast<size_t>(s) * BINS_PAD;
    const float* ai = xIm_.data() + static_cast<size_t>(s) * BINS_PAD;
    const float* br = hRe_.data() + static_cast<size_t>(p) * BINS_PAD;
    const float* bi = hIm_.data() + static_cast<size_t>(p) * BINS_PAD;
    for (int k = 0; k < BINS_PAD; k += 4) {
      const v128_t xrv = wasm_v128_load(ar + k), xiv = wasm_v128_load(ai + k);
      const v128_t hrv = wasm_v128_load(br + k), hiv = wasm_v128_load(bi + k);
      const v128_t re = wasm_f32x4_sub(wasm_f32x4_mul(xrv, hrv), wasm_f32x4_mul(xiv, hiv));
      const v128_t im = wasm_f32x4_add(wasm_f32x4_mul(xrv, hiv), wasm_f32x4_mul(xiv, hrv));
      wasm_v128_store(accRe_ + k, wasm_f32x4_add(wasm_v128_load(accRe_ + k), re));
      wasm_v128_store(accIm_ + k, wasm_f32x4_add(wasm_v128_load(accIm_ + k), im));
    }
  }

  // The real signal's spectrum is Hermitian: the upper half mirrors the lower.
  for (int k = 0; k <= P; k++) { re_[k] = accRe_[k]; im_[k] = accIm_[k]; }
  for (int k = P + 1; k < N; k++) { re_[k] = accRe_[N - k]; im_[k] = -accIm_[N - k]; }
  fft().run(re_, im_, true);
  const float scale = 1.0f / N;
  for (int j = 0; j < P; j++) tailOut_[j] = re_[P + j] * scale;

  std::memcpy(block_, block_ + P, sizeof(float) * P);
  slot_ = (slot_ + 1) % parts_;
}

}  // namespace tc
