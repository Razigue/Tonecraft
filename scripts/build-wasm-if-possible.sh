#!/usr/bin/env bash
# Rebuilds the wasm when Emscripten is on PATH, and says so plainly when it is
# not.
#
# Without this, `npm run verify` tested whatever artifact happened to be lying
# around: a schema change would pass the typecheck and the native tests, and
# then fail the wasm tests against a binary built before it — which is what
# happened, with the artifact still carrying an old parameter default.
#
# Not every contributor needs Emscripten. Someone touching only the interface
# should be able to run the suite; they just cannot claim the compiled chain was
# checked, so this says which of the two happened.

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if command -v emcc >/dev/null 2>&1; then
  bash "${ROOT}/dsp/build.sh"
  exit 0
fi

if [[ -f "${ROOT}/.toolchain/emsdk/emsdk_env.sh" ]]; then
  # shellcheck disable=SC1091
  source "${ROOT}/.toolchain/emsdk/emsdk_env.sh" >/dev/null 2>&1
  if command -v emcc >/dev/null 2>&1; then
    bash "${ROOT}/dsp/build.sh"
    exit 0
  fi
fi

echo "verify: Emscripten not found, so the wasm was not rebuilt." >&2
echo "        The compiled-chain tests will run against whatever artifact exists," >&2
echo "        which may predate your changes. Install emsdk to check them properly." >&2
