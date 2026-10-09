# Studio agents

Five agents. Only the Project Manager calls subagents; the other four are its subagents.
Each file in `agents/` is the system prompt to paste into Studio. Models: `config/role-sheet.yaml`.
The Builder is one Studio agent that the PM runs as several parallel instances (at most three at
once); Jarvis tells the instances apart by the `instanceId` from `claim_task`.

| # | Agent | Prompt | Subagent of | Create order |
| --- | --- | --- | --- | --- |
| 1 | Jarvis PM | `agents/project-manager.md` | — (you chat with it) | 5th, so the others exist to attach |
| 2 | Jarvis Planner | `agents/planner.md` | PM | 3rd |
| 3 | Jarvis Builder | `agents/builder.md` | PM | 1st |
| 4 | Jarvis Verifier | `agents/verifier.md` | PM | 2nd |
| 5 | Jarvis Curator | `agents/curator.md` | PM | 4th |

`agents/designer.md` is for later, when an issue needs a new screen.

## Tools per agent

**GitHub connector** (Studio's built-in connection). Allow only:

| Agent | GitHub tools |
| --- | --- |
| PM | read issue, comment on issue, read PR, read CI / workflow runs |
| Planner | read issue, read file contents, search code |
| Builder | read issue, read file contents, create branch, create or update file / push files, create PR |
| Verifier | read PR, list PR files, read CI / workflow runs |
| Curator | none |

Builders write to GitHub only through this connector. The Jarvis service's own GitHub calls
(CI status, merge after release approval, cancel CI on STOP ALL) live in `src/gateway.ts`.

**No agent gets merge.** Merging goes through the Jarvis `merge_pull_request` tool, which refuses
until you approve the release on the board and CI is green.

**Jarvis tools** (the message board and Token Police) come from the Jarvis service's MCP
endpoint. Studio's custom MCP form can't set an `Authorization` header, so register each agent's
tool with the URL `https://<host>/mcp/<that agent's token>` and no authentication. Clients that can
send headers may use `/mcp` with `Authorization: Bearer <token>` instead; a path token wins over
any header. The URL is a secret: keep it out of logs, screenshots, and chat. The service decides who called from the token,
so each agent needs its own token (`JARVIS_AGENT_TOKENS=project-manager:…,planner:…,builder:…,verifier:…,curator:…`).
All builder instances share the `builder` token.

| Jarvis tool | PM | Planner | Builder | Verifier | Curator |
| --- | --- | --- | --- | --- | --- |
| `open_story`, `admit_run`, `settle_run`, `update_story_state`, `merge_pull_request`, `complete_story` | ✓ | | | | |
| `get_story_state`, `get_usage`, `get_generation_metrics` | ✓ | ✓ | ✓ | ✓ | ✓ |
| Message board: `search_shortcuts`, `post_shortcut`, `list_unverified_shortcuts`, `verify_shortcut`, `use_shortcut` | ✓ | ✓ | ✓¹ | ✓ | ✓ |
| `record_activity` | ✓ | ✓ | ✓¹ | ✓ | ✓ |
| `claim_task`, `report_pr` | | | ✓ | | |
| `get_profile` | ✓ | | ✓ | | ✓ |
| `propose_profile` | ✓ | | | | ✓ |

¹ Builders must pass their `instanceId`; posts are attributed to the instance.

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

1. Builder alone: open a story and call `admit_run` (role `builder`) as the PM, then give the Builder
   the `storyId`, `builder-gen0`, and the `reservationId`: "Add a line to README and open a PR."
   Check that the PR body has `AB#`, `profileId`, and `instanceId`, then close it.
2. Verifier alone, on that PR.
3. Planner alone, on a real issue.
4. PM end to end on one small issue labeled `jarvis`.
