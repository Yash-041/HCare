import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { useApp } from "./AppContext";

/** Object URL for a locally stored blob (audio/photo); revoked automatically. */
export function useBlobUrl(blobId: string | null | undefined): string | null {
  const { db } = useApp();
  const entry = useLiveQuery(() => (blobId ? db.blobs.get(blobId) : undefined), [db, blobId]);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!entry) return setUrl(null);
    const u = URL.createObjectURL(entry.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [entry]);
  return url;
}
