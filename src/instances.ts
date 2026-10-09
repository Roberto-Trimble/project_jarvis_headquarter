import type { DB } from "./db.ts";
import type { Outcome } from "./shortcuts.ts";

// Every builder instance shares one Studio agent and one bearer token, so the token says "builder"
// and the instance ID, issued by claim_task, says which one.

export const INSTANCE_STATUSES = ["active", "pr_open", "done", "abandoned"] as const;
export type InstanceStatus = (typeof INSTANCE_STATUSES)[number];
export const INSTANCE_ID = /^b-[0-9a-f]{6}$/;

export type InstanceRow = {
  id: string; story_id: string; profile_id: string; agent: string; reservation_id: string; branch: string;
  pr_url: string | null; pr_number: number | null; status: InstanceStatus; ci_runs: number; ci_failures: number;
  first_green: string | null; created: string; finished: string | null;
};

export function getInstance(db: DB, id: string): InstanceRow | null {
  return (db.prepare("SELECT * FROM instances WHERE id = ?").get(id) as InstanceRow | undefined) ?? null;
}

/** Who a board action is attributed to: the instance ID for builders, the agent name for everyone else. */
export function resolveActor(db: DB, agent: string, instanceId?: string): Outcome<string> {
  if (agent !== "builder") return { ok: true, value: agent };
  if (!instanceId) return { ok: false, reason: "instance_required" };
  const inst = getInstance(db, instanceId);
  if (!inst || inst.agent !== agent || (inst.status !== "active" && inst.status !== "pr_open")) return { ok: false, reason: "unknown_instance" };
  return { ok: true, value: inst.id };
}
