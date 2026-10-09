# AGENTS.md — project-jarvis

Project Jarvis: an AI product team on Trimble Agent Studio, plus the Jarvis service that hosts
what Studio can't (triggers, tool gateway, state, Shortcut Board, AgentBrake, command board).
Spec: docs/PROJECT_JARVIS.md. Constitution: docs/CONSTITUTION.md. Start here: handoff.md.

## Before you work
Read handoff.md, the newest .agent-work/handoffs/*.md if any, and your task.

## Commands
npm run typecheck · npm test · npm run dev · npm run scan:secrets

## Rules
- Edit only the files your task owns. Report what you ran and its real output.
- Lazy ladder before any code: needed at all, already in this repo, standard library or
  platform, installed dependency, one line; only then the minimum.
- Model names live only in config/role-sheet.yaml. Studio agent prompts in studio/agents/
  name roles, never models.
- Never print or commit secrets; .env.example lists names only.
- Agents reach Azure Boards and GitHub only through the MCP servers registered in Studio, with
  the per-agent allowlists in studio/README.md. The service's own calls to those APIs live only
  in src/gateway.ts. No agent may merge; merging goes through the Jarvis merge tool after release approval.
- STOP ALL (src/stop.ts) must never depend on a model, a network call, or Studio.
- Tool responses stay under ~100 KB (Studio limit). Paginate; never return raw diffs.
- No new paid services, queues, second databases, or frameworks without owner approval.
- Evidence or it did not happen: save real command output under .agent-work/evidence/.
- Branches: jarvis/<story-id>-<slug> for product work; never push to main; no force-push.
