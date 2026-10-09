import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// Token Police, layer 2: AgentBrake. Deterministic, zero model calls.
// Studio's per-agent quotas are layer 1 and are configured in Studio, not here.

export type Admission = { decision: "ALLOW" | "HOLD" | "REPLAY"; reason?: string; dispatch: boolean };
export type UsageReceipt = {
  eventId: string;
  storyId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicroUsd: number | null;
};
export type Activity = {
  eventId: string;
  agent: string;
  storyId: string;
  operation: string;
  inputFingerprint: string;
  status: "success" | "failure";
  evidence: string;
};
export type ReuseCandidate = { id: string; operation: string; successes: number; distinctAgents: number; draftable: boolean };

export interface Brake {
  admit(reservationId: string, storyId: string, estimateMicroUsd: number, capMicroUsd: number): Promise<Admission>;
  settle(reservationId: string, usage: UsageReceipt): Promise<void>;
  recordActivity(activity: Activity): Promise<void>;
  reuseScan(): Promise<ReuseCandidate[]>;
  spent(storyId: string): Promise<{ microUsd: number; unknownRuns: number }>;
}

const PROJECT = "jarvis";
const SCOPE = "product";

/** Mirrors AgentBrake's reserve/settle semantics in memory, for tests and the offline demo. */
export class FakeBrake implements Brake {
  private reservations = new Map<string, { storyId: string; estimate: number; status: "active" | "settled" }>();
  private usage: { storyId: string; cost: number | null }[] = [];
  private activities = new Map<string, Activity>();

  async admit(id: string, storyId: string, estimate: number, cap: number): Promise<Admission> {
    const old = this.reservations.get(id);
    if (old) return { decision: "REPLAY", dispatch: false };
    const events = this.usage.filter((u) => u.storyId === storyId);
    if (events.some((u) => u.cost === null)) return { decision: "HOLD", reason: "unknown_task_cost", dispatch: false };
    const spent = events.reduce((s, u) => s + (u.cost ?? 0), 0);
    const reserved = [...this.reservations.values()]
      .filter((r) => r.storyId === storyId && r.status === "active")
      .reduce((s, r) => s + r.estimate, 0);
    if (spent + reserved + estimate > cap) return { decision: "HOLD", reason: "budget", dispatch: false };
    this.reservations.set(id, { storyId, estimate, status: "active" });
    return { decision: "ALLOW", dispatch: true };
  }
  async settle(id: string, usage: UsageReceipt) {
    const r = this.reservations.get(id);
    if (!r || r.storyId !== usage.storyId) throw new Error("missing or mismatched reservation");
    if (r.status === "settled") return;
    r.status = "settled";
    this.usage.push({ storyId: usage.storyId, cost: usage.costMicroUsd });
  }
  async recordActivity(a: Activity) {
    this.activities.set(a.eventId, a);
  }
  async reuseScan(): Promise<ReuseCandidate[]> {
    const groups = new Map<string, Activity[]>();
    for (const a of this.activities.values()) {
      if (a.status !== "success") continue;
      groups.set(a.operation, [...(groups.get(a.operation) ?? []), a]);
    }
    return [...groups.entries()]
      .map(([operation, list]) => ({
        id: `agentbrake-${operation}`,
        operation,
        successes: list.length,
        distinctAgents: new Set(list.map((a) => a.agent)).size,
        draftable: ["diffstat", "secret-names"].includes(operation),
      }))
      .filter((c) => c.successes >= 3 && c.distinctAgents >= 2);
  }
  async spent(storyId: string) {
    const events = this.usage.filter((u) => u.storyId === storyId);
    return {
      microUsd: events.reduce((s, u) => s + (u.cost ?? 0), 0),
      unknownRuns: events.filter((u) => u.cost === null).length,
    };
  }
}

const run = promisify(execFile);

/** The real AgentBrake, through its CLI. Needs Python 3.10+ and `agentbrake` installed on the service host. */
export class CliBrake implements Brake {
  constructor(private bin: string, private home: string) {}

  private async cli(args: string[], payload?: unknown): Promise<any> {
    let dir: string | undefined;
    try {
      if (payload !== undefined) {
        dir = mkdtempSync(join(tmpdir(), "jarvis-brake-"));
        const file = join(dir, "in.json");
        writeFileSync(file, JSON.stringify(payload));
        args = [...args, file];
      }
      const { stdout } = await run(this.bin, ["--home", this.home, ...args], { timeout: 30_000 });
      return stdout.trim() ? JSON.parse(stdout) : null;
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }

  async admit(id: string, storyId: string, estimate: number, cap: number): Promise<Admission> {
    return this.cli(["reserve", "--id", id, "--task", storyId, "--estimate", String(estimate), "--cap", String(cap)]);
  }
  async settle(id: string, u: UsageReceipt) {
    await this.cli(["settle", id], {
      schema_version: 1, kind: "usage", event_id: u.eventId, task_id: u.storyId,
      workload: PROJECT, cohort: "live",
      input_tokens: u.inputTokens, output_tokens: u.outputTokens,
      cached_input_tokens: 0, cache_write_tokens: 0,
      cost_microusd: u.costMicroUsd, cost_source: u.costMicroUsd === null ? "unknown" : "billed", elapsed_ms: null,
    });
  }
  async recordActivity(a: Activity) {
    await this.cli(["activity-record"], {
      schema_version: 1, event_id: a.eventId, project_id: PROJECT, scope_id: SCOPE, agent_id: a.agent,
      task_id: a.storyId, operation: a.operation, operation_version: "1",
      input_fingerprint: a.inputFingerprint, status: a.status, evidence: a.evidence,
    });
  }
  async reuseScan(): Promise<ReuseCandidate[]> {
    const out = (await this.cli(["reuse-scan", "--project", PROJECT, "--scope", SCOPE])) ?? [];
    return (Array.isArray(out) ? out : out.candidates ?? []).map((c: any) => ({
      id: c.id, operation: c.operation, successes: c.successes, distinctAgents: c.distinct_agents, draftable: c.draftable,
    }));
  }
  async spent(_storyId: string) {
    // TODO: read from AgentBrake's report command once the Jarvis workload is registered.
    return { microUsd: 0, unknownRuns: 0 };
  }
}
