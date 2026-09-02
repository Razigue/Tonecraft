// The speaker cabinet.
//
// A direct-form FIR, compiled into this module. Not a `ConvolverNode` (AD-3),
// for two reasons that both matter more than the convenience:
//
//  - The W3C convolution architecture is non-normative, and the specification
//    itself calls a well-optimised real-time convolution engine one of the
//    hardest parts of the API. Browsers implement it differently, so the same
//    tone would render differently in each — and a tone link that sounds
//    different for the person who receives it is a tone link that lies (NFR-9).
//  - Build-time renders run in Node, where there is no `ConvolverNode` at all.
//    A convolution has to be written regardless; writing it once and using it
//    everywhere is strictly simpler than writing it once and then depending on
//    three other implementations.
//
// Direct form rather than a partitioned FFT because a guitar cabinet's impulse
// response is short. At 1024 taps — 21 ms at 48 kHz, well past where a cabinet
// has anything left to say — direct convolution is about 49 MMAC/s, which
// measures at roughly a percent of one core. An FFT would need a library,
// block latency, and a licence to audit, to save something we are not short of.
//
// This is also the stage that decides whether a high-gain tone sounds like an
// amplifier or like a wasp: everything above about 5 kHz that the preamp
// generated has to go, and the cabinet is what removes it.

#pragma once

#include <cstdint>
#include <cstring>

#include "params.generated.h"

namespace tonecraft {

/// 'T','C','I','R' little-endian.
inline constexpr uint32_t kIrMagic = 0x52494354u;
inline constexpr uint32_t kIrVersion = 1u;

enum class IrStatus : int32_t {
  Ok = 0,
  TooShort = 1,
  BadMagic = 2,
  UnsupportedVersion = 3,
  /// Longer than the direct-form FIR is sized for. Refused by name rather than
  /// truncated — a silently shortened cabinet is a different cabinet — and
  /// rather than switching algorithm behind the player's back (AD-3).
  TooManyTaps = 4,
};

class Cab {
 public:
  void reset() {
    for (uint32_t i = 0; i < 2 * kMaxIrTaps; ++i) history_[i] = 0.0f;
    pos_ = 0;
  }

  bool loaded() const { return taps_ > 0; }
  uint32_t taps() const { return taps_; }

  /// Init-time only. Every way this can fail is resolved here and reported as
  /// a status; process() has no error path (AD-13).
  IrStatus load(const uint8_t* bytes, uint32_t byteCount) {
    constexpr uint32_t kHeader = 3 * sizeof(uint32_t);
    if (byteCount < kHeader) return IrStatus::TooShort;

    uint32_t magic = 0, version = 0, taps = 0;
    std::memcpy(&magic, bytes + 0, sizeof magic);
    std::memcpy(&version, bytes + 4, sizeof version);
    std::memcpy(&taps, bytes + 8, sizeof taps);

    if (magic != kIrMagic) return IrStatus::BadMagic;
    if (version != kIrVersion) return IrStatus::UnsupportedVersion;
    if (taps == 0) return IrStatus::TooShort;
    if (taps > kMaxIrTaps) return IrStatus::TooManyTaps;
    if (byteCount < kHeader + taps * sizeof(float)) return IrStatus::TooShort;

    std::memcpy(ir_, bytes + kHeader, taps * sizeof(float));
    // The tail is zeroed so the convolution can always run the full length
    // without a branch per tap.
    for (uint32_t i = taps; i < kMaxIrTaps; ++i) ir_[i] = 0.0f;
    taps_ = taps;
    reset();
    return IrStatus::Ok;
  }

  /// `mix` is a ratio, already smoothed at the worklet boundary (AD-20).
  void setMix(float mix) { mix_ = mix; }

  void process(const float* in, float* out, uint32_t frames) {
    if (taps_ == 0) {
      for (uint32_t i = 0; i < frames; ++i) out[i] = in[i];
      return;
    }

    for (uint32_t n = 0; n < frames; ++n) {
      // A ring buffer written twice, into a history of double length. Every
      // sample lands at `pos_` and again at `pos_ + kMaxIrTaps`, so the last N
      // samples are *always* contiguous from `pos_` — the convolution reads
      // straight down two arrays with no wraparound test, and -msimd128 can
      // vectorise it.
      //
      // The obvious alternative, shifting the history down by one each sample,
      // was measured first: it costs a 4 kB memmove per sample, which is 49
      // million float moves a second and more expensive than the convolution
      // it exists to serve. It measured 11.4% of one core against this
      // version's cost below.
      pos_ = (pos_ == 0) ? kMaxIrTaps - 1 : pos_ - 1;
      history_[pos_] = in[n];
      history_[pos_ + kMaxIrTaps] = in[n];

      const float* window = history_ + pos_;

      // Four accumulators, not one. Floating-point addition is not
      // associative, so a compiler may not reassociate a reduction on its own
      // and the whole convolution stays scalar — measured at 11.4% of one core
      // with a single accumulator. Splitting it by hand gives the vectoriser
      // four independent chains to fill a v128 with.
      //
      // This *is* a reassociation, and it does change the result in the last
      // bits. That is allowed where relaxed SIMD is not (AD-4), and the
      // difference is the reason: this order is fixed, written here, and
      // identical on every machine. Relaxed SIMD lets the *engine* choose, and
      // an engine-specific choice is what would make a shared tone link lie.
      float s0 = 0.0f, s1 = 0.0f, s2 = 0.0f, s3 = 0.0f;
      uint32_t i = 0;
      for (; i + 4 <= taps_; i += 4) {
        s0 += window[i + 0] * ir_[i + 0];
        s1 += window[i + 1] * ir_[i + 1];
        s2 += window[i + 2] * ir_[i + 2];
        s3 += window[i + 3] * ir_[i + 3];
      }
      float sum = (s0 + s1) + (s2 + s3);
      for (; i < taps_; ++i) sum += window[i] * ir_[i];

      out[n] = in[n] + mix_ * (sum - in[n]);
    }
  }

 private:
  alignas(16) float ir_[kMaxIrTaps]{};
  // Double length so the newest N samples are always contiguous.
  alignas(16) float history_[2 * kMaxIrTaps]{};
  uint32_t taps_ = 0;
  uint32_t pos_ = 0;
  float mix_ = 1.0f;
};

}  // namespace tonecraft
