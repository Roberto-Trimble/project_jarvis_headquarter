# Project Jarvis

Jarvis is an AI product team for a single Trimble product, built on Trimble Agent Studio.
A Project Manager agent and three subagents turn GitHub issues into tested pull requests,
with an independent verifier, human approval for merges, Token Police for cost, and a
message board (Shortcut Board) so the team gets cheaper as it works.

Full design: [docs/PROJECT_JARVIS.md](docs/PROJECT_JARVIS.md). Ported from the
operating model of [dexter-hq](https://github.com/Roberto-Madrid/dexter-hq).

## Operating model

- **You (the owner)** set priorities, approve sketches, releases, budgets, and skills.
- **Project Manager** (Studio agent) is the only agent that assigns work. It dispatches
  role agents as subagents and never does the work itself.
- **Subagents** (planner, builder, verifier) do bounded work on one issue. A designer comes later, for new screens.
- **Jarvis service** (this repo) holds what Studio can't: triggers, local-tool results (approvals, CI waits),
  shared state, the Shortcut Board, AgentBrake, STOP ALL, and the command board. Agents reach
  Azure Boards and GitHub through MCP servers registered directly in Studio.

Roles are instructions, not running processes. A file in `studio/agents/` is not a
deployed agent until it is created in Studio and its run is observed.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `AGENTS.md` | Short identity, startup instructions, and rules for any agent working on this repo |
| `handoff.md` | Entry point for a fresh session: where things stand and open owner decisions |
| `docs/` | Design (`PROJECT_JARVIS.md`), `CONSTITUTION.md`, third-party notices |
| `studio/agents/` | System prompts for each Studio agent (PM, planner, builder, verifier) |
| `studio/knowledge/` | Team playbook for the PM's Knowledge Library |
| `config/role-sheet.yaml` | Model family per role, from Trimble's model gateway |
| `config/jarvis-policy.json` | Budgets, concurrency, retry limits (per-agent tool allowlists live in Studio, see `studio/README.md`) |
| `src/` | Jarvis service: Jarvis tools (MCP), webhooks, state, board API, STOP ALL |
| `public/` | Command board (static web app) |
| `test/` | Unit tests for the deterministic parts |
| `missions/` | One folder per story Jarvis has run: brief, decisions, evidence links |
| `.agent-work/` | Evidence and handoffs from agents building Jarvis itself |

## Run locally

```bash
npm install
npm test
npm run dev
```

The board is at http://localhost:8787, the MCP endpoint at `/mcp`. With no credentials
configured, the service runs against fakes for Studio, Azure Boards, GitHub, and AgentBrake,
so the whole loop can be demoed offline. See `.env.example` for the variables that switch
each adapter to the real service.

## Delivery loop

Story tagged `jarvis` → clarify → plan → sketch and approve (new screens only) → implement
on a branch → CI and verify (max 3 fix rounds) → you approve the release → Jarvis merges →
update story with evidence → capture shortcuts and reuse candidates.

## Boundaries

- Only tagged stories (or the board's "Run with Jarvis" button) start work.
- At most three concurrent subagent runs. No automatic paid fallback.
- Publishing and merging require human approval. New screens require sketch approval.
- Credentials stay in the Jarvis service. They never reach Studio, a prompt, or a model.
- STOP ALL works without any model.
