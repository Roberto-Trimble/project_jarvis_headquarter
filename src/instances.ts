import { randomBytes } from "node:crypto";
import { audit, now, type DB } from "./db.ts";
import { getProfile } from "./profiles.ts";
import type { Outcome } from "./shortcuts.ts";
import { getStoryRow } from "./stories.ts";

// Every builder instance shares one Studio agent and one bearer token, so the token says "builder"
// and the instance ID, issued by claim_task, says which one.

export const INSTANCE_STATUSES = ["active", "pr_open", "done", "abandoned"] as const;
export type InstanceStatus = (typeof INSTANCE_STATUSES)[number];
export const INSTANCE_ID = /^b-[0-9a-f]{6}$/;
export const SLUG = /^[a-z0-9-]{1,40}$/;

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

/** admit_run records which story a reservation was admitted for, so claim_task can check it. */
export function recordReservation(db: DB, reservationId: string, storyId: string, role: string): void {
  db.prepare("INSERT OR IGNORE INTO reservations (id, story_id, role, created) VALUES (?, ?, ?, ?)").run(reservationId, storyId, role, now());
}

export function claimTask(db: DB, agent: string, a: { storyId: string; profileId: string; reservationId: string; slug: string }): Outcome<{ instanceId: string; branch: string }> {
  if (!SLUG.test(a.slug)) return { ok: false, reason: "invalid_slug" };
  if (!getStoryRow(db, a.storyId)) return { ok: false, reason: "unknown_story" };
  const profile = getProfile(db, a.profileId);
  if (!profile) return { ok: false, reason: "unknown_profile" };
  if (profile.status !== "approved") return { ok: false, reason: "profile_not_approved" };
  if (!db.prepare("SELECT 1 FROM reservations WHERE id = ? AND story_id = ?").get(a.reservationId, a.storyId)) return { ok: false, reason: "reservation_not_admitted" };
  if (db.prepare("SELECT 1 FROM instances WHERE reservation_id = ?").get(a.reservationId)) return { ok: false, reason: "reservation_already_claimed" };

  let id: string;
  do id = `b-${randomBytes(3).toString("hex")}`; while (getInstance(db, id));
  const branch = `jarvis/${a.storyId}-${a.slug}-${id}`;
  db.prepare(`INSERT INTO instances (id, story_id, profile_id, agent, reservation_id, branch, status, created)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`).run(id, a.storyId, a.profileId, agent, a.reservationId, branch, now());
  audit(db, id, "instance_claimed", a.storyId, { profileId: a.profileId, reservationId: a.reservationId, branch });
  return { ok: true, value: { instanceId: id, branch } };
}

export function reportPr(db: DB, agent: string, a: { instanceId: string; prUrl: string; prNumber: number }): Outcome<{ instanceId: string; status: "pr_open" }> {
  const inst = getInstance(db, a.instanceId);
  if (!inst || inst.agent !== agent) return { ok: false, reason: "unknown_instance" };
  if (inst.status !== "active") return { ok: false, reason: `not_active_${inst.status}` };
  db.prepare("UPDATE instances SET status = 'pr_open', pr_url = ?, pr_number = ? WHERE id = ?").run(a.prUrl, a.prNumber, inst.id);
  audit(db, inst.id, "instance_pr_open", inst.story_id, { prUrl: a.prUrl, prNumber: a.prNumber });
  return { ok: true, value: { instanceId: inst.id, status: "pr_open" } };
}

/** A workflow run finished on a branch. Returns the instance it belongs to, if any. */
export function recordCiRun(db: DB, branch: string, conclusion: unknown, at = now()): string | null {
  const inst = db.prepare("SELECT * FROM instances WHERE branch = ?").get(branch) as InstanceRow | undefined;
  if (!inst) return null;
  const green = conclusion === "success";
  db.prepare(`UPDATE instances SET ci_runs = ci_runs + 1, ci_failures = ci_failures + ?,
    first_green = COALESCE(first_green, ?) WHERE id = ?`).run(green ? 0 : 1, green ? at : null, inst.id);
  return inst.id;
}

export function finishOnMerge(db: DB, storyId: string, prNumber: number): void {
  db.prepare("UPDATE instances SET status = 'done', finished = ? WHERE story_id = ? AND pr_number = ? AND status = 'pr_open'").run(now(), storyId, prNumber);
}
