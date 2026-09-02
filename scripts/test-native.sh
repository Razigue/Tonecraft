#!/usr/bin/env bash
# DSP tests that are easier to write and far faster to run natively than through
# WebAssembly. They test the same source the wasm build compiles.
#
# Not a replacement for engine/wasm.test.ts, which tests the shipped artifact.
# This is for the signal-processing questions — does the filter filter, does the
# window remove what it is there to remove — where a spectrum is the answer.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# These compile against generated headers. Depending on some earlier step
# having produced them is how a suite passes on a warm tree and fails on a cold
# one — which is exactly what happened on the first CI run.
for generated in "${ROOT}/dsp/params.generated.h" "${ROOT}/dsp/amp/faust/amp.generated.h"; do
  if [[ ! -f "${generated}" ]]; then
    printf '%s is missing. Run: npm run generate\n' "${generated#"${ROOT}/"}" >&2
    exit 1
  fi
done
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
