/**
 * Photos and recordings, encrypted with WebCrypto AES-GCM. Bytes are encrypted *before*
 * the IndexedDB write (WebCrypto is async and must not run inside a transaction).
 */
import type { HCareDB } from "../db";
import type { BlobEntry } from "../types";

export async function sealBlob(db: HCareDB, id: string, blob: Blob, mimeType: string): Promise<BlobEntry> {
  if (!db.vault.unlocked) {
    if (db.vault.required) throw new Error("locked");
    return { id, blob, mime_type: mimeType };
  }
  const { iv, ct } = await db.vault.encryptBytes(await blob.arrayBuffer(), `blob:${id}`);
  return { id, mime_type: mimeType, iv, ct };
}

export async function putBlobs(db: HCareDB, entries: { id: string; blob: Blob; mime_type: string }[]): Promise<void> {
  const sealed = await Promise.all(entries.map((e) => sealBlob(db, e.id, e.blob, e.mime_type)));
  await db.blobs.bulkPut(sealed);
}

export async function openBlob(entry: BlobEntry | undefined, db: HCareDB): Promise<Blob | undefined> {
  if (!entry) return undefined;
  if (entry.blob) return entry.blob;
  if (!entry.ct || !entry.iv) return undefined;
  const bytes = await db.vault.decryptBytes(entry.iv, entry.ct, `blob:${entry.id}`);
  return new Blob([bytes], { type: entry.mime_type });
}

export async function getBlob(db: HCareDB, id: string): Promise<Blob | undefined> {
  return openBlob(await db.blobs.get(id), db);
}
