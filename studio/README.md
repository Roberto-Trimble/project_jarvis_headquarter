# Studio agents

Four agents. Only the Project Manager calls subagents; the other three are its subagents.
Each file in `agents/` is the system prompt to paste into Studio. Models: `config/role-sheet.yaml`.

| # | Agent | Prompt | Subagent of | Create order |
| --- | --- | --- | --- | --- |
| 1 | Jarvis PM | `agents/project-manager.md` | — (you chat with it) | 4th, so the others exist to attach |
| 2 | Jarvis Planner | `agents/planner.md` | PM | 3rd |
| 3 | Jarvis Builder | `agents/builder.md` | PM | 1st |
| 4 | Jarvis Verifier | `agents/verifier.md` | PM | 2nd |

`agents/designer.md` is for later, when an issue needs a new screen.

## Tools per agent

**GitHub connector** (Studio's built-in connection). Allow only:

| Agent | GitHub tools |
| --- | --- |
| PM | read issue, comment on issue, read PR, read CI / workflow runs |
| Planner | read issue, read file contents, search code |
| Builder | read issue, read file contents, create branch, create or update file / push files, create PR |
| Verifier | read PR, list PR files, read CI / workflow runs |

**No agent gets merge.** You review and merge the PR yourself.

**Jarvis tools** (the message board and Token Police) come from the Jarvis service's `/mcp`
endpoint, registered in Studio as an `MCP` tool with a custom header
`Authorization: Bearer <that agent's token>`. The service decides who called from the token,
so each agent needs its own token (`JARVIS_AGENT_TOKENS=project-manager:…,planner:…,builder:…,verifier:…`).

| Jarvis tool | PM | Planner | Builder | Verifier |
| --- | --- | --- | --- | --- |
| `open_story`, `admit_run`, `settle_run`, `update_story_state` | ✓ | | | |
| `get_story_state`, `get_usage` | ✓ | ✓ | ✓ | ✓ |
| Message board: `search_shortcuts`, `post_shortcut`, `list_unverified_shortcuts`, `verify_shortcut`, `use_shortcut` | ✓ | ✓ | ✓ | ✓ |
| `record_activity` | ✓ | ✓ | ✓ | ✓ |

**Prerequisite:** the Jarvis service must run at an HTTPS URL Studio can reach. Until it's
hosted, the agents work without the message board and the per-story budget; Studio's quotas
still apply.

## Token Police

Two layers:
1. **Studio usage quotas** (set on each agent in Studio): runs, input tokens, output tokens per user,
   over a time window. This is the hard ceiling. Set these before the first run.
2. **Per-story budget (AgentBrake, in the Jarvis service):** the PM calls `admit_run` before each
   subagent call. When the issue's budget is spent, it's denied and the PM stops and asks you.
   Spend per issue shows on the Jarvis board and through `get_usage`.

## Test plan

1. Builder alone: "Create branch jarvis/0-test, add a line to README, open a PR." Check the PR, then close it.
2. Verifier alone, on that PR.
3. Planner alone, on a real issue.
4. PM end to end on one small issue labeled `jarvis`.
