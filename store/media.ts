/**
 * Files the player handed us, kept on their machine.
 *
 * Today: the last DI take, so a reload or a Stop/Start no longer throws it
 * away. Next: Guitar Pro scores and backing tracks, which is why a record
 * carries a `kind` and the store is indexed on it.
 *
 * The bytes are stored as the `Blob` they arrived as: no base64, no copy into
 * a string, and IndexedDB keeps it off the JS heap until it is read.
 */

import { STORES, dbDelete, dbGet, dbGetAll, dbPut } from './db.ts';

/** Append new kinds; never rename one, it is written in the player's database. */
export type MediaKind = 'take' | 'score' | 'backing';

export interface MediaRecord {
  readonly id: string;
  readonly kind: MediaKind;
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly addedAt: number;
  readonly blob: Blob;
}

/** Metadata only, for lists that must not pull every blob into memory. */
export type MediaInfo = Omit<MediaRecord, 'blob'>;

/** Stores a file and returns its id, or `null` when this browser keeps nothing. */
export async function saveMedia(file: File, kind: MediaKind, id: string = crypto.randomUUID()): Promise<string | null> {
  const record: MediaRecord = {
    id, kind, name: file.name, type: file.type, size: file.size, addedAt: Date.now(), blob: file,
  };
  return (await dbPut(STORES.media, record)) ? id : null;
}

/** The file back, with its original name and type, or `null` when it is gone. */
export async function loadMedia(id: string): Promise<File | null> {
  const record = await dbGet<MediaRecord>(STORES.media, id);
  if (record === undefined) return null;
  return new File([record.blob], record.name, { type: record.type });
}

export function deleteMedia(id: string): Promise<void> {
  return dbDelete(STORES.media, id);
}

export async function listMedia(kind: MediaKind): Promise<MediaInfo[]> {
  const all = await dbGetAll<MediaRecord>(STORES.media, 'kind', kind);
  return all.map(({ blob: _blob, ...info }) => info);
}
