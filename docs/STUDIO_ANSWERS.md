# Studio platform agent answers (2026-10-08)

Answers to `docs/STUDIO_PROMPT.md`, and what we decided from them. Where these conflict with the
"tool gateway" parts of `PROJECT_JARVIS.md`, this file wins.

| # | Question | Native? | Answer | Decision |
| --- | --- | --- | --- | --- |
| 1 | Azure Boards / GitHub tools | Partial | No built-in connectors. Register MCP servers in the Tool Registry (`MCPRegistry` tool) or as a plain `MCP` tool; or upload an OpenAPI spec and the registry turns it into tools. Auth: static PAT (`authConfig.provider=static`) or third-party OAuth via TID Token Vault (user-delegated, not app identity). Per-agent tool allowlists: `toolDefaults.allowed:false` plus explicit allows. | **We don't host the MCP servers.** Register them in Studio with a PAT / GitHub App token and per-agent allowlists (see `studio/README.md`). No agent gets `merge_pull_request`; merge stays a Jarvis tool gated by release approval. |
| 2 | Start a run from a webhook | No | Companion service receives the hook and calls the run endpoint on `/api/agents`. | Keep `src/triggers.ts`. |
| 3 | Human approval | Partial | A local (client-side) tool suspends the run with no token spend until a result is submitted. `RUN_FINISHED.awaitedToolCallIds` lists pending calls. Detect via the AG-UI event stream or by polling run status. | Keep `request_approval` as a local tool. Build a watcher that finds awaited calls and routes them to `onLocalToolCall`. |
| 4 | Wait on CI | Partial | Same local-tool suspension. A newer `halted` run status may suit external waits; check the spec. | Keep `wait_for_ci` as a local tool; check `halted` in the spec. |
| 5 | Runs API | Yes | Plain REST. Cancel is a `cancel` query param on the run endpoint; the run payload has `usage` (input/output tokens). List-runs path: confirm in `/api/agents` spec. | Update `src/studio.ts` paths from the OpenAPI spec. |
| 6 | Per-story budget | No | Quotas are per user per agent only. Keep your own ledger. | Keep AgentBrake (`src/brake.ts`). |
| 7 | Embed Assist chat | Yes | Framework components (React/Angular/Vue); iframe as fallback. https://developer.ai.trimble.com/docs/build/iframe-embedding/framework-components | Replace the board's chat box with the component. |

## Smallest companion service (their recommendation, which we follow)

1. Receive Azure Boards and GitHub webhooks and start or resume the PM run.
2. Watch for suspended local-tool calls (approval, CI wait) and submit results.
3. Keep the per-story usage ledger.

Plus what only we can enforce: the Shortcut Board rules, STOP ALL, and merge-only-after-approval.

## Consequence for STOP ALL

Agents now call GitHub and Azure DevOps directly through Studio, so blocking Jarvis tools no
longer blocks those calls. STOP ALL relies on cancelling every run through the runs API (layer 1)
and cancelling CI (layer 3). The Jarvis-tool block (layer 2) still stops budget admission,
shortcuts, and merges.

## Follow-up answers (2026-10-08)

| # | Question | Native? | Answer | Decision |
| --- | --- | --- | --- | --- |
| 8 | Durable store agents can read and write | No | Only `run.context` (per run, read via the built-in `get_run_context` tool) and per-thread history. Not shared and not for sensitive data. | Story state and the Shortcut Board stay in the Jarvis service's SQLite, exposed as Jarvis tools. Pass `storyId` in `run.context`. |
| 9 | Agent writes a Knowledge Library document | No | Only through the Knowledge Service API/SDK (`sdk.knowledge.createDocument`, etc.), unless we expose those endpoints as a tool. | The service ingests verified shortcuts itself. Agents never write to the library directly, so unverified posts can't reach it. |
| 10 | Scheduled runs | No | All runs start via `POST /agents/{agentId}/executions`. | The service owns housekeeping (shortcut expiry, reuse scan). |
| 11 | Cancel-all in the Studio UI | No | The OPERATE tab has usage, traces, and quota-violation dashboards, but no bulk cancel. Cancel is a `cancel` query param on the run endpoint. | STOP ALL stays on the Jarvis board: list active runs, cancel each. |

**Conclusion:** Studio hosts and maintains the agents, tools, knowledge, and quotas. Triggers,
scheduling, shared state, Knowledge Library ingestion, the per-story ledger, approvals, and
STOP ALL all need the companion service. That matches the current `src/` design.

## Still open

- Exact routes for list runs, cancel, and resume (submit a local tool result) from the `/api/agents` OpenAPI spec.
- Whether to use the AG-UI stream or polling to detect awaited tool calls.
- The `halted` status contract.
