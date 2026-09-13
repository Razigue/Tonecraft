/**
 * Whether the Tonecraft Engine on this computer is the newest release.
 *
 * An engine installed by hand never updates itself — the versions already out
 * there have no code to — so the page asks GitHub which release is newest and
 * offers the download when the running engine is older. GitHub's public API
 * answers browsers directly (CORS `*`), free and without a server of ours, but
 * only 60 times an hour per address: the answer is kept for six hours.
 * A failure says nothing. An update is never worth an error message.
 */

const RELEASES_API = 'https://api.github.com/repos/Razigue/Tonecraft/releases?per_page=20';
const CACHE_KEY = 'tonecraft:engine-latest';
const CACHE_MS = 6 * 60 * 60 * 1000;

type Version = readonly [number, number, number];

export function parseVersion(text: string): Version | null {
  const m = /^(?:engine-)?v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Negative when `a` is older than `b`, zero when equal, positive when newer. Unreadable versions compare equal. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b);
  if (x === null || y === null) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/** The newest published engine release in GitHub's release list, as `0.1.2`. */
export function newestEngine(releases: unknown): string | null {
  if (!Array.isArray(releases)) return null;
  let best: string | null = null;
  for (const r of releases as { tag_name?: unknown; draft?: unknown; prerelease?: unknown }[]) {
    if (typeof r?.tag_name !== 'string' || r.draft === true || r.prerelease === true) continue;
    if (!r.tag_name.startsWith('engine-v') || parseVersion(r.tag_name) === null) continue;
    const version = r.tag_name.slice('engine-v'.length);
    if (best === null || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

interface Options {
  readonly fetch?: typeof fetch;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  readonly now?: number;
}

function defaultStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** The newest engine release, from the cache when it is fresh. Never throws. */
export async function latestEngineVersion(options: Options = {}): Promise<string | null> {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const now = options.now ?? Date.now();
  try {
    const cached = JSON.parse(storage?.getItem(CACHE_KEY) ?? 'null') as { version?: unknown; at?: unknown } | null;
    if (cached !== null && typeof cached.version === 'string' && typeof cached.at === 'number'
        && now - cached.at >= 0 && now - cached.at < CACHE_MS) return cached.version;
  } catch { /* an unreadable cache is no cache */ }
  try {
    const response = await (options.fetch ?? fetch)(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) return null;
    const version = newestEngine(await response.json());
    if (version !== null) {
      try { storage?.setItem(CACHE_KEY, JSON.stringify({ version, at: now })); } catch { /* storage full or refused */ }
    }
    return version;
  } catch {
    return null;
  }
}

/** The newer release when `current` is older than the newest one, otherwise null. */
export async function engineUpdate(current: string, options: Options = {}): Promise<string | null> {
  if (parseVersion(current) === null) return null;
  const latest = await latestEngineVersion(options);
  return latest !== null && compareVersions(current, latest) < 0 ? latest : null;
}
