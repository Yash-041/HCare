/**
 * One-time upgrade of data written before encryption existed: re-saving each row makes the
 * middleware encrypt it; plain photos/recordings are sealed. Runs after the first unlock.
 */
import type { HCareDB } from "../db";
import { sealBlob } from "./blobs";
import { ENCRYPTED } from "./middleware";

const DONE_KEY = "encrypted_at_rest_v1";

export async function encryptExistingData(db: HCareDB): Promise<void> {
  if (!db.vault.unlocked || (await db.getMeta<boolean>(DONE_KEY))) return;
  for (const table of Object.keys(ENCRYPTED)) {
    const rows = await db.table(table).toArray(); // decrypted (or plain) view
    if (rows.length) await db.table(table).bulkPut(rows); // re-written encrypted
  }
  const plainBlobs = (await db.blobs.toArray()).filter((b) => b.blob);
  for (const b of plainBlobs) await db.blobs.put(await sealBlob(db, b.id, b.blob!, b.mime_type));
  await db.setMeta(DONE_KEY, true);
}
