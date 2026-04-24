import { createStore, type QMDStore } from "@tobilu/qmd";

/**
 * Read-only facade over qmd's QMDStore. Hides collection/context/indexing
 * write methods so callers can only search and retrieve.
 *
 * Note: qmd's search() still writes to an internal LLM cache table during
 * query expansion and reranking. That's benign and bounded — it is not an
 * index mutation. Host-side `qmd update`/`qmd embed` are the only paths
 * that should mutate real data, and those are intentionally not exposed.
 */
export type QmdReadStore = Pick<
	QMDStore,
	"search" | "get" | "getDocumentBody" | "multiGet" | "getStatus" | "close"
>;

export interface CreateQmdStoreOptions {
	/** Absolute path to the qmd SQLite index (typically `~/.cache/qmd/index.sqlite`). */
	dbPath: string;
	/**
	 * Run a throwaway vector search at startup to preload the embedding model.
	 * Without this, the first real query pays a 5–10s llama.cpp load penalty.
	 */
	warmup?: boolean;
}

/**
 * Open a qmd store as a read-only facade.
 *
 * The returned object only exposes search/retrieval methods. Write-capable
 * methods on the underlying QMDStore (addCollection, update, embed,
 * addContext, removeContext, …) are deliberately not re-exported.
 */
export async function createQmdStore(options: CreateQmdStoreOptions): Promise<QmdReadStore> {
	const store: QMDStore = await createStore({ dbPath: options.dbPath });

	if (options.warmup) {
		try {
			await store.search({ query: "warmup", limit: 1, rerank: false });
		} catch {
			// Warmup failures must not block startup — a missing embedding
			// model, empty index, etc. should surface on first real call.
		}
	}

	return {
		search: store.search,
		get: store.get,
		getDocumentBody: store.getDocumentBody,
		multiGet: store.multiGet,
		getStatus: store.getStatus,
		close: store.close,
	};
}
