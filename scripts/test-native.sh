#!/usr/bin/env bash
# DSP tests that are easier to write and far faster to run natively than through
# WebAssembly. They test the same source the wasm build compiles.
#
# Not a replacement for engine/wasm.test.ts, which tests the shipped artifact.
# This is for the signal-processing questions — does the filter filter, does the
# window remove what it is there to remove — where a spectrum is the answer.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$(mktemp -d)"
trap 'rm -rf "${OUT}"' EXIT

status=0
for src in "${ROOT}"/dsp/tests/*.test.cpp; do
  name="$(basename "${src}" .test.cpp)"
  printf '\n%s\n' "${name}"
  g++ -std=c++20 -O2 -Wall -Wextra \
    -I "${ROOT}/dsp" \
    -isystem "${ROOT}/dsp/amp/faust" \
    "${src}" -o "${OUT}/${name}"
  "${OUT}/${name}" || status=1
done

exit "${status}"
