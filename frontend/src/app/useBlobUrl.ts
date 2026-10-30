import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { openBlob } from "../lib/crypto/blobs";
import { useApp } from "./AppContext";

/** Object URL for a locally stored (encrypted) blob; decrypted in memory, revoked automatically. */
export function useBlobUrl(blobId: string | null | undefined): string | null {
  const { db } = useApp();
  const entry = useLiveQuery(() => (blobId ? db.blobs.get(blobId) : undefined), [db, blobId]);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let u: string | null = null;
    void openBlob(entry, db)
      .then((blob) => {
        if (cancelled || !blob) return setUrl(null);
        u = URL.createObjectURL(blob);
        setUrl(u);
      })
      .catch(() => setUrl(null));
    return () => {
      cancelled = true;
      if (u) URL.revokeObjectURL(u);
    };
  }, [entry, db]);
  return url;
}
