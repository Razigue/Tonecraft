/* =============================================================================
   dsp/convolver.h — the cabinet and the reverb, with no latency of their own
   -----------------------------------------------------------------------------
   Both were ConvolverNodes. They are here because the chain has to be one
   module that two hosts run identically, and a ConvolverNode exists in only
   one of them — which is also what AD-3 asked for from the start.

   Zero latency, whatever the host's block size, by splitting the impulse:

     - the head, taps [0, P), as a direct-form FIR computed sample by sample;
     - the tail, taps [P, end), as uniformly partitioned overlap-save
       convolution with partitions of P. Its output for a block of P inputs is
       ready P samples late — exactly the P samples by which the tail starts
       late, so nothing is delayed.

   P is 128. For the 1024-tap cabinet that is a 128-tap FIR plus seven
   partitions; for the 1.3 s reverb the head is all zero (14 ms of pre-delay)
   and is skipped, leaving 487 partitions, whose spectral multiply-adds are the
   cost of the reverb: about 2% of one core at 48 kHz, measured by
   `npm run bench`, and only while the reverb is audible.

   Explicit WebAssembly SIMD, with the summation order written out: the result
   must be the same on every engine that runs the module (AD-4).
   ========================================================================== */
#pragma once

#include <vector>

namespace tc {

class Convolver {
 public:
  static constexpr int P = 128;
  static constexpr int N = 2 * P;
  /* Spectrum bins of a real 2P-point transform, padded to a SIMD multiple. */
  static constexpr int BINS = P + 1;
  static constexpr int BINS_PAD = (BINS + 3) & ~3;

  Convolver();

  /* Not real-time safe: allocates. Resets all state. */
  void setIR(const float* h, int length);
  bool empty() const { return length_ == 0; }
  int length() const { return length_; }

  /* Any n. `in` and `out` must not alias. */
  void process(const float* in, float* out, int n);
  void reset();

 private:
  void tail();

  int length_ = 0;
  // head
  bool headZero_ = true;
  float head_[P] = {};           // reversed, so the dot product runs forwards
  float hist_[2 * P] = {};       // doubled delay line: the window is contiguous
  int idx_ = 0;
  // tail
  int parts_ = 0;
  std::vector<float> hRe_, hIm_; // partition spectra, parts_ * BINS_PAD
  std::vector<float> xRe_, xIm_; // frequency-domain delay line, same shape
  int slot_ = 0;
  float block_[N] = {};          // overlap-save input: previous P, current P
  float tailOut_[P] = {};        // the tail's contribution to the block in progress
  int fill_ = 0;
  // transform scratch
  float re_[N] = {}, im_[N] = {};
  float accRe_[BINS_PAD] = {}, accIm_[BINS_PAD] = {};
};

}  // namespace tc
