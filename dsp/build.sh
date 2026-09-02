#!/usr/bin/env bash
# Builds the DSP chain to WebAssembly.
#
# Flags are NFR-14 and are not negotiable:
#
#   -O3 -msimd128 -flto -fno-exceptions -fno-rtti
#
# `-mrelaxed-simd` is FORBIDDEN (AD-4). Relaxed SIMD is defined to permit
# engine-specific floating-point rounding so engines can map straight onto
# native instructions. That is faster, and it would make the same tone state
# render differently in different browsers — which makes every shared tone link
# a lie, and the tone link is the only mechanism in v1 by which one user creates
# another. `scripts/check-build-flags.sh` fails the build if it ever appears.
#
# STANDALONE_WASM: a bare .wasm module with no Emscripten JS runtime. The
# worklet instantiates it from bytes handed over by postMessage and never
# fetches. There is no malloc — every buffer is static — so memory never grows
# and the typed-array views over it never detach.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${ROOT}/public/tonecraft.wasm"

EXPORTS='_tc_init,_tc_process,_tc_set_param,_tc_get_param,_tc_input_ptr,_tc_output_ptr,_tc_meter_ptr,_tc_param_count,_tc_meter_count,_tc_block_frames,_tc_internal_sample_rate,_tc_added_latency_frames,_tc_resampling'

mkdir -p "$(dirname "${OUT}")"

emcc \
  -std=c++20 \
  -O3 -msimd128 -flto -fno-exceptions -fno-rtti \
  -Wall -Wextra -Werror \
  -I "${ROOT}/dsp" \
  --no-entry \
  -sSTANDALONE_WASM=1 \
  -sALLOW_MEMORY_GROWTH=0 \
  -sEXPORTED_FUNCTIONS="${EXPORTS}" \
  "${ROOT}/dsp/chain.cpp" \
  "${ROOT}/dsp/bindings.cpp" \
  -o "${OUT}"

printf 'dsp: wrote public/tonecraft.wasm (%s bytes)\n' "$(stat -c%s "${OUT}")"
