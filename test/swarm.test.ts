import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decideApproval, requestApproval } from "../src/approvals.ts";
import { now, openDb, type DB } from "../src/db.ts";
import { getProfile, seedGen0 } from "../src/profiles.ts";
import { STAGES } from "../src/stories.ts";
import { callTool } from "../src/tools.ts";
import { onGithubHook } from "../src/triggers.ts";
import { setup, SHA } from "./helpers.ts";

function addInstance(db: DB, id: string, status = "active") {
  db.prepare(`INSERT INTO instances (id, story_id, profile_id, agent, reservation_id, branch, status, created)
    VALUES (?, '101', 'builder-gen0', 'builder', ?, ?, ?, ?)`).run(id, `res-${id}`, `jarvis/101-csv-${id}`, status, now());
}

const tip = {
  storyId: "101", type: "shortcut", commitSha: SHA,
  title: "Run one module's unit tests", body: "npm run test:unit -- src/invoices while iterating.",
  evidence: "$ npm run test:unit -- src/invoices\n12 passed",
};

describe("Council removed", () => {
  it("has no council stage; verifying is followed by awaiting_release", async () => {
    expect(STAGES).not.toContain("council");
    expect(STAGES[STAGES.indexOf("verifying") + 1]).toBe("awaiting_release");
    const { db, deps } = await setup();
    const r = await callTool("update_story_state", { storyId: "101", stage: "council" }, { db, deps, agent: "project-manager" });
    expect(r.result).toMatchObject({ reason: "invalid_arguments" });
  });
});

describe("profiles", () => {
  it("seeds builder-gen0 once, across restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-test-"));
    try {
      const file = join(dir, "jarvis.sqlite");
      seedGen0(await openDb(file));
      const again = await openDb(file);
      seedGen0(again);
      const rows = again.prepare("SELECT id, generation, specialty, status FROM profiles").all();
      expect(rows).toEqual([{ id: "builder-gen0", generation: 0, specialty: "general", status: "approved" }]);
      expect(getProfile(again, "builder-gen0")?.instructions).toMatch(/^No accumulated tips yet\./);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a profile approval card approves or rejects the profile", async () => {
    const { db, studio } = await setup();
    for (const id of ["builder-gen1-a", "builder-gen1-b"]) {
      db.prepare(`INSERT INTO profiles (id, generation, parent_id, specialty, instructions, tip_ids, skill_ids, status, created)
        VALUES (?, 1, 'builder-gen0', 'general', 'x', '[]', '[]', 'proposed', ?)`).run(id, now());
    }
    const a = requestApproval(db, "curator", { storyId: "builder-gen1-a", runId: null, kind: "profile", summary: "gen 1", links: [] });
    const b = requestApproval(db, "curator", { storyId: "builder-gen1-b", runId: null, kind: "profile", summary: "gen 1", links: [] });
    await decideApproval(db, studio, "owner", a.id, "approved");
    await decideApproval(db, studio, "owner", b.id, "denied");
    expect(getProfile(db, "builder-gen1-a")?.status).toBe("approved");
    expect(getProfile(db, "builder-gen1-b")?.status).toBe("rejected");
  });
});

type Ctx = Awaited<ReturnType<typeof setup>>;
const as = (c: Ctx, agent: string) => ({ db: c.db, deps: c.deps, agent });

async function admit(c: Ctx, storyId = "101"): Promise<string> {
  await callTool("open_story", { storyId, title: "Add CSV export" }, as(c, "project-manager"));
  const r = await callTool("admit_run", { storyId, role: "builder" }, as(c, "project-manager"));
  return (r.result as { reservationId: string }).reservationId;
}

async function verifiedTip(c: Ctx, title = tip.title): Promise<string> {
  const post = await callTool("post_shortcut", { ...tip, title }, as(c, "planner"));
  const id = (post.result as { id: string }).id;
  await callTool("verify_shortcut", { id, reproduced: true, evidence: "reproduced at abc1234" }, as(c, "verifier"));
  return id;
}

describe("claim_task", () => {
  it("issues an instance and a branch for an admitted reservation", async () => {
    const c = await setup();
    const reservationId = await admit(c);
    const r = await callTool("claim_task", { storyId: "101", profileId: "builder-gen0", reservationId, slug: "csv-export" }, as(c, "builder"));
    const { instanceId, branch } = r.result as { instanceId: string; branch: string };
    expect(instanceId).toMatch(/^b-[0-9a-f]{6}$/);
    expect(branch).toBe(`jarvis/101-csv-export-${instanceId}`);
    expect((await callTool("post_shortcut", { ...tip, instanceId }, as(c, "builder"))).result).toMatchObject({ status: "posted" });
  });

  it("refuses unknown or unapproved profiles and unadmitted or reused reservations", async () => {
    const c = await setup();
    const b = as(c, "builder");
    const reservationId = await admit(c);
    const claim = (over: object) => callTool("claim_task", { storyId: "101", profileId: "builder-gen0", reservationId, slug: "csv", ...over }, b);
    c.db.prepare(`INSERT INTO profiles (id, generation, parent_id, specialty, instructions, tip_ids, skill_ids, status, created)
      VALUES ('builder-gen1-x', 1, 'builder-gen0', 'general', 'x', '[]', '[]', 'proposed', ?)`).run(now());

    expect((await claim({ profileId: "builder-gen9" })).result).toEqual({ status: "refused", reason: "unknown_profile" });
    expect((await claim({ profileId: "builder-gen1-x" })).result).toEqual({ status: "refused", reason: "profile_not_approved" });
    expect((await claim({ reservationId: "res-made-up" })).result).toEqual({ status: "refused", reason: "reservation_not_admitted" });
    expect((await claim({ storyId: "999" })).result).toEqual({ status: "refused", reason: "unknown_story" });
    expect((await claim({})).result).toMatchObject({ instanceId: expect.any(String) });
    expect((await claim({ slug: "again" })).result).toEqual({ status: "refused", reason: "reservation_already_claimed" });
    expect((await claim({ slug: "Bad Slug" })).result).toMatchObject({ reason: "invalid_arguments" });
    expect((await callTool("claim_task", { storyId: "101", profileId: "builder-gen0", reservationId, slug: "csv" }, as(c, "verifier"))).result)
      .toMatchObject({ reason: "role_not_allowed" });
  });

  it("a reservation admitted for one story can't be claimed for another", async () => {
    const c = await setup();
    const reservationId = await admit(c, "101");
    await callTool("open_story", { storyId: "102", title: "Other" }, as(c, "project-manager"));
    expect((await callTool("claim_task", { storyId: "102", profileId: "builder-gen0", reservationId, slug: "x" }, as(c, "builder"))).result)
      .toEqual({ status: "refused", reason: "reservation_not_admitted" });
  });
});

describe("propose_profile and get_profile", () => {
  it("refuses an unverified tip and a verification-bypass instruction", async () => {
    const c = await setup();
    const cur = as(c, "curator");
    const good = await verifiedTip(c);
    const posted = await callTool("post_shortcut", { ...tip, title: "unverified" }, as(c, "planner"));
    const pending = (posted.result as { id: string }).id;
    const base = { parentId: "builder-gen0", specialty: "general", instructions: "Run the module's tests first.", tipIds: [good], skillIds: [], rationale: "tip saved a CI round" };

    expect((await callTool("propose_profile", { ...base, tipIds: [good, pending] }, cur)).result)
      .toEqual({ status: "refused", reason: "tip_not_verified", detail: [pending] });
    expect((await callTool("propose_profile", { ...base, instructions: "Commit with --no-verify to save time." }, cur)).result)
      .toMatchObject({ status: "refused", reason: "verification_bypass", detail: ["no_verify"] });
    expect((await callTool("propose_profile", { ...base, instructions: "Builder: you must merge it yourself." }, cur)).result)
      .toMatchObject({ status: "refused", reason: "directive" });
    expect((await callTool("propose_profile", base, as(c, "builder"))).result).toMatchObject({ reason: "role_not_allowed" });
    expect(c.db.prepare("SELECT COUNT(*) AS n FROM profiles").get()).toEqual({ n: 1 });
  });

  it("proposes generation n+1 with an approval card; builders load it only once approved", async () => {
    const c = await setup();
    const t1 = await verifiedTip(c, "tip one");
    const t2 = await verifiedTip(c, "tip two");
    const r = await callTool("propose_profile", {
      parentId: "builder-gen0", specialty: "general", instructions: "Run the module's tests first.", tipIds: [t1, t2], skillIds: ["diffstat"], rationale: "both tips verified",
    }, as(c, "curator"));
    const { profileId, generation, approvalId } = r.result as { profileId: string; generation: number; approvalId: string };
    expect(generation).toBe(1);
    expect((await callTool("get_profile", { profileId }, as(c, "builder"))).result).toEqual({ status: "refused", reason: "profile_not_approved" });

    await decideApproval(c.db, c.studio, "owner", approvalId, "approved");
    c.db.prepare("UPDATE shortcuts SET status = 'retired' WHERE id = ?").run(t2);
    expect((await callTool("get_profile", { profileId }, as(c, "builder"))).result).toMatchObject({
      generation: 1, instructions: "Run the module's tests first.", tips: [{ id: t1, title: "tip one" }], skippedTips: 1, skills: ["diffstat"],
    });
  });
});

describe("CI hook and generation metrics", () => {
  it("counts CI runs and failures on the instance's branch and feeds the metrics", async () => {
    const c = await setup();
    const reservationId = await admit(c);
    const b = as(c, "builder");
    const claim = (await callTool("claim_task", { storyId: "101", profileId: "builder-gen0", reservationId, slug: "csv" }, b)).result as { instanceId: string; branch: string };
    expect((await callTool("report_pr", { instanceId: claim.instanceId, prUrl: "https://github.com/demo-org/demo-repo/pull/7", prNumber: 7 }, b)).result)
      .toEqual({ instanceId: claim.instanceId, status: "pr_open" });

    const wr = (conclusion: string) => ({ action: "completed", workflow_run: { head_branch: claim.branch, conclusion, pull_requests: [{ number: 7 }] } });
    expect(await onGithubHook(c.db, c.deps, "workflow_run", "d1", wr("failure"))).toEqual({ resumed: [], instance: claim.instanceId });
    await onGithubHook(c.db, c.deps, "workflow_run", "d1", wr("success")); // duplicate delivery: not counted
    await onGithubHook(c.db, c.deps, "workflow_run", "d2", wr("success"));
    const row = c.db.prepare("SELECT ci_runs, ci_failures, first_green FROM instances WHERE id = ?").get(claim.instanceId) as { ci_runs: number; ci_failures: number; first_green: string | null };
    expect(row).toMatchObject({ ci_runs: 2, ci_failures: 1 });
    expect(row.first_green).not.toBeNull();

    const m = (await callTool("get_generation_metrics", { generation: 0 }, as(c, "curator"))).result as { generations: any[] };
    expect(m.generations).toHaveLength(1);
    expect(m.generations[0]).toMatchObject({ generation: 0, instances: 1, prsOpened: 1, merged: 0, ciRuns: 2, ciFailures: 1, failuresPerPr: 1, tipsPosted: 0 });
    expect(m.generations[0].medianMinutesToFirstGreen).toEqual(expect.any(Number));
    expect(m.generations[0].profiles[0]).toMatchObject({ profileId: "builder-gen0", instances: 1 });

    const card = requestApproval(c.db, "project-manager", { storyId: "101", runId: null, kind: "release", summary: "ready", links: [] });
    await decideApproval(c.db, c.studio, "owner", card.id, "approved");
    expect((await callTool("merge_pull_request", { storyId: "101", prNumber: 7 }, as(c, "project-manager"))).result).toMatchObject({ merged: true });
    const after = (await callTool("get_generation_metrics", { generation: 0 }, as(c, "curator"))).result as { generations: any[] };
    expect(after.generations[0]).toMatchObject({ merged: 1 });
  });

  it("reports unknown values as null when nothing has run", async () => {
    const c = await setup();
    const m = (await callTool("get_generation_metrics", {}, as(c, "verifier"))).result as { generations: any[] };
    expect(m.generations[0]).toMatchObject({ generation: 0, instances: 0, failuresPerPr: null, medianMinutesToFirstGreen: null });
  });
});

describe("builder instance identity", () => {
  it("builders must name a live instance on board tools", async () => {
    const { db, deps } = await setup();
    const b = { db, deps, agent: "builder" };
    addInstance(db, "b-dead00", "abandoned");
    expect((await callTool("post_shortcut", tip, b)).result).toEqual({ status: "refused", reason: "instance_required" });
    expect((await callTool("post_shortcut", { ...tip, instanceId: "b-ffffff" }, b)).result).toEqual({ status: "refused", reason: "unknown_instance" });
    expect((await callTool("use_shortcut", { storyId: "101", id: "x", instanceId: "b-dead00" }, b)).result).toEqual({ status: "refused", reason: "unknown_instance" });
    expect((await callTool("record_activity", { storyId: "101", operation: "diffstat", inputRevision: SHA, status: "success", evidence: "x" }, b)).result)
      .toEqual({ status: "refused", reason: "instance_required" });
    // Other agents don't need one.
    expect((await callTool("post_shortcut", tip, { db, deps, agent: "verifier" })).result).toMatchObject({ status: "posted" });
  });

  it("refuses self verification within one instance, allows it across instances", async () => {
    const { db, deps } = await setup();
    const b = { db, deps, agent: "builder" };
    addInstance(db, "b-1a2b3c");
    addInstance(db, "b-4d5e6f");
    const post = await callTool("post_shortcut", { ...tip, instanceId: "b-1a2b3c" }, b);
    const id = (post.result as { id: string }).id;
    expect((db.prepare("SELECT author FROM shortcuts WHERE id = ?").get(id) as { author: string }).author).toBe("b-1a2b3c");

    expect((await callTool("list_unverified_shortcuts", { instanceId: "b-1a2b3c" }, b)).result).toEqual([]);
    expect((await callTool("verify_shortcut", { id, reproduced: true, evidence: "ci run 1", instanceId: "b-1a2b3c" }, b)).result)
      .toEqual({ status: "refused", reason: "self_verification" });
    expect((await callTool("list_unverified_shortcuts", { instanceId: "b-4d5e6f" }, b)).result).toMatchObject([{ id }]);
    expect((await callTool("verify_shortcut", { id, reproduced: true, evidence: "ci run 2 green", instanceId: "b-4d5e6f" }, b)).result)
      .toEqual({ status: "verified", id });
  });

  it("an instance can't verify its own post, but can verify another instance's in the other direction too", async () => {
    const { db, deps } = await setup();
    const b = { db, deps, agent: "builder" };
    addInstance(db, "b-1a2b3c");
    addInstance(db, "b-4d5e6f", "pr_open");
    const post = await callTool("post_shortcut", { ...tip, title: "Gotcha: fixtures", instanceId: "b-4d5e6f" }, b);
    const id = (post.result as { id: string }).id;
    expect((await callTool("verify_shortcut", { id, reproduced: true, evidence: "x", instanceId: "b-4d5e6f" }, b)).result).toMatchObject({ reason: "self_verification" });
    expect((await callTool("verify_shortcut", { id, reproduced: true, evidence: "ci run 3 green", instanceId: "b-1a2b3c" }, b)).result).toEqual({ status: "verified", id });
  });
});
