# Result: Jarvis MCP service deployed to Azure

**Written:** 2026-10-09 · Follows `2026-10-09-azure-deploy.md` (the handoff itself lives outside the repo).

## Where it runs
| | |
| --- | --- |
| Subscription | Prism - Development (`03a3b2a3-0738-43b7-b73b-88384c1703d5`) |
| Resource group | `prism-develop` |
| Region | West US 3 (inherited from the existing plan) |
| App | `jarvis-mcp-hackathon`, Linux, `NODE|22-lts`, Always On, HTTPS only, startup `npm start` |
| Plan | `ASP-prismdevelop-9b6c`, B1, 1 instance, shared with the `jarvis-project` app (Jarvis CRM) |
| MCP URL | `https://jarvis-mcp-hackathon.azurewebsites.net/mcp` |
| Board | `https://jarvis-mcp-hackathon.azurewebsites.net/` |
| Deployed code | `origin/main` at `41a0759` (merge of PR #1, `builder-swarm`) |

App settings: `JARVIS_BOARD_TOKEN`, `JARVIS_AGENT_TOKENS` (project-manager, builder, verifier, curator,
planner, designer, researcher), `JARVIS_DATA_DIR=/home/data`, `SCM_DO_BUILD_DURING_DEPLOYMENT=true`,
`WEBSITES_ENABLE_APP_SERVICE_STORAGE=true`. Tokens were generated once; never regenerate them.

## Differences from the handoff
- The owner pointed to the existing `prism-develop` group. Its app `jarvis-project` runs a different
  app (Jarvis CRM, MongoDB), so this service got its own app on the same plan instead of replacing it.
  `jarvis-mcp` was taken; `jarvis-mcp-hackathon` is the owner's choice.
- `swarm-generations` never existed; the swarm work was merged to `main`, so `main` was deployed and
  this file is committed on `jarvis/azure-deploy-result`.
- Tokens were generated with .NET `RNGCryptoServiceProvider` (32 bytes, hex), since openssl isn't installed.
- `researcher` has a token but no prompt in `studio/agents/` yet.

## Read the tokens (prints secrets to your terminal)
```powershell
az webapp config appsettings list --subscription 03a3b2a3-0738-43b7-b73b-88384c1703d5 -g prism-develop -n jarvis-mcp-hackathon --query "[?name=='JARVIS_AGENT_TOKENS' || name=='JARVIS_BOARD_TOKEN'].{name:name,value:value}" -o table
```

## Redeploy (PowerShell, from a clean worktree of the branch to deploy)
```powershell
$zip = "$env:TEMP\jarvis-deploy.zip"; Remove-Item $zip -ErrorAction SilentlyContinue
tar.exe -a -c -f $zip --exclude=./node_modules --exclude=./data --exclude=./.git --exclude=.env --exclude=".env.*" --exclude="*.sqlite" .
az webapp deploy --subscription 03a3b2a3-0738-43b7-b73b-88384c1703d5 -g prism-develop -n jarvis-mcp-hackathon --src-path $zip --type zip
```
Don't run `scripts/deploy-azure.sh` against this app: it would create its own plan and group names.

## Verified (evidence in `.agent-work/evidence/2026-10-09-azure-deploy-*.txt`)
- `/healthz` returns `{"ok":true,"stopped":false}`.
- MCP `initialize` and `tools/list` with the builder token: 16 tools, including `get_profile` and
  `claim_task`, not `merge_pull_request`. No token and a wrong token both get 401.
- `get_profile builder-gen0` returns the seeded profile.
- After `az webapp restart` (new container confirmed in platform logs), `builder-gen0` exists once and
  the seed audit row from the first start (19:03:00Z) is still there, so `/home/data` persists.
- Board owner endpoints (`GET /api/state`, `POST /api/stop`, `POST /api/resume`) return 401 without
  the board token or with a wrong one.

## Not verified / open
- The first `az webapp deploy` reported a 10-minute start timeout: the container restarted for the
  settings change before code existed. The build succeeded and the site came up; later deploys
  shouldn't hit this.
- Not exercised on Azure: Studio, AgentBrake, GitHub and Azure Boards integrations (no env vars set,
  so the service runs on fakes), webhooks, and agents registered in Studio.
- The plan is shared with Jarvis CRM; both apps share B1's CPU and memory.
