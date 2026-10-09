// Create the five Jarvis agents in Trimble Agent Studio with POST /v2/agents.
//
//   npx tsx scripts/create-agents.ts            dry run: prints what it would send
//   npx tsx scripts/create-agents.ts --apply    creates the agents
//
// Needs STUDIO_API_BASE plus either STUDIO_TOKEN (a TID bearer token with the `agents` scope) or
// TID_CLIENT_ID + TID_CLIENT_SECRET (client-credentials grant against TID_TOKEN_URL). Put them in .env:
//   node --env-file=.env --import tsx scripts/create-agents.ts [--apply]
// Models come from config/role-sheet.yaml (the only place model names live).
// Created agent IDs are saved to config/studio-agents.json; agents already listed there are skipped.
// Tools (GitHub connector allowlists, Jarvis MCP), subagents, and quotas are added afterwards in
// the Studio UI or via POST /v2/agents/{agentId}/configs (see studio/README.md).
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const AGENTS = [
  { key: "builder", name: "Jarvis Builder", prompt: "studio/agents/builder.md", roleKey: "builder",
    description: "Makes the planned change on a jarvis/ branch and opens a pull request. Subagent of Jarvis PM." },
  { key: "verifier", name: "Jarvis Verifier", prompt: "studio/agents/verifier.md", roleKey: "verifier",
    description: "Checks a pull request against the acceptance checks; read-only. Subagent of Jarvis PM." },
  { key: "planner", name: "Jarvis Planner", prompt: "studio/agents/planner.md", roleKey: "planner",
    description: "Researches the repo and turns a GitHub issue into a small, testable plan; read-only. Subagent of Jarvis PM." },
  { key: "curator", name: "Jarvis Curator", prompt: "studio/agents/curator.md", roleKey: "curator",
    description: "Distills verified board tips into the next builder profile for owner approval; read-only. Subagent of Jarvis PM." },
  { key: "project-manager", name: "Jarvis PM", prompt: "studio/agents/project-manager.md", roleKey: "project_manager",
    description: "Project manager for jarvis-tagged stories. Calls the Planner, Builder instances, Verifier, and Curator as subagents." },
];

const TEMPERATURE: Record<string, number> = { builder: 0.2, verifier: 0.1, planner: 0.3, curator: 0.2, project_manager: 0.3 };
const STATE_FILE = "config/studio-agents.json";

function modelFor(roleKey: string): string {
  const sheet = readFileSync("config/role-sheet.yaml", "utf8");
  const line = sheet.split("\n").find((l) => new RegExp(`^\\s*${roleKey}:\\s*\\{`).test(l));
  const model = line?.match(/model:\s*([^,}\s]+)/)?.[1];
  if (!model || model === "TBD") throw new Error(`Set the model for "${roleKey}" in config/role-sheet.yaml (currently ${model ?? "missing"}).`);
  return model;
}

function body(a: (typeof AGENTS)[number]) {
  return {
    name: a.name,
    description: a.description,
    configs: [{
      name: "default",
      description: `Initial config for ${a.name}`,
      systemPrompt: readFileSync(a.prompt, "utf8"),
      models: [{ name: modelFor(a.roleKey), temperature: TEMPERATURE[a.roleKey], maxOutputTokens: 4000 }],
    }],
  };
}

async function getToken(): Promise<string> {
  if (process.env.STUDIO_TOKEN) return process.env.STUDIO_TOKEN;
  const id = process.env.TID_CLIENT_ID;
  const clientKey = process.env.TID_CLIENT_SECRET;
  if (!id || !clientKey) throw new Error("Set STUDIO_TOKEN, or TID_CLIENT_ID and TID_CLIENT_SECRET, in .env.");
  const url = process.env.TID_TOKEN_URL || "https://stage.id.trimblecloud.com/oauth/token";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${id}:${clientKey}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: "openid agents" }),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) throw new Error(`TID token request failed: ${res.status} ${json.error ?? ""} ${json.error_description ?? ""}`);
  return json.access_token; // never printed
}

async function main() {
  const apply = process.argv.includes("--apply");
  const state: Record<string, string> = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
  const base = process.env.STUDIO_API_BASE?.replace(/\/$/, "");
  let token: string | undefined;

  for (const a of AGENTS) {
    if (state[a.key]) {
      console.log(`skip  ${a.name}: already created (${state[a.key]})`);
      continue;
    }
    const payload = body(a);
    if (!apply) {
      console.log(`would create ${a.name}: model ${payload.configs[0].models[0].name}, prompt ${payload.configs[0].systemPrompt.length} chars`);
      continue;
    }
    if (!base) throw new Error("Set STUDIO_API_BASE in .env first.");
    token ??= await getToken();
    const res = await fetch(`${base}/v2/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`create ${a.name} failed: ${res.status} ${text.slice(0, 500)}`);
    const id = JSON.parse(text).id ?? JSON.parse(text).agentId;
    if (!id) throw new Error(`create ${a.name}: no id in response: ${text.slice(0, 300)}`);
    state[a.key] = String(id);
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n"); // save after each, so a rerun skips it
    console.log(`created ${a.name}: ${id}`);
  }
  if (!apply) console.log("\nDry run only. Re-run with --apply to create.");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
