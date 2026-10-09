import { randomBytes } from "node:crypto";
import { audit, now, type DB } from "./db.ts";
import { checkPost } from "./rules.ts";
import type { Outcome, ShortcutRow } from "./shortcuts.ts";

// A builder profile is what one generation of builder instances loads: instructions plus verified
// tips and skills distilled from earlier generations. The owner approves each one.

export const PROFILE_STATUSES = ["proposed", "approved", "rejected", "retired"] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

export type ProfileRow = {
  id: string; generation: number; parent_id: string | null; specialty: string; instructions: string;
  tip_ids: string; skill_ids: string; status: ProfileStatus; rationale: string | null; created: string; decided: string | null;
};

export const GEN0_ID = "builder-gen0";
const GEN0_INSTRUCTIONS = "No accumulated tips yet. Follow the Builder agent's instructions and post what you learn.";

export function seedGen0(db: DB): void {
  const res = db.prepare(`INSERT OR IGNORE INTO profiles (id, generation, parent_id, specialty, instructions, tip_ids, skill_ids, status, created, decided)
    VALUES (?, 0, NULL, 'general', ?, '[]', '[]', 'approved', ?, ?)`).run(GEN0_ID, GEN0_INSTRUCTIONS, now(), now());
  if (res.changes) audit(db, "jarvis-service", "profile_seeded", null, { id: GEN0_ID });
}

export function getProfile(db: DB, id: string): ProfileRow | null {
  return (db.prepare("SELECT * FROM profiles WHERE id = ?").get(id) as ProfileRow | undefined) ?? null;
}

const ids = (json: string): string[] => JSON.parse(json) as string[];

/** What a builder loads: the profile's instructions plus the tips that are still verified. */
export function loadProfile(db: DB, id: string): Outcome<{
  id: string; generation: number; specialty: string; instructions: string;
  tips: Pick<ShortcutRow, "id" | "type" | "title" | "body" | "commit_sha">[]; skippedTips: number; skills: string[];
}> {
  const p = getProfile(db, id);
  if (!p) return { ok: false, reason: "unknown_profile" };
  if (p.status !== "approved") return { ok: false, reason: "profile_not_approved" };
  const tipIds = ids(p.tip_ids);
  const tips = tipIds
    .map((t) => db.prepare("SELECT id, type, title, body, commit_sha FROM shortcuts WHERE id = ? AND status = 'verified'").get(t))
    .filter(Boolean) as Pick<ShortcutRow, "id" | "type" | "title" | "body" | "commit_sha">[];
  return { ok: true, value: {
    id: p.id, generation: p.generation, specialty: p.specialty, instructions: p.instructions,
    tips, skippedTips: tipIds.length - tips.length, skills: ids(p.skill_ids),
  } };
}

export type ProfileProposal = { parentId: string; specialty: string; instructions: string; tipIds: string[]; skillIds: string[]; rationale: string };

/** Creates a proposed profile. The caller raises the `profile` approval card. */
export function proposeProfile(db: DB, actor: string, a: ProfileProposal): Outcome<{ profileId: string; generation: number }> {
  const parent = getProfile(db, a.parentId);
  if (!parent) return { ok: false, reason: "unknown_parent" };
  if (parent.status !== "approved" && parent.status !== "retired") return { ok: false, reason: "parent_not_approved" };
  const unverified = a.tipIds.filter((t) => !db.prepare("SELECT 1 FROM shortcuts WHERE id = ? AND status = 'verified'").get(t));
  if (unverified.length) return { ok: false, reason: "tip_not_verified", detail: unverified };
  const hits = checkPost(a.instructions);
  if (hits.length) {
    audit(db, actor, "profile_rejected", null, { hits });
    return { ok: false, reason: hits[0].kind, detail: hits.map((h) => h.rule) };
  }
  const generation = parent.generation + 1;
  const id = `builder-gen${generation}-${a.specialty}-${randomBytes(2).toString("hex")}`;
  db.prepare(`INSERT INTO profiles (id, generation, parent_id, specialty, instructions, tip_ids, skill_ids, status, rationale, created)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`)
    .run(id, generation, parent.id, a.specialty, a.instructions, JSON.stringify(a.tipIds), JSON.stringify(a.skillIds), a.rationale, now());
  audit(db, actor, "profile_proposed", null, { id, generation, parentId: parent.id });
  return { ok: true, value: { profileId: id, generation } };
}

type Metrics = {
  instances: number; prsOpened: number; merged: number; ciRuns: number; ciFailures: number;
  failuresPerPr: number | null; tipsUsed: number; tipsPosted: number; tipsVerified: number;
  medianMinutesToFirstGreen: number | null;
};

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function metricsFor(db: DB, instanceIds: string[]): Metrics {
  const rows = instanceIds.map((id) => db.prepare("SELECT * FROM instances WHERE id = ?").get(id) as {
    id: string; pr_number: number | null; status: string; ci_runs: number; ci_failures: number; first_green: string | null; created: string;
  });
  const set = new Set(instanceIds);
  const posted = (db.prepare("SELECT author, verified_by FROM shortcuts").all() as { author: string; verified_by: string | null }[])
    .filter((s) => set.has(s.author));
  const used = (db.prepare("SELECT actor FROM audit WHERE action = 'shortcut_used'").all() as { actor: string }[])
    .filter((u) => set.has(u.actor)).length;
  const prsOpened = rows.filter((r) => r.pr_number !== null).length;
  const ciFailures = rows.reduce((n, r) => n + r.ci_failures, 0);
  return {
    instances: rows.length,
    prsOpened,
    merged: rows.filter((r) => r.status === "done").length,
    ciRuns: rows.reduce((n, r) => n + r.ci_runs, 0),
    ciFailures,
    failuresPerPr: prsOpened ? ciFailures / prsOpened : null,
    tipsUsed: used,
    tipsPosted: posted.length,
    tipsVerified: posted.filter((s) => s.verified_by !== null).length,
    medianMinutesToFirstGreen: median(rows.filter((r) => r.first_green)
      .map((r) => (Date.parse(r.first_green!) - Date.parse(r.created)) / 60_000)),
  };
}

/** Per generation and per profile. Values that can't be measured are null, never estimated. */
export function generationMetrics(db: DB, generation?: number) {
  const profiles = (generation === undefined
    ? db.prepare("SELECT * FROM profiles ORDER BY generation, created").all()
    : db.prepare("SELECT * FROM profiles WHERE generation = ? ORDER BY created").all(generation)) as ProfileRow[];
  const instancesOf = (profileId: string) =>
    (db.prepare("SELECT id FROM instances WHERE profile_id = ?").all(profileId) as { id: string }[]).map((r) => r.id);
  const gens = [...new Set(profiles.map((p) => p.generation))];
  return {
    generations: gens.map((g) => {
      const ps = profiles.filter((p) => p.generation === g);
      return {
        generation: g,
        ...metricsFor(db, ps.flatMap((p) => instancesOf(p.id))),
        profiles: ps.map((p) => ({ profileId: p.id, specialty: p.specialty, status: p.status, parentId: p.parent_id, ...metricsFor(db, instancesOf(p.id)) })),
      };
    }),
  };
}

/** Owner decision on a `profile` approval card. Only a proposed profile can change. */
export function decideProfile(db: DB, actor: string, id: string, decision: "approved" | "denied"): void {
  const status: ProfileStatus = decision === "approved" ? "approved" : "rejected";
  const res = db.prepare("UPDATE profiles SET status = ?, decided = ? WHERE id = ? AND status = 'proposed'").run(status, now(), id);
  if (res.changes) audit(db, actor, `profile_${status}`, null, { id });
}
