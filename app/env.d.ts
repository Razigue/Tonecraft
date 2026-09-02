/// <reference types="astro/client" />

// Astro also emits `.astro/types.d.ts` with this reference, but that file is
// build output and is git-ignored — so a clean checkout typechecking before its
// first build would not have it. CI found this on the very first run: the
// typecheck failed on `import.meta.env.BASE_URL` while passing locally, purely
// because the local tree had been built already.
//
// Referencing the types directly makes the typecheck independent of whether
// anything has been generated yet.
