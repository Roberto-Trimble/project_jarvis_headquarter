import { describe, expect, it } from "vitest";
import { STAGES } from "../src/stories.ts";
import { callTool } from "../src/tools.ts";
import { setup } from "./helpers.ts";

describe("Council removed", () => {
  it("has no council stage; verifying is followed by awaiting_release", async () => {
    expect(STAGES).not.toContain("council");
    expect(STAGES[STAGES.indexOf("verifying") + 1]).toBe("awaiting_release");
    const { db, deps } = await setup();
    const r = await callTool("update_story_state", { storyId: "101", stage: "council" }, { db, deps, agent: "project-manager" });
    expect(r.result).toMatchObject({ reason: "invalid_arguments" });
  });
});
