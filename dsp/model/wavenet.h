// The amplifier: NAM's Standard WaveNet, run as inference.
//
// **The architecture is NAM's Standard WaveNet**, the shape of every `.nam`
// written since format 0.5. Two arrays of dilated convolutions, each layer
// mixing in the conditioning signal, activating, contributing to a skip
// accumulator and adding a 1x1 back onto its own input. What arrives here is a
// `.tcnm` blob — the same numbers with the JSON removed by
// `scripts/nam-to-tcnm.ts`, because a JSON parser needs an allocator,
// exceptions and a string parser, and this module is built with none of them.
//
// **It runs at the base rate, outside any oversampling, and that is a
// deliberate exception to the 4x rule.** Oversampling exists to keep a
// non-linearity we designed from folding harmonics back below Nyquist. A
// trained network is not a curve we chose: its weights encode the sample rate
// it was trained at, and running it at four times that rate does not give it
// headroom, it gives it a different amplifier. NAM oversamples nothing for the
// same reason.
//
// **Why this kernel and not NeuralAmpModelerCore itself.** The product shipped
// a vendored build of NAM core (`@opendaw/nam-wasm`) until 2026-09-07. It is
// correct and it is too slow. On an i5-7300U — a 2017 dual-core laptop, the
// floor machine's class — at 128-frame blocks, as a share of one core:
//
//                                cold machine   after ~20 min of load
//     this kernel                   31 - 43 %          56 - 67 %
//     the vendored build            58 - 75 %         103 - 111 %
//
// The second column is the one that matters: a U-series laptop holds its turbo
// for seconds and then settles about 40 % lower, and nobody plays for seconds.
// Warm, the engine this replaced does not fit in one core at all. That is not a
// latency problem, it is a dropout problem, and it is why a machine that was
// not fast enough could not play even a pre-recorded DI.
//
// The ratio, 1.5 to 1.9x, is the stable number: the two are measured against
// each other in the same interleaved run. This kernel agrees with NAM core to
// 103-115 dB SNR (`npm run model:verify`, which is the check that matters: a
// transposed weight matrix scores -5 dB there, and a model read with the wrong
// shape does not fall silent, it plays a different amplifier).
//
// The difference is one decision, and it is `accumulateScaled` below: Eigen
// blocks its GEMM for cache, which is the right call at matrix sizes where
// cache is the problem, and at eight or sixteen channels there is no cache
// problem to solve — only the horizontal reduction at the end of every dot
// product, once per output channel per tap per frame. Accumulating
// column-scaled rows never reduces a vector register at all.
//
// **Standard still does not fit the budget.** Any of those figures against
// `PRODUCT.md` §5's 25 % cap is an architecture cost, not an implementation one,
// and no compiler flag closes it: a build of NAM core with `-O3 -msimd128
// -flto` was measured *slower* than the vendored `-Os` one. Closing it means a smaller
// capture — Feather is 3 638 weights against Standard's 13 802 — which is a
// choice about which sounds ship, not about this file. Which size ships is
// decided once, at build time, for the floor machine, and never at runtime from
// measured headroom (AD-5): an adaptive engine would make a shared tone link
// sound different for the person who receives it.

#pragma once

#include <cmath>
#include <cstdint>
#include <cstring>

#include "params.generated.h"

namespace tonecraft {

/// Every way loading can fail, resolved at init and reported by name. The audio
/// path has no error path (AD-13), and a model whose shape was misread does not
/// fall silent — it plays, and it plays wrong.
enum class ModelStatus : int32_t {
  Ok = 0,
  TooShort = 1,
  BadMagic = 2,
  UnsupportedVersion = 3,
  /// More layer arrays, layers, channels, kernel taps or dilation than the
  /// static buffers are sized for. Refused rather than truncated.
  TooLarge = 4,
  /// The arrays do not fit together: one array's head width has to equal the
  /// next one's channel count, and its channel count the next one's input.
  ShapeMismatch = 5,
  /// The weight count does not match the declared shape. This is the checksum
  /// over every dimension at once.
  WeightCountMismatch = 6,
  /// The history pool cannot hold this model's lookback. Only reachable by a
  /// shape the bounds admit but the pool was not sized for.
  HistoryPoolTooSmall = 7,
  /// The model was trained at a rate other than the chain's design rate.
  ///
  /// Refused rather than adapted, and this is AD-18 rather than a convenience.
  /// A network's weights encode the rate it was trained at the way a filter's
  /// coefficients encode its corner: running it faster does not stretch it, it
  /// makes a different amplifier — and it would do so silently, so two players
  /// would hear different things from the same tone link. Resampling belongs at
  /// the boundary, or to the build step that writes the blob.
  WrongDesignRate = 8,
};

namespace model_detail {

// The history every dilated layer reads backwards through, and the reshaped
// weights. Both are file scope and zero-initialised, so they cost nothing in
// the module's binary — `.bss` declares a size, it does not carry bytes — and
// process() never allocates (AD-13).
alignas(16) inline float g_history[kModelHistoryPoolFloats];
alignas(16) inline float g_weights[kModelMaxWeights];

// Per-block work, frame-major: channel `c` of frame `f` is at `f * channels +
// c`. That is the layout the convolution wants, because a tap reads one whole
// frame across all channels and the dot product over channels is then a walk
// down two contiguous arrays.
constexpr uint32_t kWork = kModelMaxChannels * kBlockFrames;
alignas(16) inline float g_x[kWork];
alignas(16) inline float g_x_next[kWork];
alignas(16) inline float g_z[kWork];
alignas(16) inline float g_head_acc[kWork];
alignas(16) inline float g_head_out[kWork];
alignas(16) inline float g_array_out[kWork];
alignas(16) inline float g_condition[kBlockFrames];

/// NAM's rational approximation of tanh, and the one the reference plugin
/// actually ships with — it calls `enable_fast_tanh()` at startup, so this is
/// not a shortcut away from the reference, it *is* the reference. It also keeps
/// the promise the Faust amp could not: a Standard model evaluates 320
/// activations per sample, and 15 million library `tanhf` calls a second would
/// cost more than the convolutions they follow.
///
/// Fixed rational arithmetic, so it is identical on every engine. That matters
/// as much as the speed: `-mrelaxed-simd` is forbidden for the same reason
/// (AD-4), because a tone link that renders differently elsewhere is a lie.
inline float fastTanh(float x) {
  const float ax = std::fabs(x);
  const float x2 = x * x;
  return (x * (2.45550750702956f + 2.45550750702956f * ax +
               (0.893229853513558f + 0.821226666969744f * ax) * x2) /
          (2.44506634652299f +
           (2.44506634652299f + x2) * std::fabs(x + 0.814642734961073f * x * ax)));
}

/// `dst += scale * row`, over contiguous runs.
///
/// This is the whole inner loop, and the shape of it is the reason the weights
/// are stored transposed. The obvious way to multiply a matrix by a vector is
/// one dot product per output channel — but a dot product ends in a horizontal
/// reduction, and there is one per output channel per tap per frame. Measured
/// in wasm, that cost 13.7 % of a core for a Feather model where accumulating
/// column-scaled rows costs 9.0 %: the same arithmetic, without ever having to
/// collapse a vector register down to one lane.
///
/// The accumulation order is fixed here and identical on every machine, which
/// is what AD-4 requires and what `-mrelaxed-simd` would give away.
inline void accumulateScaled(float* dst, const float* row, float scale, uint32_t n) {
  for (uint32_t i = 0; i < n; ++i) dst[i] += row[i] * scale;
}

/// One dilated layer's state and where its weights live.
struct Layer {
  uint32_t dilation;
  /// Frames of past this layer has to keep: `(kernel - 1) * dilation`.
  uint32_t lookback;
  /// Frames its slice of the history pool holds, lookback included.
  uint32_t capacity;
  /// Where that slice starts, in floats.
  uint32_t history;
  /// Frame the next block is written at. Never below `lookback`.
  uint32_t writeFrame;
  /// Offsets into `g_weights`. Every matrix is stored `[in][out]` — transposed
  /// from the `[out][in]` NAM writes — so the innermost loop walks output
  /// channels contiguously and never reduces. See `accumulateScaled`.
  uint32_t conv;
  uint32_t convBias;
  uint32_t mixin;
  uint32_t oneByOne;
  uint32_t oneByOneBias;
};

struct LayerArray {
  uint32_t inputSize;
  uint32_t channels;
  uint32_t headSize;
  uint32_t kernelSize;
  uint32_t layerCount;
  bool headBias;
  /// Rechannel: a 1x1 from `inputSize` to `channels`, no bias. `[in][out]`.
  uint32_t rechannel;
  /// Head rechannel: a 1x1 from `channels` to `headSize`. NAM builds it as a
  /// Conv1D, but every Standard model gives it kernel 1, where a convolution
  /// and a 1x1 are the same arithmetic and only the 1x1 needs no history.
  uint32_t head;
  uint32_t headBiasAt;
  Layer layers[kModelMaxLayersPerArray];
};

}  // namespace model_detail

class WaveNetAmp {
 public:
  /// No constructor, for the reason the limiter documents: a standalone wasm
  /// module runs static initialisers only if the loader calls `_initialize`,
  /// and nothing in this build may depend on that.
  void init() {
    loaded_ = false;
    arrayCount_ = 0;
    headScale_ = 0.0f;
    loudnessDb_ = 0.0f;
    hasLoudness_ = false;
    reset();
  }

  bool loaded() const { return loaded_; }

  /// Model loudness in dBFS as the trainer measured it. Only meaningful when
  /// `hasLoudness()`: it is what lets one preset be levelled against another
  /// without a fader, and models trained before it was recorded carry none.
  bool hasLoudness() const { return hasLoudness_; }
  float loudnessDb() const { return loudnessDb_; }

  /// Samples of past the model needs before its output means anything. Fed to
  /// it as silence by `reset()`, which is why the first note a player strikes
  /// sounds the same as the hundredth.
  uint32_t receptiveField() const { return receptiveField_; }

  /// Clears every history and re-settles the initial conditions.
  ///
  /// Zeroing is not enough on its own. The biases are not zero, so a network
  /// fed silence still takes its receptive field — 85 ms for a Standard model —
  /// to reach the output it will hold at rest. Skipping this puts that
  /// transient at the front of the first block after every reset, which is
  /// audible as a thump when the engine starts or a preset is loaded.
  void reset() {
    for (uint32_t a = 0; a < arrayCount_; ++a) {
      auto& array = arrays_[a];
      for (uint32_t l = 0; l < array.layerCount; ++l) {
        auto& layer = array.layers[l];
        for (uint32_t i = 0; i < layer.capacity * array.channels; ++i) {
          model_detail::g_history[layer.history + i] = 0.0f;
        }
        layer.writeFrame = layer.lookback;
      }
    }
    if (!loaded_) return;

    // Silence in, output discarded. Whole blocks, so this takes the same path
    // the audio does — a prewarm that ran a different code path would settle
    // different initial conditions.
    float silence[kBlockFrames] = {};
    float discard[kBlockFrames];
    for (uint32_t done = 0; done < receptiveField_; done += kBlockFrames) {
      process(silence, discard, kBlockFrames);
    }
  }

  /// Init-time only. Every failure is resolved here and named (AD-13).
  ModelStatus load(const uint8_t* bytes, uint32_t byteCount) {
    loaded_ = false;
    arrayCount_ = 0;

    constexpr uint32_t kFixedHeader = 7 * sizeof(uint32_t);
    if (byteCount < kFixedHeader) return ModelStatus::TooShort;

    uint32_t at = 0;
    const auto u32 = [&](void) -> uint32_t {
      uint32_t v = 0;
      std::memcpy(&v, bytes + at, sizeof v);
      at += sizeof v;
      return v;
    };
    const auto f32 = [&](void) -> float {
      float v = 0.0f;
      std::memcpy(&v, bytes + at, sizeof v);
      at += sizeof v;
      return v;
    };

    if (u32() != kModelBlobMagic) return ModelStatus::BadMagic;
    if (u32() != kModelBlobVersion) return ModelStatus::UnsupportedVersion;
    // The rate the model was trained at. Compared, never adopted.
    if (u32() != kInternalSampleRate) return ModelStatus::WrongDesignRate;
    headScale_ = f32();
    const float loudness = f32();
    // NaN rather than a sentinel, because every real dBFS is a plausible one.
    hasLoudness_ = !(loudness != loudness);
    loudnessDb_ = hasLoudness_ ? loudness : 0.0f;

    const uint32_t arrayCount = u32();
    const uint32_t weightCount = u32();
    if (arrayCount == 0 || arrayCount > kModelMaxLayerArrays) return ModelStatus::TooLarge;
    if (weightCount > kModelMaxWeights) return ModelStatus::TooLarge;

    // --- Shapes ----------------------------------------------------------
    uint32_t declared[kModelMaxLayerArrays][7];
    uint32_t dilations[kModelMaxLayerArrays][kModelMaxLayersPerArray];
    for (uint32_t a = 0; a < arrayCount; ++a) {
      if (byteCount < at + 7 * sizeof(uint32_t)) return ModelStatus::TooShort;
      for (uint32_t i = 0; i < 7; ++i) declared[a][i] = u32();

      const uint32_t conditionSize = declared[a][1];
      const uint32_t channels = declared[a][2];
      const uint32_t kernelSize = declared[a][4];
      const uint32_t layerCount = declared[a][6];
      // The conditioning signal is the mono input itself: without a condition
      // DSP there is nothing else it could be, and a wider one would mean a
      // model whose shape we are reading wrong.
      if (conditionSize != 1) return ModelStatus::ShapeMismatch;
      if (channels == 0 || channels > kModelMaxChannels) return ModelStatus::TooLarge;
      if (kernelSize == 0 || kernelSize > kModelMaxKernelSize) return ModelStatus::TooLarge;
      if (layerCount == 0 || layerCount > kModelMaxLayersPerArray) return ModelStatus::TooLarge;

      if (byteCount < at + layerCount * sizeof(uint32_t)) return ModelStatus::TooShort;
      for (uint32_t l = 0; l < layerCount; ++l) {
        const uint32_t d = u32();
        if (d == 0 || d > kModelMaxDilation) return ModelStatus::TooLarge;
        dilations[a][l] = d;
      }
    }

    // The arrays have to fit together. NAM never states these: they are implied
    // by one array's head output becoming the next one's head accumulator, and
    // its channels feeding the next one's rechannel. A model that violates one
    // loads without complaint and produces noise.
    for (uint32_t a = 0; a < arrayCount; ++a) {
      const uint32_t inputSize = declared[a][0];
      if (a == 0) {
        if (inputSize != 1) return ModelStatus::ShapeMismatch;
      } else {
        if (inputSize != declared[a - 1][2]) return ModelStatus::ShapeMismatch;
        if (declared[a][2] != declared[a - 1][3]) return ModelStatus::ShapeMismatch;
      }
    }
    if (declared[arrayCount - 1][3] != 1) return ModelStatus::ShapeMismatch;

    if (byteCount < at + weightCount * sizeof(float)) return ModelStatus::TooShort;
    const uint32_t weightsAt = at;

    // --- Weights, reshaped -----------------------------------------------
    // Read in NAM's order and written in ours. NAM stores a convolution
    // `[out][in][tap]`, which puts the taps — the short axis — innermost; the
    // inner loop here walks input channels, so it is stored `[tap][out][in]`.
    // The transpose is a load-time cost paid once for a layout the block loop
    // reads straight down.
    uint32_t source = 0;   // in floats, from the start of the weight block
    uint32_t dest = 0;     // in floats, into g_weights
    uint32_t pool = 0;     // in floats, into g_history
    uint32_t receptive = 0;

    const auto weightAt = [&](uint32_t index) -> float {
      float v = 0.0f;
      std::memcpy(&v, bytes + weightsAt + index * sizeof(float), sizeof v);
      return v;
    };
    const auto take = [&](uint32_t count) -> uint32_t {
      const uint32_t start = dest;
      for (uint32_t i = 0; i < count; ++i) model_detail::g_weights[dest + i] = weightAt(source + i);
      source += count;
      dest += count;
      return start;
    };
    // NAM writes a 1x1 as `[out][in]`; the block loop wants `[in][out]`.
    const auto takeTransposed = [&](uint32_t outCount, uint32_t inCount) -> uint32_t {
      const uint32_t start = dest;
      for (uint32_t o = 0; o < outCount; ++o) {
        for (uint32_t i = 0; i < inCount; ++i) {
          model_detail::g_weights[start + i * outCount + o] = weightAt(source++);
        }
      }
      dest += outCount * inCount;
      return start;
    };

    for (uint32_t a = 0; a < arrayCount; ++a) {
      auto& array = arrays_[a];
      array.inputSize = declared[a][0];
      array.channels = declared[a][2];
      array.headSize = declared[a][3];
      array.kernelSize = declared[a][4];
      array.headBias = declared[a][5] != 0;
      array.layerCount = declared[a][6];

      const uint32_t channels = array.channels;
      const uint32_t kernel = array.kernelSize;

      array.rechannel = takeTransposed(channels, array.inputSize);

      for (uint32_t l = 0; l < array.layerCount; ++l) {
        auto& layer = array.layers[l];
        layer.dilation = dilations[a][l];
        layer.lookback = (kernel - 1) * layer.dilation;
        // Slack, so the history is written forward and only rewound when it
        // runs out. Rewinding every block would copy the whole lookback 375
        // times a second in every layer; four blocks of slack divides that by
        // four and makes it disappear.
        layer.capacity = layer.lookback + kModelHistorySlackBlocks * kBlockFrames;
        layer.history = pool;
        pool += layer.capacity * channels;
        if (pool > kModelHistoryPoolFloats) return ModelStatus::HistoryPoolTooSmall;
        receptive += layer.lookback;

        // The dilated convolution, from NAM's `[out][in][tap]` to `[tap][in][out]`.
        // Two axes move at once, which is why this is spelled out rather than
        // reusing takeTransposed.
        layer.conv = dest;
        dest += kernel * channels * channels;
        for (uint32_t o = 0; o < channels; ++o) {
          for (uint32_t i = 0; i < channels; ++i) {
            for (uint32_t k = 0; k < kernel; ++k) {
              model_detail::g_weights[layer.conv + (k * channels + i) * channels + o] =
                  weightAt(source++);
            }
          }
        }
        layer.convBias = take(channels);
        // The input mixin is a 1x1 over one conditioning channel, so it is one
        // weight per output channel and the transpose is a no-op.
        layer.mixin = take(channels * 1);
        layer.oneByOne = takeTransposed(channels, channels);
        layer.oneByOneBias = take(channels);
      }

      // The head rechannel, kernel 1, transposed like every other matrix.
      array.head = takeTransposed(array.headSize, channels);
      array.headBiasAt = array.headBias ? take(array.headSize) : 0;
    }

    // The checksum over every dimension at once. NAM's own loader ends with
    // head_scale; ours takes it from the blob header, so what is left here is
    // exactly the weights.
    if (source != weightCount) return ModelStatus::WeightCountMismatch;

    arrayCount_ = arrayCount;
    // Plus one, matching NAM: the extra sample is what a model with no
    // condition DSP needs before its first output is settled.
    receptiveField_ = receptive + 1;
    loaded_ = true;
    reset();
    return ModelStatus::Ok;
  }

  void process(const float* in, float* out, uint32_t frames) {
    if (!loaded_ || frames > kBlockFrames) {
      for (uint32_t f = 0; f < frames; ++f) out[f] = in[f];
      return;
    }

    using namespace model_detail;

    // The conditioning signal. With no condition DSP it is the input itself,
    // which is what makes this network an amplifier rather than a synthesiser:
    // every layer is told, again, what was actually played.
    for (uint32_t f = 0; f < frames; ++f) g_condition[f] = in[f];

    const float* arrayInput = in;
    uint32_t arrayInputChannels = 1;

    for (uint32_t a = 0; a < arrayCount_; ++a) {
      auto& array = arrays_[a];
      const uint32_t channels = array.channels;
      const uint32_t kernel = array.kernelSize;

      // Rechannel the array's input up to its working width.
      {
        const float* w = g_weights + array.rechannel;
        for (uint32_t f = 0; f < frames; ++f) {
          const float* x = arrayInput + f * arrayInputChannels;
          float* y = g_x + f * channels;
          for (uint32_t o = 0; o < channels; ++o) y[o] = 0.0f;
          for (uint32_t i = 0; i < arrayInputChannels; ++i) {
            accumulateScaled(y, w + i * channels, x[i], channels);
          }
        }
      }

      // The skip accumulator. The first array starts from nothing; every one
      // after it starts from the previous array's head output, which is why
      // their widths have to match and why the loader checks that they do.
      if (a == 0) {
        for (uint32_t i = 0; i < channels * frames; ++i) g_head_acc[i] = 0.0f;
      } else {
        std::memcpy(g_head_acc, g_head_out, channels * frames * sizeof(float));
      }

      for (uint32_t l = 0; l < array.layerCount; ++l) {
        auto& layer = array.layers[l];
        float* history = g_history + layer.history;

        // Keep the past contiguous. Only when the slack runs out: the tail the
        // dilations still reach back into moves to the front, and writing
        // resumes behind it.
        if (layer.writeFrame + frames > layer.capacity) {
          std::memmove(history,
                       history + (layer.writeFrame - layer.lookback) * channels,
                       layer.lookback * channels * sizeof(float));
          layer.writeFrame = layer.lookback;
        }
        std::memcpy(history + layer.writeFrame * channels, g_x,
                    channels * frames * sizeof(float));

        const float* convWeights = g_weights + layer.conv;
        const float* convBias = g_weights + layer.convBias;
        const float* mixin = g_weights + layer.mixin;
        const float* oneByOne = g_weights + layer.oneByOne;
        const float* oneByOneBias = g_weights + layer.oneByOneBias;

        for (uint32_t f = 0; f < frames; ++f) {
          const uint32_t now = layer.writeFrame + f;
          float* z = g_z + f * channels;

          // The bias and the conditioning mixin, folded into the same pass that
          // clears the accumulator. With one conditioning channel the mixin is
          // one weight per output, so it costs a multiply and no memory.
          const float c = g_condition[f];
          for (uint32_t o = 0; o < channels; ++o) z[o] = convBias[o] + mixin[o] * c;

          // Dilated convolution. Tap `kernel - 1` is the current frame, so the
          // layer is causal: tap `k` reads `(kernel - 1 - k) * dilation` frames
          // back. Getting this backwards is inaudible as a bug and wrong as a
          // sound — the network would be reading a future it was never trained
          // to have.
          for (uint32_t k = 0; k < kernel; ++k) {
            const float* tap = history + (now - (kernel - 1 - k) * layer.dilation) * channels;
            const float* w = convWeights + k * channels * channels;
            for (uint32_t i = 0; i < channels; ++i) {
              accumulateScaled(z, w + i * channels, tap[i], channels);
            }
          }

          // The one non-linearity in the chain, and the skip connection that
          // carries what this layer heard to the head.
          float* headAcc = g_head_acc + f * channels;
          const float* x = g_x + f * channels;
          float* xNext = g_x_next + f * channels;
          for (uint32_t o = 0; o < channels; ++o) {
            z[o] = fastTanh(z[o]);
            headAcc[o] += z[o];
          }

          // The 1x1 back onto the layer's own input: the residual connection
          // that lets a stack this deep train at all.
          for (uint32_t o = 0; o < channels; ++o) xNext[o] = x[o] + oneByOneBias[o];
          for (uint32_t i = 0; i < channels; ++i) {
            accumulateScaled(xNext, oneByOne + i * channels, z[i], channels);
          }
        }

        layer.writeFrame += frames;
        std::memcpy(g_x, g_x_next, channels * frames * sizeof(float));
      }

      // The array's head: a 1x1 from the accumulator down to the width the next
      // array works at, or to one channel if this is the last.
      {
        const float* w = g_weights + array.head;
        const float* bias = g_weights + array.headBiasAt;
        const uint32_t headSize = array.headSize;
        for (uint32_t f = 0; f < frames; ++f) {
          const float* acc = g_head_acc + f * channels;
          float* y = g_head_out + f * headSize;
          for (uint32_t o = 0; o < headSize; ++o) y[o] = array.headBias ? bias[o] : 0.0f;
          for (uint32_t i = 0; i < channels; ++i) {
            accumulateScaled(y, w + i * headSize, acc[i], headSize);
          }
        }
      }

      std::memcpy(g_array_out, g_x, channels * frames * sizeof(float));
      arrayInput = g_array_out;
      arrayInputChannels = channels;
    }

    // The last array heads into one channel, which the loader checked.
    for (uint32_t f = 0; f < frames; ++f) out[f] = headScale_ * g_head_out[f];
  }

 private:
  model_detail::LayerArray arrays_[kModelMaxLayerArrays];
  uint32_t arrayCount_ = 0;
  uint32_t receptiveField_ = 0;
  float headScale_ = 0.0f;
  float loudnessDb_ = 0.0f;
  bool hasLoudness_ = false;
  bool loaded_ = false;
};

}  // namespace tonecraft
