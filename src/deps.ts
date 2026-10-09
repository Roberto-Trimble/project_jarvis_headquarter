import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CliBrake, FakeBrake, type Brake } from "./brake.ts";
import { FakeGateway, type Gateway } from "./gateway.ts";
import { FakeStudio, HttpStudio, type Studio } from "./studio.ts";

export type Policy = {
  trigger_tag: string;
  concurrency: { max_subagent_runs: number; max_active_stories: number };
  retries: { max_fix_rounds: number; repeated_failure_threshold: number };
  budgets: { default_story_cap_microusd: number; default_run_estimate_microusd: number };
  tool_response_max_bytes: number;
  shortcuts: { default_expiry_days: number };
  reuse: { minimum_successes: number; minimum_distinct_agents: number };
};

export type Deps = {
  policy: Policy;
  studio: Studio;
  gateway: Gateway;
  brake: Brake;
  scope: { project: string; repo: string };
  /** token -> agent name, for Studio agents calling the MCP endpoint */
  agentTokens: Map<string, string>;
  boardToken: string | null;
  hookSecrets: { azdoUser: string | null; azdoPassword: string | null; github: string | null };
};

export function loadPolicy(root = process.cwd()): Policy {
  return JSON.parse(readFileSync(join(root, "config", "jarvis-policy.json"), "utf8"));
}

function parseTokens(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf(":");
    if (i > 0) map.set(pair.slice(i + 1), pair.slice(0, i));
  }
  return map;
}

export function depsFromEnv(env = process.env): Deps {
  const studio = env.STUDIO_API_BASE && env.STUDIO_API_KEY && env.STUDIO_PM_AGENT_ID
    ? new HttpStudio(env.STUDIO_API_BASE, env.STUDIO_API_KEY, env.STUDIO_PM_AGENT_ID)
    : new FakeStudio();
  const brake = env.AGENTBRAKE_BIN && env.AGENTBRAKE_HOME ? new CliBrake(env.AGENTBRAKE_BIN, env.AGENTBRAKE_HOME) : new FakeBrake();
  // TODO: RestGateway (Azure DevOps + GitHub REST) once credentials are issued.
  const gateway: Gateway = new FakeGateway();
  return {
    policy: loadPolicy(),
    studio,
    gateway,
    brake,
    scope: { project: env.JARVIS_PROJECT || "jarvis", repo: env.GITHUB_REPO || "salvador-ram-trimble/jarvis_project" },
    agentTokens: parseTokens(env.JARVIS_AGENT_TOKENS),
    boardToken: env.JARVIS_BOARD_TOKEN || null,
    hookSecrets: {
      azdoUser: env.AZDO_HOOK_USER || null,
      azdoPassword: env.AZDO_HOOK_PASSWORD || null,
      github: env.GITHUB_WEBHOOK_SECRET || null,
    },
  };
}
