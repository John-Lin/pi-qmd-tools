# pi-qmd-tools

[qmd](https://github.com/tobilu/qmd) search/retrieval exposed as `AgentTool`s for hosts built on [`@mariozechner/pi-agent-core`](https://www.npmjs.com/package/@mariozechner/pi-agent-core) (e.g. `pi-mom`, `pi-coding-agent`, or any custom agent loop).

The qmd SDK runs **in-process** — the host's GPU and SQLite index are used directly, no subprocess or sidecar.

## What you get

Three tools, all returning standard `AgentTool` shapes:

| Tool             | Purpose                                                                |
| ---------------- | ---------------------------------------------------------------------- |
| `qmd_query`      | Natural-language search over markdown collections (lex+vec+hyde+rerank)|
| `qmd_get`        | Fetch a full document body by `displayPath` or `#docid`                |
| `qmd_multi_get`  | Fetch many docs by glob or comma-separated list                        |

`qmd_query` returns docids the agent then feeds back into `qmd_get` — the path on disk lives on the host and shouldn't be passed to unrelated read tools.

## Install

```bash
# from the consuming project
npm install pi-qmd-tools           # or: bun add pi-qmd-tools
```

Peer deps (must already be installed by the host):

- `@mariozechner/pi-agent-core` `>=0.69.0 <0.71.0`
- `@mariozechner/pi-ai`         `>=0.69.0 <0.71.0`

Local dev against a checkout:

```json
{ "dependencies": { "pi-qmd-tools": "file:../pi-qmd-tools" } }
```

## Usage

```ts
import { createQmdStore, createQmdTools } from "pi-qmd-tools";
import { Agent } from "@mariozechner/pi-agent-core";

const store = await createQmdStore({
  dbPath: `${process.env.HOME}/.cache/qmd/index.sqlite`,
  warmup: true,   // preload embedding model so first query isn't 5–10s slower
});

const tools = createQmdTools(store, {
  // Optional: pin every search to one collection (removes `collections`
  // field from the agent-facing schema).
  collection: "notes",
  // Optional: default minScore floor (0–1). Agent can still override.
  // qmd scores are bimodal around ~0.9 / ~0.55, so 0.5 is a good
  // "precision" default.
  minScore: 0.5,
});

const agent = new Agent({
  // …model, system prompt, etc…
  tools: [...yourOtherTools, ...tools],
});
```

Want only one of the tools? Use the per-tool factories instead:

```ts
import {
  createQmdQueryTool,
  createQmdGetTool,
  createQmdMultiGetTool,
} from "pi-qmd-tools";

const tools = [
  createQmdQueryTool(store, { collection: "notes" }),
  createQmdGetTool(store),
];
```

## Read-only by design

`createQmdStore` returns a `QmdReadStore` facade that only exposes `search` / `get` / `getDocumentBody` / `multiGet` / `getStatus` / `close`. Index mutation (`addCollection`, `update`, `embed`, `addContext`, …) is intentionally not re-exported — `qmd update` / `qmd embed` on the host are the only paths that should mutate the index.

(qmd's `search` still writes to an internal LLM cache table during query expansion/reranking — benign and bounded, not an index mutation.)

## Runtime support: Bun **and** Node

The package ships dual entry points via conditional exports:

```jsonc
{
  "exports": {
    ".": {
      "bun":     "./src/index.ts",  // Bun: load TS source directly
      "types":   "./dist/index.d.ts",
      "import":  "./dist/index.js",  // Node: load compiled JS
      "default": "./dist/index.js"
    }
  }
}
```

So:

- **Bun hosts** (e.g. `pi-discord-bot`, `pi-telegram-bot`): pick up the `bun` condition and read `src/` directly — no rebuild after edits.
- **Node hosts** (e.g. `pi-mom`, anything compiled with `tsgo` / `tsc`): load `dist/index.js` + `dist/index.d.ts`.

If you `file:`-link this package from a Node host, run `bun run build` (or `npm run build`) here first so `dist/` exists.

## Develop

```bash
bun install
bun test         # 16 pass
bun run typecheck
bun run build    # emit dist/ for Node consumers
```

The build uses `tsc` with `rewriteRelativeImportExtensions: true`, so source files keep their `.ts` import suffixes (Bun-friendly) and the emitted JS gets `.js` automatically.

## Writing your own pi-agent tool plugin

This package is essentially a worked example of the pattern. The recipe:

1. Each tool is a value of type `AgentTool<TSchema>` from `@mariozechner/pi-agent-core` — `{ name, label, description, parameters, execute }`.
2. Define `parameters` with `typebox` (`Type.Object({ … })`).
3. Return `{ content: [{ type: "text", text }], details: {…} }` from `execute` — `content` is what the model sees, `details` is structured payload for the host UI.
4. Export factory functions (`createXxxTool(deps, options)`) rather than singletons, so the host can wire in its own dependencies (DB handles, API clients, etc.) and configuration.
5. Set up the same `exports` shape above if you want both Bun and Node hosts to consume your package.

That's it — drop the resulting `AgentTool[]` into the host's `tools` array and you're done.
