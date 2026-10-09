import { createHash } from "node:crypto";
import { audit, now, type DB } from "./db.ts";
import { checkPost } from "./rules.ts";

export const POST_TYPES = ["shortcut", "gotcha", "repo_fact", "reuse_candidate"] as const;
export type PostType = (typeof POST_TYPES)[number];

export type ShortcutRow = {
  id: string; type: PostType; author: string; story_id: string; project: string; repo: string;
  commit_sha: string; title: string; body: string; evidence: string; status: string;
  verified_by: string | null; verify_evidence: string | null; uses: number; expires: string; created: string;
  retired_reason: string | null;
};

export type PostInput = {
  type: string; storyId: string; project: string; repo: string; commitSha: string;
  title: string; body: string; evidence: string; expiresInDays?: number;
};

export type Outcome<T = unknown> = { ok: true; value: T } | { ok: false; reason: string; detail?: unknown };

export type ShortcutScope = { project: string; repo: string };

export function postShortcut(db: DB, author: string, scope: ShortcutScope, input: PostInput, defaultExpiryDays: number): Outcome<{ id: string; status: string }> {
  if (!(POST_TYPES as readonly string[]).includes(input.type)) return { ok: false, reason: "invalid_type" };
  if (!/^[0-9a-f]{7,40}$/i.test(input.commitSha)) return { ok: false, reason: "invalid_commit" };
  if (!input.evidence?.trim()) return { ok: false, reason: "missing_evidence" };
  if (input.project !== scope.project || input.repo !== scope.repo) {
    audit(db, author, "shortcut_rejected", input.storyId, { reason: "out_of_scope" });
    return { ok: false, reason: "out_of_scope" };
  }
  const hits = checkPost([input.title, input.body, input.evidence].join("\n"));
  if (hits.length) {
    // Secrets are flagged without storing the offending text.
    audit(db, author, hits.some((h) => h.kind === "secret") ? "shortcut_secret_flagged" : "shortcut_rejected", input.storyId, { hits });
    return { ok: false, reason: hits[0].kind, detail: hits.map((h) => h.rule) };
  }
  const days = Math.min(Math.max(input.expiresInDays ?? defaultExpiryDays, 1), 90);
  const id = createHash("sha256").update(`${author}|${input.storyId}|${input.title}|${input.commitSha}`).digest("hex").slice(0, 16);
  const expires = new Date(Date.now() + days * 86_400_000).toISOString();
  const res = db.prepare(`INSERT OR IGNORE INTO shortcuts
    (id, type, author, story_id, project, repo, commit_sha, title, body, evidence, status, expires, created)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?)`)
    .run(id, input.type, author, input.storyId, input.project, input.repo, input.commitSha,
      input.title.slice(0, 160), input.body.slice(0, 2000), input.evidence.slice(0, 2000), expires, now());
  if (res.changes) audit(db, author, "shortcut_posted", input.storyId, { id, type: input.type });
  return { ok: true, value: { id, status: "posted" } };
}

/** A second agent reproduces the post. The author can never verify its own post. */
export function verifyShortcut(db: DB, verifier: string, id: string, evidence: string, reproduced: boolean): Outcome<ShortcutRow> {
  const row = db.prepare("SELECT * FROM shortcuts WHERE id = ?").get(id) as ShortcutRow | undefined;
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status !== "posted") return { ok: false, reason: `not_verifiable_in_${row.status}` };
  if (row.author === verifier) return { ok: false, reason: "self_verification" };
  if (new Date(row.expires) < new Date()) {
    retireShortcut(db, "jarvis-service", id, "expired_unverified");
    return { ok: false, reason: "expired" };
  }
  if (!evidence?.trim()) return { ok: false, reason: "missing_evidence" };
  if (checkPost(evidence).some((h) => h.kind === "secret")) return { ok: false, reason: "secret" };
  if (!reproduced) {
    retireShortcut(db, verifier, id, "failed_reproduction");
    return { ok: false, reason: "retired_failed_reproduction" };
  }
  db.prepare("UPDATE shortcuts SET status = 'verified', verified_by = ?, verify_evidence = ? WHERE id = ?")
    .run(verifier, evidence.slice(0, 2000), id);
  audit(db, verifier, "shortcut_verified", row.story_id, { id });
  return { ok: true, value: db.prepare("SELECT * FROM shortcuts WHERE id = ?").get(id) as ShortcutRow };
}

export function retireShortcut(db: DB, actor: string, id: string, reason: string): boolean {
  const res = db.prepare("UPDATE shortcuts SET status = 'retired', retired_reason = ? WHERE id = ? AND status != 'retired'").run(reason, id);
  if (res.changes) audit(db, actor, "shortcut_retired", null, { id, reason });
  return res.changes === 1;
}

export function recordUse(db: DB, actor: string, id: string, storyId: string): boolean {
  const res = db.prepare("UPDATE shortcuts SET uses = uses + 1 WHERE id = ? AND status = 'verified'").run(id);
  if (res.changes) audit(db, actor, "shortcut_used", storyId, { id });
  return res.changes === 1;
}

/** Housekeeping: unverified posts past expiry are retired. Returns retired IDs. */
export function expireStale(db: DB): string[] {
  const rows = db.prepare("SELECT id FROM shortcuts WHERE status = 'posted' AND expires < ?").all(now()) as { id: string }[];
  for (const { id } of rows) retireShortcut(db, "jarvis-service", id, "expired_unverified");
  return rows.map((r) => r.id);
}

export function listShortcuts(db: DB, status?: string): ShortcutRow[] {
  return (status
    ? db.prepare("SELECT * FROM shortcuts WHERE status = ? ORDER BY created DESC").all(status)
    : db.prepare("SELECT * FROM shortcuts ORDER BY created DESC").all()) as ShortcutRow[];
}
