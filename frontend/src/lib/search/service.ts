import { embed, loadEmbedder } from "../../ai/embed";
import type { HCareDB } from "../db";
import { SearchIndexer } from "./indexer";
import { embedPending, search, type SearchFilters, type SearchHit } from "./search";

const SEMANTIC_KEY = "semantic_search";

/** Owns the local search index and the optional semantic layer for the running app. */
export class SearchService {
  readonly indexer: SearchIndexer;
  semantic = false;
  private embedding: Promise<unknown> | null = null;
  private started = false;

  constructor(private db: HCareDB) {
    this.indexer = new SearchIndexer(db);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.indexer.attach();
    await this.indexer.ensureFresh();
    this.semantic = (await this.db.getMeta<boolean>(SEMANTIC_KEY)) ?? false;
    this.indexer.onIndexed(() => this.refreshEmbeddings());
    this.refreshEmbeddings();
  }

  /** Downloads the 22 MB embedding model (once) and embeds the existing records. */
  async enableSemantic(onProgress?: (f: number) => void): Promise<void> {
    await loadEmbedder(onProgress);
    await this.db.setMeta(SEMANTIC_KEY, true);
    this.semantic = true;
    this.refreshEmbeddings();
    await this.embedding;
  }

  async disableSemantic(): Promise<void> {
    await this.db.setMeta(SEMANTIC_KEY, false);
    this.semantic = false;
  }

  private refreshEmbeddings() {
    if (!this.semantic || this.embedding) return;
    this.embedding = embedPending(this.db, embed)
      .catch((e) => console.warn("semantic indexing paused:", e))
      .finally(() => (this.embedding = null));
  }

  onIndexed(fn: () => void): () => void {
    return this.indexer.onIndexed(fn);
  }

  async query(q: string, filters: SearchFilters = {}): Promise<SearchHit[]> {
    await this.indexer.idle();
    return search(this.db, q, filters, { embed: this.semantic ? embed : undefined });
  }
}
