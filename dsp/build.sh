#!/usr/bin/env bash
# Builds the amp model to WebAssembly: public/nam/wavenet.wasm.
#
# Flags are not negotiable (CLAUDE.md section 3):
#
#   -O3 -msimd128 -flto -fno-exceptions -fno-rtti
#
# `-mrelaxed-simd` is FORBIDDEN. Relaxed SIMD is defined to permit
# engine-specific floating-point rounding so engines can map straight onto
# native instructions. That is faster, and it would make the same tone state
# render differently in different browsers — which makes every shared tone link
# a lie, and the tone link is the only mechanism by which one user creates
# another.
#
# STANDALONE_WASM: a bare .wasm module with no Emscripten JS runtime. The
# worklet instantiates it from bytes handed over by postMessage and never
# fetches. There is no malloc — every buffer is static — so memory never grows
# and the typed-array views over it never detach.
#
# The artifact is committed, so neither CI nor GitHub Pages needs emsdk. Run
# this only when dsp/ or the schema's model bounds change.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${ROOT}/public/nam/wavenet.wasm"

EMCC="${EMCC:-${ROOT}/.toolchain/emsdk/upstream/emscripten/emcc}"
if [ ! -x "${EMCC}" ]; then
  echo "dsp: emcc not found at ${EMCC} — set EMCC=/path/to/emcc" >&2
  exit 1
fi

npx tsx "${ROOT}/scripts/generate-model-header.ts"

"${EMCC}" \
  -std=c++20 \
  -O3 -msimd128 -flto -fno-exceptions -fno-rtti \
  -Wall -Wextra -Werror \
  -I "${ROOT}/dsp/model" \
  --no-entry \
  -sSTANDALONE_WASM=1 \
  -sALLOW_MEMORY_GROWTH=0 \
  -sINITIAL_MEMORY=16MB \
  "${ROOT}/dsp/model/bindings.cpp" \
  -o "${OUT}"

printf 'dsp: wrote public/nam/wavenet.wasm (%s bytes)\n' "$(stat -c%s "${OUT}")"
