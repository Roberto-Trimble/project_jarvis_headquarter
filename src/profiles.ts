import { audit, now, type DB } from "./db.ts";

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

/** Owner decision on a `profile` approval card. Only a proposed profile can change. */
export function decideProfile(db: DB, actor: string, id: string, decision: "approved" | "denied"): void {
  const status: ProfileStatus = decision === "approved" ? "approved" : "rejected";
  const res = db.prepare("UPDATE profiles SET status = ?, decided = ? WHERE id = ? AND status = 'proposed'").run(status, now(), id);
  if (res.changes) audit(db, actor, `profile_${status}`, null, { id });
}
