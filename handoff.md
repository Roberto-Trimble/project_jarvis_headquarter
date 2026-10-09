# Handoff

Entry point for a fresh session. Read `AGENTS.md`, this file, then `docs/PROJECT_JARVIS.md`
only for the section you need.

**Written:** 2026-10-08

## Where things stand

Repo scaffolded from the dexter-hq operating model. Nothing is deployed, nothing is
connected to Studio, Azure Boards, or GitHub yet.

Working and tested offline (`npm test`: 20 passing; `npm run typecheck` clean):
- Jarvis tools at `/mcp` (budget, shortcuts, story state, approval-gated merge), per-agent bearer
  tokens, per-role tool lists, audit log. Agents reach Azure Boards and GitHub through MCP servers
  registered in Studio, not through this service (see `docs/STUDIO_ANSWERS.md`).
- STOP ALL (local stop flag first, then cancel Studio runs and Jarvis CI runs); verified that
  tools refuse and new stories can't start, even when Studio is unreachable.
- Triggers: Azure Boards "work item updated" (tag added, deduped, one active run per story),
  GitHub `workflow_run` webhook with HMAC check, resuming runs waiting on `wait_for_ci`.
- Approvals (`sketch`, `budget`, `release`, `skill`) that suspend and resume runs; merge refused
  without an approved release and green CI.
- Shortcut Board: intake rules (secrets, verification bypass, directives, scope), posted →
  verified by a second agent → reused → retired, expiry housekeeping.
- Token Police via AgentBrake adapter: `admit_run` / `settle_run`, activity receipts, reuse scan.
- Command board at `/` (stories, runs, approvals, shortcuts, skill proposals, audit, chat, STOP ALL).

Runs on fakes for Studio, AgentBrake, and Azure Boards/GitHub unless the env vars in
`.env.example` are set.

## Next build steps

1. Register the Azure DevOps and GitHub MCP servers in Studio's Tool Registry with the per-agent
   allowlists in `studio/README.md`. No agent gets `merge_pull_request`.
2. `RestGateway` in `src/gateway.ts`: the service's own small set of REST calls (read story, CI
   status, merge after approval, cancel CI, comment on story).
3. From the `/api/agents` OpenAPI spec, replace the `TODO(confirm)` paths in `src/studio.ts` (cancel
   is a `cancel` query param; usage is on the run payload). Build the watcher that finds
   `RUN_FINISHED.awaitedToolCallIds` (AG-UI stream or polling) and routes them to `onLocalToolCall`
   (today reachable via `POST /api/runs/:id/local-tool`). Check whether the `halted` status fits `wait_for_ci`.
4. Ingest verified shortcuts into the Shortcuts Knowledge Library (one job per post, stable ID);
   remove the document on retire. Hook point: `verify_shortcut` in `src/tools.ts`.
5. Skills: AgentBrake `reuse-draft` → skill proposal card → owner approval → install with hash
   check → `list_skills` / `run_skill`. Both tools are stubs today.
6. Replace the board chat with the Trimble Assist framework component (https://developer.ai.trimble.com/docs/build/iframe-embedding/framework-components).
7. Create the Studio agents from `studio/agents/`, set per-agent quotas, attach Knowledge Libraries.

## Open owner decisions / still to confirm

- Exact runs list, cancel, and submit-tool-result routes (/api/agents OpenAPI spec).
- Where the Jarvis service is hosted inside Trimble, reachable by Azure DevOps service hooks and
  GitHub webhooks.
- Credentials: Azure DevOps PAT or service principal for work items; GitHub fine-grained token or
  GitHub App for the target repo.
- Permission for the service hook, the GitHub webhook, and the Azure Boards app for GitHub.
- The product repo and Azure DevOps project for the demo stories.
- Model per role in `config/role-sheet.yaml` (families set, exact models TBD).

## Local environment notes

- This laptop has Node 20 and no Python. SQLite runs through sql.js (WASM) because
  better-sqlite3 can't build here. AgentBrake (Python 3.10+) runs as a CLI only where Python
  is installed; set `AGENTBRAKE_BIN` and `AGENTBRAKE_HOME`. Otherwise the in-memory `FakeBrake` is used.
