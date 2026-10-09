# Prompt for the Trimble Agent Studio platform agent

Paste the block below. If it's still too long, send the questions one at a time.
Save the answers in `docs/STUDIO_ANSWERS.md`.

```
I'm building a Studio agent team: a Project Manager agent takes an Azure Boards story, calls subagents (planner, builder, verifier, reviewers), opens a GitHub PR, and a human approves before merge. I want Studio to do as much as possible. For each item: is it native, and what's the simplest way (with doc link)?

1. Built-in Azure Boards and GitHub tools, or can I register their hosted MCP servers directly? Which auth?
2. Start a run from an Azure DevOps service hook or GitHub webhook.
3. Human approval that pauses a run until approved.
4. Pause a run while GitHub CI runs, then resume.
5. Endpoints to list, cancel, and read token usage of runs.
6. Token/cost budget per story, not just per agent.
7. Embed the Trimble Assist chat for my agent in my own web page.

What's the minimum I'd still need to build outside Studio?
```
