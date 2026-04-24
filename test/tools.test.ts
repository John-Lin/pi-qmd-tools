import { describe, expect, it } from "bun:test";
import { createQmdStore } from "../src/store.ts";
import {
	createQmdGetTool,
	createQmdMultiGetTool,
	createQmdQueryTool,
	createQmdTools,
} from "../src/tools.ts";

/**
 * The schema tests don't open a database — they exercise the tool factory
 * wiring without hitting qmd. A minimal stub store is enough.
 */
const stubStore = {
	search: async () => [],
	get: async () => ({ error: "not found" as const, similarFiles: [] }),
	getDocumentBody: async () => null,
	multiGet: async () => ({ docs: [], errors: [] }),
	getStatus: async () => ({
		totalDocuments: 0,
		needsEmbedding: 0,
		hasVectorIndex: false,
		collections: [],
	}),
	close: async () => {},
} as any;

describe("tool shapes", () => {
	it("exposes three tools with unique names", () => {
		const tools = createQmdTools(stubStore);
		expect(tools.map((t) => t.name)).toEqual(["qmd_query", "qmd_get", "qmd_multi_get"]);
	});

	it("query tool validates searches bounds (1..10)", () => {
		const tool = createQmdQueryTool(stubStore);
		const schema: any = tool.parameters;
		expect(schema.properties.searches.minItems).toBe(1);
		expect(schema.properties.searches.maxItems).toBe(10);
	});

	it("get tool requires file parameter", () => {
		const tool = createQmdGetTool(stubStore);
		const schema: any = tool.parameters;
		expect(schema.required).toContain("file");
	});

	it("multi_get tool requires pattern parameter", () => {
		const tool = createQmdMultiGetTool(stubStore);
		const schema: any = tool.parameters;
		expect(schema.required).toContain("pattern");
	});
});

describe("query behavior with empty results", () => {
	it("returns a no-results message", async () => {
		const tool = createQmdQueryTool(stubStore);
		const result = await tool.execute("call-1", {
			searches: [{ type: "lex", query: "zzz_nothing" }],
		});
		expect(result.content[0]?.type).toBe("text");
		expect((result.content[0] as any).text).toContain("No results");
	});
});

describe("pinned collection", () => {
	it("omits collections from the query schema when a collection is pinned", () => {
		const tool = createQmdQueryTool(stubStore, { collection: "notes" });
		const schema: any = tool.parameters;
		expect(schema.properties.collections).toBeUndefined();
	});

	it("keeps collections in the query schema when no collection is pinned", () => {
		const tool = createQmdQueryTool(stubStore);
		const schema: any = tool.parameters;
		expect(schema.properties.collections).toBeDefined();
	});

	it("forces store.search to receive the pinned collection", async () => {
		let received: any;
		const store = {
			...stubStore,
			search: async (opts: any) => {
				received = opts;
				return [];
			},
		};
		const tool = createQmdQueryTool(store as any, { collection: "notes" });
		await tool.execute("call-1", { searches: [{ type: "lex", query: "foo" }] });
		expect(received.collections).toEqual(["notes"]);
	});

	it("pins the collection via createQmdTools options", async () => {
		let received: any;
		const store = {
			...stubStore,
			search: async (opts: any) => {
				received = opts;
				return [];
			},
		};
		const tools = createQmdTools(store as any, { collection: "notes" });
		const queryTool = tools.find((t) => t.name === "qmd_query")!;
		await queryTool.execute("call-1", { searches: [{ type: "lex", query: "foo" }] });
		expect(received.collections).toEqual(["notes"]);
	});
});

describe("get tool path parsing", () => {
	it("strips ':N' suffix and uses it as fromLine", async () => {
		let receivedFromLine: number | undefined;
		const store = {
			...stubStore,
			get: async (lookup: string) => ({
				filepath: lookup,
				displayPath: lookup,
				title: "t",
				context: null,
				hash: "hash",
				docid: "abc123",
				collectionName: "c",
				modifiedAt: "",
				bodyLength: 0,
			}),
			getDocumentBody: async (_fp: string, opts?: { fromLine?: number }) => {
				receivedFromLine = opts?.fromLine;
				return "body";
			},
		};
		const tool = createQmdGetTool(store as any);
		await tool.execute("call-1", { file: "docs/a.md:42" });
		expect(receivedFromLine).toBe(42);
	});
});

describe("get tool missing body", () => {
	it("throws when getDocumentBody returns null", async () => {
		const store = {
			...stubStore,
			get: async (lookup: string) => ({
				filepath: lookup,
				displayPath: lookup,
				title: "t",
				context: null,
				hash: "hash",
				docid: "abc123",
				collectionName: "c",
				modifiedAt: "",
				bodyLength: 0,
			}),
			getDocumentBody: async () => null,
		};
		const tool = createQmdGetTool(store as any);
		await expect(tool.execute("call-1", { file: "docs/a.md" })).rejects.toThrow(
			/body/i,
		);
	});
});

// ── Integration tests ────────────────────────────────────────────────────
// Skipped unless QMD_TEST_DB points at a real index. To run:
//   QMD_TEST_DB=/Users/you/.cache/qmd/index.sqlite bun test

const dbPath = process.env.QMD_TEST_DB;
const integration = dbPath ? describe : describe.skip;

integration("integration (real qmd index)", () => {
	it("opens a store and runs a lex query", async () => {
		const store = await createQmdStore({ dbPath: dbPath! });
		try {
			const tool = createQmdQueryTool(store);
			const result = await tool.execute("call-1", {
				searches: [{ type: "lex", query: "the" }],
				limit: 1,
				rerank: false,
			});
			expect(result.content[0]?.type).toBe("text");
		} finally {
			await store.close();
		}
	}, 60_000);
});
