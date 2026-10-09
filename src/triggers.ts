import { createHmac, timingSafeEqual } from "node:crypto";
import { requestApproval, APPROVAL_KINDS, type ApprovalKind } from "./approvals.ts";
import { audit, firstSeen, now, type DB } from "./db.ts";
import type { Deps } from "./deps.ts";
import { startStory, updateStage, type StartResult } from "./stories.ts";

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Azure DevOps service hooks authenticate with basic auth configured on the subscription. */
export function verifyAzdoAuth(header: string | undefined, user: string | null, password: string | null): boolean {
  if (!user || !password || !header?.startsWith("Basic ")) return false;
  return safeEqual(Buffer.from(header.slice(6), "base64").toString("utf8"), `${user}:${password}`);
}

export function verifyGithubSignature(body: Buffer, header: string | undefined, secret: string | null): boolean {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  return safeEqual(expected, header);
}

function tagsOf(value: unknown): string[] {
  return typeof value === "string" ? value.split(";").map((t) => t.trim().toLowerCase()).filter(Boolean) : [];
}

/** "Work item updated": start only when the jarvis tag was just added. */
export async function onAzureBoardsHook(db: DB, deps: Deps, payload: any): Promise<StartResult | { ignored: string }> {
  if (payload?.eventType !== "workitem.updated") return { ignored: "event_type" };
  const r = payload.resource ?? {};
  const id = String(r.workItemId ?? r.revision?.id ?? "");
  const rev = String(r.rev ?? r.revision?.rev ?? "");
  if (!id) return { ignored: "no_work_item" };
  const tagChange = r.fields?.["System.Tags"];
  const tag = deps.policy.trigger_tag;
  const added = tagChange ? !tagsOf(tagChange.oldValue).includes(tag) && tagsOf(tagChange.newValue).includes(tag) : false;
  if (!added) return { ignored: "tag_not_added" };
  if (!firstSeen(db, `azdo:${id}:${rev}`)) return { ignored: "duplicate" };
  return startStory(db, deps, id, "azure-boards-hook", { requireTag: true });
}

/** CI finished on a Jarvis PR: resume the run waiting in wait_for_ci. */
export async function onGithubHook(db: DB, deps: Deps, event: string | undefined, deliveryId: string | undefined, payload: any): Promise<{ resumed: string[] } | { ignored: string }> {
  if (event !== "workflow_run" || payload?.action !== "completed") return { ignored: "event_type" };
  if (!deliveryId || !firstSeen(db, `gh:${deliveryId}`)) return { ignored: "duplicate" };
  const wr = payload.workflow_run ?? {};
  if (!String(wr.head_branch ?? "").startsWith("jarvis/")) return { ignored: "not_jarvis_branch" };
  const prNumbers: number[] = (wr.pull_requests ?? []).map((p: any) => Number(p.number));
  const resumed: string[] = [];
  for (const pr of prNumbers) {
    const waits = db.prepare("SELECT * FROM ci_waits WHERE pr_number = ?").all(pr) as { run_id: string; story_id: string }[];
    for (const w of waits) {
      // Read the combined status rather than trusting one workflow's conclusion.
      const status = await deps.gateway.getCiStatus(pr);
      if (status.state === "pending") continue;
      db.prepare("DELETE FROM ci_waits WHERE run_id = ?").run(w.run_id);
      db.prepare("UPDATE runs SET status = 'running', waiting_on = NULL, updated = ? WHERE id = ?").run(now(), w.run_id);
      await deps.studio.resumeRun(w.run_id, { pr, ...status });
      audit(db, "github-hook", "ci_resumed", w.story_id, { pr, state: status.state });
      resumed.push(w.run_id);
    }
  }
  return { resumed };
}

/**
 * Studio local tools (request_approval, wait_for_ci) suspend the run and hand the call to the client.
 * However the call reaches us (run event stream or polling — still to confirm), it is routed here.
 */
export function onLocalToolCall(db: DB, runId: string, tool: string, args: any): { suspended: true; waitingOn: string } | { error: string } {
  const run = db.prepare("SELECT story_id FROM runs WHERE id = ?").get(runId) as { story_id: string } | undefined;
  if (!run) return { error: "unknown_run" };
  if (tool === "request_approval") {
    const kind = String(args?.kind) as ApprovalKind;
    if (!APPROVAL_KINDS.includes(kind)) return { error: "invalid_kind" };
    if (kind === "profile") return { error: "use_propose_profile" };
    const row = requestApproval(db, "project-manager", {
      storyId: run.story_id, runId, kind, summary: String(args?.summary ?? ""), links: Array.isArray(args?.links) ? args.links.map(String) : [],
    });
    if (kind === "release") updateStage(db, "project-manager", run.story_id, "awaiting_release");
    return { suspended: true, waitingOn: `approval:${row.id}` };
  }
  if (tool === "wait_for_ci") {
    const pr = Number(args?.prNumber);
    if (!Number.isInteger(pr) || pr <= 0) return { error: "invalid_pr" };
    db.prepare("INSERT OR REPLACE INTO ci_waits (run_id, story_id, pr_number, head_sha, created) VALUES (?, ?, ?, ?, ?)")
      .run(runId, run.story_id, pr, args?.headSha ?? null, now());
    db.prepare("UPDATE runs SET status = 'suspended', waiting_on = ?, updated = ? WHERE id = ?").run(`ci:${pr}`, now(), runId);
    updateStage(db, "project-manager", run.story_id, "ci");
    audit(db, "project-manager", "ci_wait", run.story_id, { pr });
    return { suspended: true, waitingOn: `ci:${pr}` };
  }
  return { error: "unknown_local_tool" };
}
