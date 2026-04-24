import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
	addLineNumbers,
	DEFAULT_MULTI_GET_MAX_BYTES,
	extractSnippet,
	type ExpandedQuery,
} from "@tobilu/qmd";
import { Type } from "typebox";
import type { QmdReadStore } from "./store.ts";

const SNIPPET_CHARS = 300;

// ─── qmd_query ────────────────────────────────────────────────────────────

const subSearchSchema = Type.Object({
	type: Type.Union([Type.Literal("lex"), Type.Literal("vec"), Type.Literal("hyde")], {
		description:
			"lex = BM25 keywords (supports \"phrase\" and -negation); vec = natural-language semantic search; hyde = 50–100 word hypothetical answer",
	}),
	query: Type.String({ description: "The query text for this sub-search" }),
});

const queryBaseFields = {
	label: Type.String({
		description: "Brief description of what you're searching for (shown to user)",
	}),
	searches: Type.Array(subSearchSchema, {
		minItems: 1,
		maxItems: 10,
		description:
			"Typed sub-queries to combine. First entry gets 2× weight — lead with your strongest signal. For unknown vocabulary, a single vec or hyde sub-query is usually best.",
	}),
	limit: Type.Optional(
		Type.Number({ description: "Max results (default 10)" }),
	),
	minScore: Type.Optional(
		Type.Number({ description: "Minimum relevance score 0-1 (default 0)" }),
	),
	intent: Type.Optional(
		Type.String({
			description:
				"Background context that disambiguates the query — does not search on its own. Example: query='performance', intent='web page load times and Core Web Vitals'.",
		}),
	),
	rerank: Type.Optional(
		Type.Boolean({
			description:
				"LLM reranking for quality (default true). Set false for faster results (~5–10s instead of ~10–30s).",
		}),
	),
};

const querySchema = Type.Object({
	...queryBaseFields,
	collections: Type.Optional(
		Type.Array(Type.String(), {
			description: "Restrict to these collections (OR match). Omit to search all default collections.",
		}),
	),
});

const querySchemaPinned = Type.Object(queryBaseFields);

export interface CreateQmdQueryToolOptions {
	/** If set, the tool is pinned to this single collection — the `collections` field is removed from the agent-facing schema and every search is forced to this collection. */
	collection?: string;
	/**
	 * Default minimum score floor (0-1). Applied when the agent doesn't pass
	 * `minScore` explicitly; the agent can still override by passing its own
	 * `minScore` (including 0 to disable). See the qmd score distribution —
	 * results are bimodal around ~0.9 and ~0.55, so a floor of 0.5 is a good
	 * "precision" default.
	 */
	minScore?: number;
}

const queryDescription = `Search the qmd knowledge base over markdown collections on the host.

Combine typed sub-queries for best recall:
- **lex** — BM25 keyword ("quoted phrase" + -negation). Fast, exact.
- **vec** — natural-language semantic search. Use a real question.
- **hyde** — 50–100 words of hypothetical answer. Strongest for nuanced topics.

Strategy:
- Know the exact term → \`lex\` only
- Concept search → \`vec\` only
- Best recall → \`lex\` + \`vec\`
- Complex / nuanced → \`lex\` + \`vec\` + \`hyde\`
- Unknown vocabulary → a single vec sub-query (auto-expansion kicks in on a bare vec)

Returns docid, displayPath, title, score, and a snippet. **Use the returned docid (e.g. \`#abc123\`) with qmd_get to fetch the full body — do NOT pass the path to an unrelated read tool, the path is on the host and unrelated tools may not see it.**`;

export function createQmdQueryTool(
	store: QmdReadStore,
	options?: CreateQmdQueryToolOptions,
): AgentTool<any> {
	const pinned = options?.collection;
	const defaultMinScore = options?.minScore;
	const parameters = pinned ? querySchemaPinned : querySchema;
	return {
		name: "qmd_query",
		label: "qmd query",
		description: queryDescription,
		parameters,
		execute: async (_toolCallId, args: any) => {
			const queries: ExpandedQuery[] = args.searches.map((s: any) => ({
				type: s.type,
				query: s.query,
			}));
			const collections = pinned
				? [pinned]
				: args.collections && args.collections.length > 0
					? args.collections
					: undefined;
			const results = await store.search({
				queries,
				collections,
				limit: args.limit,
				minScore: args.minScore ?? defaultMinScore,
				rerank: args.rerank,
				intent: args.intent,
			});

			const primaryQuery =
				args.searches.find((s: any) => s.type === "lex")?.query ??
				args.searches.find((s: any) => s.type === "vec")?.query ??
				args.searches[0]?.query ??
				"";

			if (results.length === 0) {
				return {
					content: [{ type: "text", text: `No results found for "${primaryQuery}"` }],
					details: { results: [] },
				};
			}

			const items = results.map((r) => {
				const { line, snippet } = extractSnippet(
					r.bestChunk,
					primaryQuery,
					SNIPPET_CHARS,
					undefined,
					undefined,
					args.intent,
				);
				return {
					docid: `#${r.docid}`,
					file: r.displayPath,
					title: r.title,
					score: Math.round(r.score * 100) / 100,
					context: r.context,
					snippet: addLineNumbers(snippet, line),
				};
			});

			const lines = [
				`Found ${items.length} result${items.length === 1 ? "" : "s"} for "${primaryQuery}":`,
				"",
			];
			for (const r of items) {
				lines.push(`${r.docid}  ${Math.round(r.score * 100)}%  ${r.file} — ${r.title}`);
				if (r.context) lines.push(`  context: ${r.context}`);
				lines.push(
					r.snippet
						.split("\n")
						.map((ln) => `    ${ln}`)
						.join("\n"),
				);
				lines.push("");
			}

			return {
				content: [{ type: "text", text: lines.join("\n").trimEnd() }],
				details: { results: items },
			};
		},
	};
}

// ─── qmd_get ──────────────────────────────────────────────────────────────

const getSchema = Type.Object({
	label: Type.String({
		description: "Brief description of what you're fetching (shown to user)",
	}),
	file: Type.String({
		description:
			"File path (e.g. 'pages/meeting.md') or docid (e.g. '#abc123') from a qmd_query result. Append ':N' to start at line N (e.g. 'pages/meeting.md:100').",
	}),
	fromLine: Type.Optional(
		Type.Number({ description: "Start at this 1-indexed line number (overrides ':N' suffix)" }),
	),
	maxLines: Type.Optional(Type.Number({ description: "Max lines to return" })),
	lineNumbers: Type.Optional(
		Type.Boolean({ description: "Prepend 'N: ' line numbers to each line (default false)" }),
	),
});

export function createQmdGetTool(store: QmdReadStore): AgentTool<typeof getSchema> {
	return {
		name: "qmd_get",
		label: "qmd get",
		description:
			"Fetch the full body of a document from qmd by displayPath or docid. Use on docids/paths returned by qmd_query.",
		parameters: getSchema,
		execute: async (_toolCallId, args) => {
			// Support ':N' suffix on `file` when fromLine isn't given.
			let lookup = args.file;
			let fromLine = args.fromLine;
			const match = lookup.match(/:(\d+)$/);
			if (match && match[1] && fromLine === undefined) {
				fromLine = parseInt(match[1], 10);
				lookup = lookup.slice(0, -match[0].length);
			}

			const found = await store.get(lookup, { includeBody: false });
			if ("error" in found) {
				let msg = `Document not found: ${args.file}`;
				if (found.similarFiles.length > 0) {
					msg += `\n\nSimilar files:\n${found.similarFiles.map((s) => `  - ${s}`).join("\n")}`;
				}
				throw new Error(msg);
			}

			const body = await store.getDocumentBody(found.filepath, {
				fromLine,
				maxLines: args.maxLines,
			});
			if (body === null) {
				throw new Error(
					`Document body unavailable for ${found.displayPath} (${found.filepath}). The index has metadata but no body — likely a stale/partial index; try \`qmd update\`.`,
				);
			}
			let text = body;
			if (args.lineNumbers) {
				text = addLineNumbers(text, fromLine ?? 1);
			}
			if (found.context) {
				text = `<!-- Context: ${found.context} -->\n\n${text}`;
			}

			const header = `### ${found.displayPath} — ${found.title}\n`;
			return {
				content: [{ type: "text", text: header + text }],
				details: {
					docid: `#${found.docid}`,
					displayPath: found.displayPath,
					title: found.title,
				},
			};
		},
	};
}

// ─── qmd_multi_get ────────────────────────────────────────────────────────

const multiGetSchema = Type.Object({
	label: Type.String({
		description: "Brief description of what you're fetching (shown to user)",
	}),
	pattern: Type.String({
		description:
			"Glob pattern (e.g. 'journals/2025-05*.md') or comma-separated list of paths/docids.",
	}),
	maxLines: Type.Optional(
		Type.Number({ description: "Max lines per file (whole file if omitted)" }),
	),
	maxBytes: Type.Optional(
		Type.Number({
			description: `Skip files larger than this (default ${DEFAULT_MULTI_GET_MAX_BYTES} bytes)`,
		}),
	),
	lineNumbers: Type.Optional(
		Type.Boolean({ description: "Prepend 'N: ' line numbers to each line (default false)" }),
	),
});

export function createQmdMultiGetTool(store: QmdReadStore): AgentTool<typeof multiGetSchema> {
	return {
		name: "qmd_multi_get",
		label: "qmd multi-get",
		description:
			"Fetch multiple documents at once by glob pattern or comma-separated list. Skips files larger than maxBytes (use qmd_get for those individually).",
		parameters: multiGetSchema,
		execute: async (_toolCallId, args) => {
			const { docs, errors } = await store.multiGet(args.pattern, {
				includeBody: true,
				maxBytes: args.maxBytes ?? DEFAULT_MULTI_GET_MAX_BYTES,
			});

			if (docs.length === 0 && errors.length === 0) {
				return {
					content: [{ type: "text", text: `No files matched pattern: ${args.pattern}` }],
					details: { docs: [], errors: [] },
				};
			}

			const sections: string[] = [];
			if (errors.length > 0) {
				sections.push(`Errors:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
			}

			for (const result of docs) {
				if (result.skipped) {
					sections.push(
						`### ${result.doc.displayPath}\n[SKIPPED: ${result.skipReason}. Use qmd_get to retrieve.]`,
					);
					continue;
				}
				let text = result.doc.body ?? "";
				if (args.maxLines !== undefined) {
					const lines = text.split("\n");
					text = lines.slice(0, args.maxLines).join("\n");
					if (lines.length > args.maxLines) {
						text += `\n\n[... truncated ${lines.length - args.maxLines} more lines]`;
					}
				}
				if (args.lineNumbers) {
					text = addLineNumbers(text);
				}
				if (result.doc.context) {
					text = `<!-- Context: ${result.doc.context} -->\n\n${text}`;
				}
				sections.push(`### ${result.doc.displayPath} — ${result.doc.title}\n${text}`);
			}

			return {
				content: [{ type: "text", text: sections.join("\n\n") }],
				details: {
					docs: docs.map((d) =>
						d.skipped
							? { displayPath: d.doc.displayPath, skipped: true, skipReason: d.skipReason }
							: { displayPath: d.doc.displayPath, title: d.doc.title, skipped: false },
					),
					errors,
				},
			};
		},
	};
}

// ─── Aggregate ────────────────────────────────────────────────────────────

export interface CreateQmdToolsOptions {
	/** Pin qmd_query to a single collection. See CreateQmdQueryToolOptions. */
	collection?: string;
	/** Default minimum score floor for qmd_query. See CreateQmdQueryToolOptions. */
	minScore?: number;
}

export function createQmdTools(
	store: QmdReadStore,
	options?: CreateQmdToolsOptions,
): AgentTool<any>[] {
	return [
		createQmdQueryTool(store, {
			collection: options?.collection,
			minScore: options?.minScore,
		}),
		createQmdGetTool(store),
		createQmdMultiGetTool(store),
	];
}
