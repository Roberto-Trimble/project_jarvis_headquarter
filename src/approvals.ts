import { randomUUID } from "node:crypto";
import { audit, now, type DB } from "./db.ts";
import { decideProfile } from "./profiles.ts";
import type { Studio } from "./studio.ts";

export const APPROVAL_KINDS = ["sketch", "budget", "release", "skill", "profile"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export type ApprovalRow = {
  /** For kind `profile`, story_id holds the profile ID: profile cards belong to no story. */
  id: string; story_id: string; run_id: string | null; kind: ApprovalKind; summary: string; links: string;
  status: "pending" | "approved" | "denied"; decided_by: string | null; note: string | null; created: string; decided: string | null;
};

/** Called by the request_approval tool. The run suspends until the owner decides on the board. */
export function requestApproval(db: DB, actor: string, input: { storyId: string; runId: string | null; kind: ApprovalKind; summary: string; links: string[] }): ApprovalRow {
  const pending = db.prepare("SELECT * FROM approvals WHERE story_id = ? AND kind = ? AND status = 'pending'")
    .get(input.storyId, input.kind) as ApprovalRow | undefined;
  if (pending) return pending; // repeat-safe: one open card per story and kind
  const id = randomUUID();
  db.prepare(`INSERT INTO approvals (id, story_id, run_id, kind, summary, links, status, created)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .run(id, input.storyId, input.runId, input.kind, input.summary.slice(0, 4000), JSON.stringify(input.links.slice(0, 20)), now());
  if (input.runId) db.prepare("UPDATE runs SET status = 'suspended', waiting_on = ?, updated = ? WHERE id = ?").run(`approval:${id}`, now(), input.runId);
  audit(db, actor, "approval_requested", input.storyId, { id, kind: input.kind });
  return db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow;
}

/** Owner decision from the board. Submits the tool result so the suspended run resumes. */
export async function decideApproval(db: DB, studio: Studio, owner: string, id: string, decision: "approved" | "denied", note?: string): Promise<ApprovalRow | null> {
  const row = db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
  if (!row) return null;
  if (row.status !== "pending") return row;
  db.prepare("UPDATE approvals SET status = ?, decided_by = ?, note = ?, decided = ? WHERE id = ?")
    .run(decision, owner, note ?? null, now(), id);
  audit(db, owner, `approval_${decision}`, row.story_id, { id, kind: row.kind });
  if (row.kind === "profile") decideProfile(db, owner, row.story_id, decision);
  if (row.run_id) {
    db.prepare("UPDATE runs SET status = 'running', waiting_on = NULL, updated = ? WHERE id = ?").run(now(), row.run_id);
    await studio.resumeRun(row.run_id, { approvalId: id, decision, note: note ?? null });
  }
  return db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow;
}

export function isApproved(db: DB, storyId: string, kind: ApprovalKind): boolean {
  return Boolean(db.prepare("SELECT 1 FROM approvals WHERE story_id = ? AND kind = ? AND status = 'approved'").get(storyId, kind));
}
