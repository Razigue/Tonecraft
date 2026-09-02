# Version reality check — Tonecraft v1 spine

Every pinned technology checked against the web on 2026-09-02 rather than asserted from training data.

| Name | Asserted from memory | Verified | Verdict |
| --- | --- | --- | --- |
| Astro | 5.x | **7.2.10**, 2026-08-31 | Corrected. Two majors out of date. |
| Svelte | 5 | **5.57.x** | Holds. SvelteKit 3 in preview, not used. |
| Emscripten | 3.x | **6.0.x** | Corrected. |
| RTNeural | 1.0.0 | 1.0.0, header-only, compile-time API | Holds. |
| nanostores | 0.11.x | **1.5.2** | Corrected. The library went 1.x. |
| Tailwind | 4.x | **4.3.3** | Corrected to the exact line. |
| Node | 22 LTS | **24 LTS (Krypton)**; 22 is maintenance | Corrected. |
| GoatCounter | assumed custom events | Custom events confirmed | Holds. |
| Cloudflare Web Analytics | assumed no custom events | **Unverified** | Recorded as unverified, not rejected. |

**Relaxed SIMD**, checked because AD-4 depends on it: ships in Chrome 114+ and Firefox 145+, still behind a flag in Safari. More importantly it is *defined* to permit engine-specific float rounding — which is the reason AD-4 forbids it, independent of support.

**ConvolverNode**, checked because AD-3 depends on it: the W3C convolution architecture is non-normative and the spec itself calls a well-optimised real-time convolution engine one of the hardest parts of the API. Per-browser divergence is therefore expected behaviour, not a bug.

Seven of nine pinned versions were wrong from memory. Three were materially wrong (Astro two majors behind, nanostores a major behind, Node one LTS behind).
