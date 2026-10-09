import { audit, now, type DB } from "./db.ts";
import type { Gateway } from "./gateway.ts";
import type { Studio } from "./studio.ts";

// STOP ALL: three layers, none of which needs a model.
// 1. Cancel every active Studio run. 2. Flip the service to stopped so every Jarvis tool refuses.
// 3. Cancel in-progress GitHub Actions runs on jarvis/* branches.
// Layer 2 is set first and is local, so it holds even if Studio or GitHub are unreachable.

export function isStopped(db: DB): boolean {
  const row = db.prepare("SELECT value FROM control WHERE key = 'stopped'").get() as { value: string } | undefined;
  return row?.value === "1";
}

export type StopReport = {
  stopped: true;
  runsCancelled: string[];
  runCancelErrors: string[];
  ciCancelled: number;
  ciError?: string;
};

export async function stopAll(db: DB, deps: { studio: Studio; gateway: Gateway }, actor: string): Promise<StopReport> {
  db.prepare("INSERT INTO control (key, value) VALUES ('stopped', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run();
  audit(db, actor, "stop_all", null);

  const active = db.prepare("SELECT id FROM runs WHERE status IN ('running', 'suspended')").all() as { id: string }[];
  const runsCancelled: string[] = [];
  const runCancelErrors: string[] = [];
  for (const { id } of active) {
    try {
      await deps.studio.cancelRun(id);
      runsCancelled.push(id);
    } catch (err) {
      runCancelErrors.push(`${id}: ${(err as Error).message}`);
    }
    db.prepare("UPDATE runs SET status = 'cancelled', waiting_on = NULL, updated = ? WHERE id = ?").run(now(), id);
  }
  db.prepare("UPDATE stories SET stage = 'stopped', updated = ? WHERE stage NOT IN ('done', 'merged')").run(now());

  let ciCancelled = 0;
  let ciError: string | undefined;
  try {
    ciCancelled = await deps.gateway.cancelJarvisWorkflowRuns();
  } catch (err) {
    ciError = (err as Error).message;
  }
  const report: StopReport = { stopped: true, runsCancelled, runCancelErrors, ciCancelled, ciError };
  audit(db, actor, "stop_all_report", null, report);
  return report;
}

/** Only the owner, from the board, can lift STOP ALL. Stopped stories stay stopped until re-run. */
export function resume(db: DB, actor: string): void {
  db.prepare("INSERT INTO control (key, value) VALUES ('stopped', '0') ON CONFLICT(key) DO UPDATE SET value = '0'").run();
  audit(db, actor, "resume", null);
}
