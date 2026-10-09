import { FakeBrake } from "../src/brake.ts";
import { openDb } from "../src/db.ts";
import { loadPolicy, type Deps } from "../src/deps.ts";
import { FakeGateway } from "../src/gateway.ts";
import { FakeStudio } from "../src/studio.ts";

export async function setup() {
  const db = await openDb(":memory:");
  const studio = new FakeStudio();
  const gateway = new FakeGateway();
  const brake = new FakeBrake();
  const deps: Deps = {
    policy: loadPolicy(),
    studio, gateway, brake,
    scope: { project: "demo-project", repo: "demo-org/demo-repo" },
    agentTokens: new Map([["pm-token", "project-manager"], ["builder-token", "builder"], ["verifier-token", "verifier"]]),
    boardToken: null,
    hookSecrets: { azdoUser: "hook", azdoPassword: "pw", github: "gh-secret" },
  };
  return { db, deps, studio, gateway, brake };
}

export const SHA = "abc1234";
