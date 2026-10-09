#!/usr/bin/env bash
# Deploy the Jarvis service to Azure App Service (Linux, Node 22, B1, one instance, Always On).
#
#   scripts/deploy-azure.sh [resource-group] [app-name] [region]
#
# Needs: az (signed in with `az login`), openssl, zip. Run from anywhere; it deploys this repo.
# One instance only: the SQLite file in /home/data is written by a single process.
# Tokens are generated once and kept on re-runs, so Studio's registered tokens stay valid.
# Token values are never printed; the script prints the command to read them back.
set -euo pipefail

RG="${1:-jarvis-rg}"
APP="${2:-project-jarvis}"
REGION="${3:-westus2}"
PLAN="${APP}-plan"

for bin in az openssl zip; do
  command -v "$bin" >/dev/null || { echo "missing: $bin" >&2; exit 1; }
done
cd "$(dirname "$0")/.."

echo "Resource group $RG, app $APP, region $REGION"
az group create --name "$RG" --location "$REGION" -o none
az appservice plan create --resource-group "$RG" --name "$PLAN" --is-linux --sku B1 --number-of-workers 1 -o none
if ! az webapp show --resource-group "$RG" --name "$APP" -o none 2>/dev/null; then
  az webapp create --resource-group "$RG" --plan "$PLAN" --name "$APP" --runtime "NODE:22-lts" -o none
fi
az webapp config set --resource-group "$RG" --name "$APP" --always-on true --startup-file "npm start" -o none

# Roles that get an MCP token: the fixed set plus every prompt in studio/agents/.
roles="project-manager builder verifier curator"
for f in studio/agents/*.md; do roles="$roles $(basename "$f" .md)"; done
roles="$(tr ' ' '\n' <<<"$roles" | sort -u | xargs)"

existing="$(az webapp config appsettings list --resource-group "$RG" --name "$APP" --query "[].name" -o tsv)"
has() { grep -qx "$1" <<<"$existing"; }

umask 077
settings="$(mktemp)"
zipfile="$(mktemp -u).zip"
trap 'rm -f "$settings" "$zipfile"' EXIT

{
  echo "{"
  if ! has JARVIS_BOARD_TOKEN; then
    echo "  \"JARVIS_BOARD_TOKEN\": \"$(openssl rand -hex 32)\","
  fi
  if ! has JARVIS_AGENT_TOKENS; then
    pairs=""
    for r in $roles; do pairs="${pairs:+$pairs,}$r:$(openssl rand -hex 32)"; done
    echo "  \"JARVIS_AGENT_TOKENS\": \"$pairs\","
  fi
  echo '  "JARVIS_DATA_DIR": "/home/data",'
  echo '  "SCM_DO_BUILD_DURING_DEPLOYMENT": "true",'
  echo '  "WEBSITES_ENABLE_APP_SERVICE_STORAGE": "true"'
  echo "}"
} >"$settings"
az webapp config appsettings set --resource-group "$RG" --name "$APP" --settings "@$settings" -o none
has JARVIS_AGENT_TOKENS && echo "Kept existing tokens." || echo "Generated tokens for: $roles"

zip -qr "$zipfile" . -x "node_modules/*" "data/*" ".git/*" ".env" ".env.*" "*.sqlite" "*.sqlite-*"
az webapp deploy --resource-group "$RG" --name "$APP" --src-path "$zipfile" --type zip -o none

host="$(az webapp show --resource-group "$RG" --name "$APP" --query defaultHostName -o tsv)"
cat <<EOF

Deployed.
  Board:   https://$host/
  Health:  https://$host/healthz
  MCP URL: https://$host/mcp   (register in Studio with header Authorization: Bearer <that agent's token>)

Read the tokens back (prints secrets to your terminal):
  az webapp config appsettings list -g "$RG" -n "$APP" --query "[?name=='JARVIS_AGENT_TOKENS'].value" -o tsv
  az webapp config appsettings list -g "$RG" -n "$APP" --query "[?name=='JARVIS_BOARD_TOKEN'].value" -o tsv
EOF
