/**
 * The catalogue of amp captures, read from `public/models/index.json`.
 *
 * The index is written by `scripts/vendor-nam.mjs` (which fetches the captures)
 * and completed by `scripts/calibrate-models.mjs` (which measures each one and
 * writes its trim). Nothing here is hardcoded: adding a pack is adding entries
 * to those two scripts and re-running them, and the interface rebuilds itself.
 */

export interface Pack {
  readonly id: string;
  readonly name: string;
  readonly order: number;
}

export interface Capture {
  /** File name under `public/models/`. Captures are addressed by name, never
   *  by index, so the catalogue can be reordered without breaking a preset. */
  readonly file: string;
  readonly name: string;
  readonly pack: string;
  /** The cabinet this capture was voiced against. */
  readonly cab: string;
  /** One sentence, shown under the selector. */
  readonly note: string;
  readonly arch: string;
  readonly weights: number;
  /**
   * Level correction, in dB, measured offline through the cabinet by
   * `scripts/calibrate-models.mjs`. The community captures we ship carry no
   * `loudness` metadata and their own levels span 8.8 dB, so without this,
   * changing capture makes the sound jump.
   */
  readonly trimDb: number;
}

export interface Catalog {
  readonly packs: readonly Pack[];
  readonly models: readonly Capture[];
}

export const EMPTY_CATALOG: Catalog = { packs: [], models: [] };

export async function loadCatalog(baseUrl: string): Promise<Catalog> {
  const response = await fetch(`${baseUrl}models/index.json`);
  if (!response.ok) return EMPTY_CATALOG;
  const data = (await response.json()) as Partial<Catalog>;
  return { packs: data.packs ?? [], models: data.models ?? [] };
}
