/* =============================================================================
   bindings.cpp — the flat C surface `nam-processor.js` instantiates
   -----------------------------------------------------------------------------
   Standalone wasm: no Emscripten JS runtime, no malloc, every buffer static.
   The worklet hands the bytes over by postMessage and instantiates the module
   itself, so nothing here ever fetches and nothing here ever allocates.

   One instance, because the chain runs one amplifier. The buffers are exported
   as pointers rather than passed in, so a caller cannot hand us memory that
   moves: with ALLOW_MEMORY_GROWTH off, the one Float32Array view the worklet
   takes over `memory.buffer` stays valid for the life of the module.
   ========================================================================== */

#include <cstdint>

#include "wavenet.h"

namespace {

tonecraft::WaveNetAmp g_amp;

/* The largest `.tcnm` the bounds in schema/params.ts admit is about 66 kB
   (16 384 weights plus the shape header); 512 kB is room for every size we
   could ship without ever needing to grow memory. */
alignas(16) uint8_t g_blob[512 * 1024];

/* Whole render quanta only. The worklet is handed 128 frames by the platform
   and never asks for more. */
alignas(16) float g_in[tonecraft::kBlockFrames];
alignas(16) float g_out[tonecraft::kBlockFrames];

}  // namespace

extern "C" {

__attribute__((export_name("init"))) void tc_init() { g_amp.init(); }

__attribute__((export_name("blob_ptr"))) uint8_t* tc_blob_ptr() { return g_blob; }
__attribute__((export_name("blob_capacity"))) uint32_t tc_blob_capacity() { return sizeof(g_blob); }
__attribute__((export_name("in_ptr"))) float* tc_in_ptr() { return g_in; }
__attribute__((export_name("out_ptr"))) float* tc_out_ptr() { return g_out; }
__attribute__((export_name("block_frames"))) uint32_t tc_block_frames() { return tonecraft::kBlockFrames; }

/* Returns a tonecraft::ModelStatus. 0 is Ok; every other value names one way
   the blob did not describe a model this kernel can run, and the caller reports
   it by name rather than playing something else. */
__attribute__((export_name("load"))) int32_t tc_load(uint32_t byteCount) {
  return static_cast<int32_t>(g_amp.load(g_blob, byteCount));
}

__attribute__((export_name("loaded"))) int32_t tc_loaded() { return g_amp.loaded() ? 1 : 0; }
__attribute__((export_name("reset"))) void tc_reset() { g_amp.reset(); }
__attribute__((export_name("has_loudness"))) int32_t tc_has_loudness() { return g_amp.hasLoudness() ? 1 : 0; }
__attribute__((export_name("loudness_db"))) float tc_loudness_db() { return g_amp.loudnessDb(); }
__attribute__((export_name("receptive_field"))) uint32_t tc_receptive_field() { return g_amp.receptiveField(); }

__attribute__((export_name("process"))) void tc_process(uint32_t frames) {
  g_amp.process(g_in, g_out, frames);
}

}  // extern "C"
