import Dexie from "dexie";
import type { HCareDB } from "../db";

const WIPED_FLAG = "hcare_wiped";

/**
 * Erase all patient data on this device: forget the key, delete the whole IndexedDB
 * database (records, outbox, photos, recordings, sessions, wrapped keys). App code and AI
 * models stay cached, since they hold no patient data.
 */
export async function wipeDevice(db: HCareDB): Promise<void> {
  db.vault.lock();
  const name = db.name;
  db.close();
  await Dexie.delete(name);
  try {
    sessionStorage.setItem(WIPED_FLAG, "1");
  } catch {
    /* not in a browser (tests) */
  }
}

/** True once after a wipe, so the sign-in screen can say what happened. */
export function consumeWipedFlag(): boolean {
  try {
    const was = sessionStorage.getItem(WIPED_FLAG) === "1";
    sessionStorage.removeItem(WIPED_FLAG);
    return was;
  } catch {
    return false;
  }
}
