/**
 * The update check for Tonecraft Engine: which release is newest, whether the
 * running engine is older, and that GitHub is asked at most once in six hours.
 *
 * Usage:  npm run test:engine-update
 */

import { compareVersions, engineUpdate, latestEngineVersion, newestEngine, parseVersion } from './engine-update.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

check('versions read with or without the tag prefix', JSON.stringify(parseVersion('engine-v0.1.2')) === '[0,1,2]'
  && JSON.stringify(parseVersion('0.10.0')) === '[0,10,0]' && parseVersion('nightly') === null);
check('versions compare as numbers, not text', compareVersions('0.1.10', '0.1.9') > 0 && compareVersions('0.1.1', '0.2.0') < 0
  && compareVersions('1.0.0', '1.0.0') === 0);

const RELEASES = [
  { tag_name: 'engine-v0.3.0', draft: true, prerelease: false },
  { tag_name: 'engine-v0.2.1', draft: false, prerelease: true },
  { tag_name: 'site-2026-09', draft: false, prerelease: false },
  { tag_name: 'engine-v0.1.10', draft: false, prerelease: false },
  { tag_name: 'engine-v0.1.9', draft: false, prerelease: false },
];
check('the newest published engine release wins, drafts, prereleases and other tags aside',
  newestEngine(RELEASES) === '0.1.10', String(newestEngine(RELEASES)));
check('an answer that is not a list is no release', newestEngine({ message: 'rate limited' }) === null);

function memory(): Pick<Storage, 'getItem' | 'setItem'> {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); } };
}
function github(body: unknown, ok = true): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  const f = (async () => { calls++; return { ok, json: async () => body } as Response; }) as typeof fetch;
  return { fetch: f, calls: () => calls };
}

{
  const storage = memory();
  const api = github(RELEASES);
  const now = 1_000_000_000;
  const first = await engineUpdate('0.1.2', { fetch: api.fetch, storage, now });
  const second = await engineUpdate('0.1.2', { fetch: api.fetch, storage, now: now + 60 * 60 * 1000 });
  check('an older engine is offered the newest release', first === '0.1.10', String(first));
  check('and GitHub is asked once for the next six hours', second === '0.1.10' && api.calls() === 1, `${api.calls()} request(s)`);
  await latestEngineVersion({ fetch: api.fetch, storage, now: now + 7 * 60 * 60 * 1000 });
  check('then asked again', api.calls() === 2, `${api.calls()} request(s)`);
  check('the newest engine, or a newer local build, is offered nothing',
    await engineUpdate('0.1.10', { fetch: api.fetch, storage, now }) === null
    && await engineUpdate('0.2.0', { fetch: api.fetch, storage, now }) === null);
}

{
  const failing = (async () => { throw new TypeError('offline'); }) as typeof fetch;
  const limited = github({ message: 'API rate limit exceeded' }, false);
  check('offline, rate limited or without storage, the check says nothing and never throws',
    await engineUpdate('0.1.0', { fetch: failing, storage: null }) === null
    && await engineUpdate('0.1.0', { fetch: limited.fetch, storage: memory() }) === null);
}

console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
