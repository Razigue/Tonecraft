// The amp model's weights, as a loadable artifact (AD-14).
//
// Not embedded in the .wasm and not JSON. Embedding would make every amp a
// recompilation, which breaks the lazy-loaded amps the roadmap depends on; JSON
// would round-trip every coefficient through decimal text, and a float that
// does not survive that trip exactly is a tone link that lies (NFR-9).
//
// Layout, little-endian, matching the wire format the schema declares:
//
//     [u32 magic]['TCW1']
//     [u32 version]
//     [u32 count]        number of floats that follow
//     [f32 ...]          LSTM W, LSTM U, LSTM b, dense W, dense b
//
// Every failure is detected here, at init, and reported as a status code.
// Nothing about loading can fail later: process() has no error path (AD-13).

#pragma once

#include <cstdint>
#include <cstring>

#include "params.generated.h"

namespace tonecraft {

/// 'T','C','W','1' little-endian.
inline constexpr uint32_t kWeightsMagic = 0x31574354u;
inline constexpr uint32_t kWeightsVersion = 1u;

/// One LSTM layer, one input, kLstmHiddenSize units, then a dense layer to one
/// output. Four gates, hence the fours.
inline constexpr uint32_t kLstmGates = 4;
inline constexpr uint32_t kLstmInputSize = 1;
inline constexpr uint32_t kWeightsW = kLstmInputSize * kLstmGates * kLstmHiddenSize;
inline constexpr uint32_t kWeightsU = kLstmHiddenSize * kLstmGates * kLstmHiddenSize;
inline constexpr uint32_t kWeightsB = kLstmGates * kLstmHiddenSize;
inline constexpr uint32_t kWeightsDenseW = kLstmHiddenSize;
inline constexpr uint32_t kWeightsDenseB = 1;
inline constexpr uint32_t kWeightsFloatCount =
    kWeightsW + kWeightsU + kWeightsB + kWeightsDenseW + kWeightsDenseB;

enum class WeightsStatus : int32_t {
  Ok = 0,
  TooShort = 1,
  BadMagic = 2,
  UnsupportedVersion = 3,
  /// The blob is well-formed but describes a different model shape — most
  /// likely a different hidden size. Loading it would produce silence or
  /// noise, so it is refused with a name rather than accepted.
  WrongShape = 4,
};

struct WeightsView {
  const float* w = nullptr;
  const float* u = nullptr;
  const float* b = nullptr;
  const float* denseW = nullptr;
  const float* denseB = nullptr;
};

/// Validates and produces a view. Reads nothing beyond `bytes`.
inline WeightsStatus parseWeights(const uint8_t* bytes, uint32_t byteCount,
                                  WeightsView* out) {
  constexpr uint32_t kHeaderBytes = 3 * sizeof(uint32_t);
  if (byteCount < kHeaderBytes) return WeightsStatus::TooShort;

  uint32_t magic = 0;
  uint32_t version = 0;
  uint32_t count = 0;
  std::memcpy(&magic, bytes + 0, sizeof magic);
  std::memcpy(&version, bytes + 4, sizeof version);
  std::memcpy(&count, bytes + 8, sizeof count);

  if (magic != kWeightsMagic) return WeightsStatus::BadMagic;
  if (version != kWeightsVersion) return WeightsStatus::UnsupportedVersion;
  if (count != kWeightsFloatCount) return WeightsStatus::WrongShape;
  if (byteCount < kHeaderBytes + count * sizeof(float)) return WeightsStatus::TooShort;

  const float* f = reinterpret_cast<const float*>(bytes + kHeaderBytes);
  out->w = f;
  out->u = f + kWeightsW;
  out->b = f + kWeightsW + kWeightsU;
  out->denseW = f + kWeightsW + kWeightsU + kWeightsB;
  out->denseB = f + kWeightsW + kWeightsU + kWeightsB + kWeightsDenseW;
  return WeightsStatus::Ok;
}

}  // namespace tonecraft
