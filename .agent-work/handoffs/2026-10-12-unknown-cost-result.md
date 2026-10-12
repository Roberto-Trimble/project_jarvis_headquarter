# Result: unknown run cost no longer blocks a story

**Written:** 2026-10-12 · Follows `2026-10-12-unknown-cost-blocks-swarm.md`.

## Change (owner approved)
`FakeBrake` (`src/brake.ts`): the `unknown_task_cost` HOLD is gone. `settle` stores the reservation's
estimate with each usage entry, and `admit` sums `cost ?? estimate`, so an unknown-cost run is charged
at its estimate and the story cap still applies. `spent()` is unchanged: it still reports measured
spend only, plus `unknownRuns`, so `get_usage` and the board show that costs are unmeasured.

Tests (`test/loop.test.ts`, "Token Police"): a run settled with unknown cost doesn't block the next
`admit_run`; with cap 300000 and estimate 150000, one unknown-cost run plus one more is allowed and a
third is refused with `budget`. Both fail on the old code.

Checks: typecheck exit 0, 48/48 tests, `scan:secrets ok` (`.agent-work/evidence/2026-10-12-fakebrake-unknown-cost-checks.txt`).

## CliBrake (real AgentBrake)
`CliBrake.admit` passes straight to `agentbrake reserve`; `settle` sends `cost_microusd: null` with
`cost_source: "unknown"`. Whether `reserve` then holds with `unknown_task_cost` is decided inside
AgentBrake, which isn't installed here and isn't in this repo, so it's unconfirmed. `FakeBrake`'s doc
says it mirrors AgentBrake's reserve/settle semantics, so assume it does. Not changed: the fix there
is not the same few lines (it would mean settling with the estimate as the cost, which misstates
`cost_source`, or an AgentBrake option). Revisit when the deployed app runs real AgentBrake.

## Deploy
Zip deploy of this branch to `jarvis-mcp-hackathon` (`prism-develop`, subscription
`03a3b2a3-0738-43b7-b73b-88384c1703d5`), same command as `2026-10-09-azure-deploy-result.md`.
`scripts/deploy-azure.sh` was not used: even with these names it runs `az appservice plan create` for a
new `jarvis-mcp-hackathon-plan` (a second B1), and it needs `zip`, which this machine lacks.
App settings and tokens were not touched. After deploy: `/healthz` `{"ok":true,"stopped":false}`;
story 1234 still `blocked` in SQLite; FakeBrake's ledger is empty (restart).
Evidence: `.agent-work/evidence/2026-10-12-fakebrake-unknown-cost-deploy.txt`.

## For the owner
- **Scope mismatch:** the app has `GITHUB_REPO=Roberto-Trimble/project_jarvis_headquarter` (set 2026-10-09),
  but story 1234 targets `salvador-ram-trimble/jarvis_project`. Shortcut posts must match the scope
  exactly, so posts for this story would be refused `out_of_scope`. Set `GITHUB_REPO` to the target repo
  (restarts the app and clears FakeBrake's ledger again) or delete the setting (the default is
  `salvador-ram-trimble/jarvis_project`).
- **Story 1234 is still `blocked`.** The next PM run reads that stage; the run message should say the
  block is cleared so the PM moves the story back to `planned` with `update_story_state` and admits the builder.
- **`request_approval` (and `wait_for_ci`):** add both to the PM's Studio config as local (client-side)
  tools. `request_approval` takes `kind` (`sketch`, `budget`, `release`, `skill`), `summary`, `links`;
  `wait_for_ci` takes `prNumber`. Something must also route the suspended calls to Jarvis: the bridge
  `POST /api/runs/:id/local-tool` (board token) exists, but it needs a Jarvis run row (created by
  `startStory`), and the watcher that finds awaited calls isn't built (`docs/STUDIO_ANSWERS.md` rows
  3-4). Until then, release approval and merge can't happen through the PM.
- **PM token visible in Studio:** rotate it. Anyone with access to the thread or config has seen it.
  Rotation means replacing the `project-manager:` entry in `JARVIS_AGENT_TOKENS` and updating the PM's
  MCP URL in Studio at the same time; the other roles' tokens can stay. Do it after this run, and keep
  thread and config access to the team.
- **Content filter:** start PM runs with plain event messages (what `startStory` builds), not
  instructions to the agent.
- **Turn limits:** raise PM to at least 100 and Builder to at least 60 in Studio; 25 will cut runs short.
- **FakeGateway** knows only story 101, so `POST /api/stories/<id>/run` fails for other IDs. Not fixed:
  making it accept any ID means inventing story text. The real fix is `RestGateway` (Azure Boards).
