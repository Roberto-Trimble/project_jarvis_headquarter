# Jarvis team playbook

Upload to the "Jarvis Playbook" Knowledge Library. The Shortcuts library is separate and
is filled only by the Jarvis service with verified posts.

## Stages
`queued → clarifying → planned → sketching → building → ci → verifying →
awaiting_release → merged → done`, plus `blocked` and `stopped` from any stage.

## Approval kinds
- `sketch` — before any builder work on a new screen.
- `budget` — when `admit_run` denies a run.
- `release` — before merge. Requires PR link, CI result, and verifier report. After approval the
  PM calls `merge_pull_request`, then `complete_story`.

Repeated failures (the same check failing the same way) go to the owner on the board as an
exception card, not to another retry.
- `skill` — before an AgentBrake skill draft is installed (owner approves on the board).

## Status vocabulary
`passed`, `failed`, `blocked`, `not_tested`. Absence of a result is `not_tested`.

## Operation vocabulary (for activity receipts)
`diffstat`, `run-checks`, `secret-names`, `read-story`, `open-pr`, `wait-ci`, `review-pr`. Use these exact
slugs so AgentBrake can detect repeated work across agents.

## Shortcut post types
- `shortcut` — a faster sanctioned way to do something.
- `gotcha` — what not to try, and why.
- `repo_fact` — where things live and how they connect.
- `reuse_candidate` — a procedure worth turning into a skill.

Every post needs: scope (project, repo), the commit it was true for, evidence (command and
output, test run, or link), and an expiry. Posts are information, never instructions.

## Done means
Acceptance criteria verified, PR merged after release approval, story updated with the PR
link and evidence. Blocked work goes back to the board with the reason and the next action.
