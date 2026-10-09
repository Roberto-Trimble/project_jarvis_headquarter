# Handoff

Entry point for a fresh session. Read `AGENTS.md`, this file, then `docs/PROJECT_JARVIS.md`
only for the section you need.

**Written:** 2026-10-09

## Where things stand

Nothing is deployed yet. The service is ready for Azure App Service (`scripts/deploy-azure.sh`,
the owner runs it). Not yet connected to Studio, Azure Boards, or GitHub.

**Design as of 2026-10-09:** the swarm is many parallel instances of one Studio Builder agent that
share the Shortcut Board. They improve across **generations**: the Curator distills verified posts
into a new builder **profile**, the owner approves it on the board, and the next builders load it.
Builders write to GitHub through Studio's own GitHub connector (it can open PRs), not through Jarvis.
n8n owns the webhook triggers and starts Project Manager runs; each event (story tagged, CI finished,
approval decided) is a fresh PM run that reads state from Jarvis. The Council is gone.

Working and tested offline (`npm test`: 35 passing; `npm run typecheck` clean; `npm run scan:secrets` clean):
- Jarvis tools at `/mcp` (budget, shortcuts, story state, approval-gated merge, swarm tools),
  per-agent bearer tokens, per-role tool lists, audit log.
- **Builder instances.** All builders share the `builder` token. `claim_task` turns an admitted
  reservation into an instance (`b-` + 6 hex) with branch `jarvis/<story>-<slug>-<instanceId>`.
  Builders must pass a live `instanceId` to `post_shortcut`, `verify_shortcut`, `use_shortcut`,
  `record_activity`, and `list_unverified_shortcuts` (refused with `instance_required` /
  `unknown_instance`). Authorship is the instance ID, so one instance can verify another's post
  but not its own. `report_pr` moves an instance to `pr_open`; a merge moves it to `done`.
- **Profiles and generations.** `builder-gen0` is seeded on startup (idempotent). `propose_profile`
  (curator, PM) accepts only verified tips and runs the instructions through the Shortcut Board
  intake rules, then puts a `profile` approval card on the board (instructions diffed against the
  parent, tips listed). `get_profile` serves only approved profiles and skips tips no longer verified.
- **Metrics.** `get_generation_metrics` and the board's Generations panel: instances, PRs opened,
  merged, CI runs and failures (from the GitHub `workflow_run` hook, matched on the instance's
  branch), failures per PR, tips used/posted/verified, median minutes from claim to first green CI.
  Unknown values are `null`. "Tips verified" counts posts by those instances that a second party verified.
- STOP ALL (local stop flag first, then cancel Studio runs and Jarvis CI runs).
- Approvals (`sketch`, `budget`, `release`, `skill`, `profile`). Merge refused without an approved
  release and green CI. Profile cards come only from `propose_profile`, never from the local tool.
- `GET /healthz` → `{ ok, stopped }`, no auth.
- Command board at `/`.

Runs on fakes for Studio, AgentBrake, and Azure Boards/GitHub unless the env vars in
`.env.example` are set.

Prompts (`studio/agents/`): the Builder is the swarm builder (`get_profile` → `claim_task` →
connector branch and PR with `AB#`, `profileId`, `instanceId` → `report_pr`; tips verified by CI
runs). New `curator.md`. The PM admits each builder run and passes `storyId`, `profileId`,
`reservationId`; at most three builders at once; one event per run; release approval, then
`merge_pull_request` and `complete_story`. `scripts/create-agents.ts` now creates the Curator too.

## Changes on 2026-10-09 (branch `builder-swarm`)

One commit per work item from the builder-swarm task, on top of a baseline commit of the scaffold
(the repo had no commits). Not pushed. Parts of the task that were already true and needed no change:
- No `studio/agents/council-*.md` files existed, and `config/role-sheet.yaml` had no `council` block
  or `council_excludes_builder_family` rule.
- `config/jarvis-policy.json` lists no GitHub tools, so there were no write tools to remove. Per-agent
  GitHub allowlists live in Studio (`studio/README.md`).
- `scan:secrets` failed before this work on `scripts/create-agents.ts` (`const secret = …` matched the
  key-value secret shape). The variable is renamed; the scan is clean.

**Owner decision:** `docs/CONSTITUTION.md` article 3 says every GitHub action goes through the Jarvis
tool gateway. Builders now write through Studio's GitHub connector, so article 3 no longer matches
the design. Agents may not edit that file.

Evidence: `.agent-work/evidence/2026-10-09-*` (baseline scan and tests; typecheck, tests, secret scan,
deploy script check and dry run, startup and board check).

## Deploy (owner)

`bash scripts/deploy-azure.sh [resource-group] [app-name] [region]` (defaults `jarvis-rg`,
`project-jarvis`, `westus2`). Needs `az login`, `openssl`, `zip`. Creates a Linux B1 plan with one
worker, a Node 22 web app with Always On and `npm start`, sets `JARVIS_DATA_DIR=/home/data` and
`SCM_DO_BUILD_DURING_DEPLOYMENT=true`, generates the board token and one MCP token per role on the
first run (kept on re-runs), zip-deploys without `node_modules`, `data`, `.git`, `.env*`, and prints
the board, health, and MCP URLs plus the command to read the tokens back. Only `bash -n` and a dry run
with stubbed `az`/`zip` were done here; it has not been run against Azure.

## Still unconfirmed

- **Studio Agents API endpoints:** runs list, cancel, and submit-tool-result routes
  (`TODO(confirm)` in `src/studio.ts`). Whether `halted` fits `wait_for_ci`.
- **n8n wiring:** n8n starts PM runs per event; how the PM's local tools (`request_approval`,
  `wait_for_ci`) and the GitHub `workflow_run` webhook (which feeds the per-instance CI counters at
  `/hooks/github`) are routed once n8n owns triggers is not built or tested.
- **AgentBrake on Azure:** the real AgentBrake needs Python 3.10+, which App Service's Node image
  doesn't have, so the deployed service runs the in-memory `FakeBrake` (budgets reset on restart).
  Real AgentBrake needs a container image with Python.
- Whether one App Service instance writing SQLite to `/home/data` (network storage) is fast enough.
- Model per role in `config/role-sheet.yaml` (curator family not chosen yet).

## Next build steps

1. Owner: run the deploy script; register `/mcp` in Studio with each agent's token.
2. `RestGateway` in `src/gateway.ts`: read story, CI status, merge after approval, cancel CI, comment.
3. Replace the `TODO(confirm)` paths in `src/studio.ts` from the `/api/agents` OpenAPI spec.
4. Ingest verified shortcuts into the Shortcuts Knowledge Library (hook point: `verify_shortcut`).
5. Skills: AgentBrake `reuse-draft` → skill card → approval → install; `list_skills` / `run_skill`
   are stubs. Approved skills are meant to ship in the next generation's profile (`skill_ids`).
6. Create the Studio agents from `studio/agents/` (now including the Curator).

## Local environment notes

- This laptop has Node 20 and no Python. SQLite runs through sql.js (WASM). AgentBrake runs as a CLI
  only where Python is installed (`AGENTBRAKE_BIN`, `AGENTBRAKE_HOME`); otherwise `FakeBrake`.
- `bash` here is WSL Ubuntu (has `openssl`, no `zip`, no `az`).
