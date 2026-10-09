import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decideApproval, requestApproval } from "../src/approvals.ts";
import { now, openDb, type DB } from "../src/db.ts";
import { getProfile, seedGen0 } from "../src/profiles.ts";
import { STAGES } from "../src/stories.ts";
import { callTool } from "../src/tools.ts";
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
