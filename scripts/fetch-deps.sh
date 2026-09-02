#!/usr/bin/env bash
# Fetches vendored C++ dependencies, pinned by commit.
#
# Not committed: a vendored tree is somebody else's source, and carrying it in
# our history makes every `git log` noisier without making the build more
# reproducible than a pinned SHA already does. CI runs this.
#
# RTNeural has no release tags — the "1.0.0" in its documentation is a docs
# version, not something git can check out — so the SHA is the only honest pin.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="${ROOT}/vendor"

RTNEURAL_REPO="https://github.com/jatinchowdhury18/RTNeural.git"
RTNEURAL_SHA="95c3c0f987a6fe903e7eec71e797405dbed7caf7"
XSIMD_SHA="e88a72831858123924f7118f345dfe5d70d95991"   # xsimd 14.3.0

mkdir -p "${VENDOR}"

if [[ ! -d "${VENDOR}/RTNeural/.git" ]]; then
  git clone --filter=blob:none "${RTNEURAL_REPO}" "${VENDOR}/RTNeural"
fi

git -C "${VENDOR}/RTNeural" fetch --depth 1 origin "${RTNEURAL_SHA}"
git -C "${VENDOR}/RTNeural" checkout --quiet "${RTNEURAL_SHA}"
git -C "${VENDOR}/RTNeural" submodule update --init --depth 1 modules/xsimd

actual="$(git -C "${VENDOR}/RTNeural/modules/xsimd" rev-parse HEAD)"
if [[ "${actual}" != "${XSIMD_SHA}" ]]; then
  printf 'xsimd is at %s, expected %s. RTNeural moved its submodule pin.\n' \
    "${actual}" "${XSIMD_SHA}" >&2
  exit 1
fi

printf 'vendor: RTNeural %s, xsimd %s\n' "${RTNEURAL_SHA:0:12}" "${XSIMD_SHA:0:12}"
