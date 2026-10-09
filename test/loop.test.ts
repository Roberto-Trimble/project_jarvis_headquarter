import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decideApproval } from "../src/approvals.ts";
import { stopAll } from "../src/stop.ts";
import { startStory } from "../src/stories.ts";
import { callTool } from "../src/tools.ts";
import { onAzureBoardsHook, onGithubHook, onLocalToolCall, verifyGithubSignature } from "../src/triggers.ts";
import { setup } from "./helpers.ts";

const tagged = (rev: number) => ({
  eventType: "workitem.updated",
  resource: { workItemId: 101, rev, fields: { "System.Tags": { oldValue: "ui", newValue: "ui; jarvis" } } },
});

describe("triggers", () => {
  it("starts a run when the jarvis tag is added, once", async () => {
    const { db, deps, studio } = await setup();
    expect(await onAzureBoardsHook(db, deps, tagged(5))).toMatchObject({ started: true });
    expect(await onAzureBoardsHook(db, deps, tagged(5))).toEqual({ ignored: "duplicate" });
    expect(await onAzureBoardsHook(db, deps, tagged(6))).toEqual({ started: false, reason: "already_active" });
    expect(studio.started).toHaveLength(1);
  });

  it("ignores updates that don't add the tag", async () => {
    const { db, deps } = await setup();
    const p = { eventType: "workitem.updated", resource: { workItemId: 101, rev: 2, fields: { "System.Title": { newValue: "x" } } } };
    expect(await onAzureBoardsHook(db, deps, p)).toEqual({ ignored: "tag_not_added" });
  });

  it("checks GitHub signatures", () => {
    const body = Buffer.from('{"a":1}');
    const sig = "sha256=" + createHmac("sha256", "gh-secret").update(body).digest("hex");
    expect(verifyGithubSignature(body, sig, "gh-secret")).toBe(true);
    expect(verifyGithubSignature(body, sig, "wrong")).toBe(false);
    expect(verifyGithubSignature(body, undefined, "gh-secret")).toBe(false);
  });
});

describe("one story end to end (fakes)", () => {
  it("CI wait, release approval, merge, complete", async () => {
    const { db, deps, studio, gateway } = await setup();
    const start = await startStory(db, deps, "101", "owner", { requireTag: false });
    if (!start.started) throw new Error("not started");
    const pm = { db, deps, agent: "project-manager" };

    expect((await callTool("admit_run", { storyId: "101", role: "builder" }, pm)).result).toMatchObject({ admitted: true });

    onLocalToolCall(db, start.runId, "wait_for_ci", { prNumber: 7 });
    const wr = { action: "completed", workflow_run: { head_branch: "jarvis/101-csv", pull_requests: [{ number: 7 }] } };
    expect(await onGithubHook(db, deps, "workflow_run", "d1", wr)).toEqual({ resumed: [start.runId] });
    expect(await onGithubHook(db, deps, "workflow_run", "d1", wr)).toEqual({ ignored: "duplicate" });

    // Merge is refused until the owner approves the release.
    expect((await callTool("merge_pull_request", { storyId: "101", prNumber: 7 }, pm)).result).toMatchObject({ reason: "release_not_approved" });
    const wait = onLocalToolCall(db, start.runId, "request_approval", { kind: "release", summary: "CSV export ready", links: [] });
    expect(wait).toMatchObject({ suspended: true });
    const approval = db.prepare("SELECT id FROM approvals WHERE status = 'pending'").get() as { id: string };
    await decideApproval(db, studio, "owner", approval.id, "approved");
    expect(studio.resumed.at(-1)?.toolResult).toMatchObject({ decision: "approved" });

    expect((await callTool("merge_pull_request", { storyId: "101", prNumber: 7 }, pm)).result).toMatchObject({ merged: true });
    const done = await callTool("complete_story", { storyId: "101", prUrl: "https://github.com/demo-org/demo-repo/pull/7", evidence: "CI green; verifier passed 2/2" }, pm);
    expect(done.result).toMatchObject({ stage: "done" });
    expect(gateway.comments[0].markdown).toContain("pull/7");
  });

  it("only the project manager can merge", async () => {
    const { db, deps } = await setup();
    const r = await callTool("merge_pull_request", { storyId: "101", prNumber: 7 }, { db, deps, agent: "builder" });
    expect(r.result).toMatchObject({ reason: "role_not_allowed" });
  });
});

describe("Token Police", () => {
  it("denies a run over the story budget", async () => {
    const { db, deps } = await setup();
    await startStory(db, deps, "101", "owner", { requireTag: false });
    db.prepare("UPDATE stories SET budget_cap = 200000 WHERE id = '101'").run();
    const pm = { db, deps, agent: "project-manager" };
    expect((await callTool("admit_run", { storyId: "101", role: "builder", estimateMicroUsd: 150000 }, pm)).result).toMatchObject({ admitted: true });
    expect((await callTool("admit_run", { storyId: "101", role: "verifier", estimateMicroUsd: 150000 }, pm)).result).toEqual({ admitted: false, reason: "budget" });
  });

  it("finds repeated diffstat runs across agents", async () => {
    const { db, deps } = await setup();
    for (const agent of ["verifier", "critic", "security"]) {
      await callTool("record_activity", { storyId: "101", operation: "diffstat", inputRevision: `abc1234:${agent}`, status: "success", evidence: "artifact:x" }, { db, deps, agent });
    }
    expect(await deps.brake.reuseScan()).toMatchObject([{ operation: "diffstat", successes: 3, distinctAgents: 3, draftable: true }]);
  });
});

describe("STOP ALL", () => {
  it("cancels runs, blocks every tool, cancels CI, and blocks new starts", async () => {
    const { db, deps, studio, gateway } = await setup();
    const start = await startStory(db, deps, "101", "owner", { requireTag: false });
    const report = await stopAll(db, deps, "owner");
    expect(report.runsCancelled).toEqual([start.started ? start.runId : ""]);
    expect(studio.cancelled).toHaveLength(1);
    expect(gateway.ciCancels).toBe(1);
    expect((await callTool("get_story", { storyId: "101" }, { db, deps, agent: "builder" })).result).toMatchObject({ status: "stopped" });
    expect(await startStory(db, deps, "101", "owner", { requireTag: false })).toEqual({ started: false, reason: "stopped" });
  });

  it("still stops locally when Studio is unreachable", async () => {
    const { db, deps, studio } = await setup();
    await startStory(db, deps, "101", "owner", { requireTag: false });
    studio.cancelRun = async () => { throw new Error("network down"); };
    const report = await stopAll(db, deps, "owner");
    expect(report.runCancelErrors).toHaveLength(1);
    expect((await callTool("get_story", { storyId: "101" }, { db, deps, agent: "builder" })).result).toMatchObject({ status: "stopped" });
  });
});

describe("agents started from Studio chat", () => {
  it("open_story registers the issue so admit_run works; message board round trip", async () => {
    const { db, deps } = await setup();
    const pm = { db, deps, agent: "project-manager" };
    expect((await callTool("admit_run", { storyId: "12", role: "planner" }, pm)).result).toMatchObject({ reason: "call_open_story_first" });
    expect((await callTool("open_story", { storyId: "12", title: "Add dark mode" }, pm)).result).toMatchObject({ id: "12", stage: "clarifying" });
    expect((await callTool("admit_run", { storyId: "12", role: "planner" }, pm)).result).toMatchObject({ admitted: true });

    const post = await callTool("post_shortcut", {
      storyId: "12", type: "repo_fact", commitSha: "abc1234",
      title: "Theme tokens live in src/theme.ts", body: "All colors come from src/theme.ts.", evidence: "grep -r '#fff' src -> only src/theme.ts",
    }, { db, deps, agent: "planner" });
    const id = (post.result as { id: string }).id;
    expect((await callTool("search_shortcuts", {}, { db, deps, agent: "builder" })).result).toEqual([]);
    await callTool("verify_shortcut", { id, reproduced: true, evidence: "confirmed at abc1234" }, { db, deps, agent: "verifier" });
    expect((await callTool("search_shortcuts", { query: "theme" }, { db, deps, agent: "builder" })).result).toMatchObject([{ id, type: "repo_fact" }]);
  });
});
