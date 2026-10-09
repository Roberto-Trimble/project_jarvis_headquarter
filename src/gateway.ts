// The service's own Azure Boards and GitHub calls (REST), for the things agents must not do themselves:
// reading a story to start a run, CI status, merge after release approval, cancelling CI on STOP ALL.
// Agents use the Azure DevOps and GitHub MCP servers registered in Studio (see studio/README.md).
// The service's credentials never reach Studio or a model.

export type Story = { id: string; title: string; description: string; acceptanceCriteria: string; tags: string[] };
export type CiStatus = { state: "pending" | "success" | "failure"; headSha: string; checks: { name: string; conclusion: string | null }[] };

export interface Gateway {
  getStory(id: string): Promise<Story>;
  commentOnStory(id: string, markdown: string): Promise<void>;
  getCiStatus(prNumber: number): Promise<CiStatus>;
  mergePullRequest(prNumber: number): Promise<{ merged: boolean; sha?: string }>;
  /** Cancel in-progress Actions runs on jarvis/* branches. Returns how many were cancelled. */
  cancelJarvisWorkflowRuns(): Promise<number>;
}

export class FakeGateway implements Gateway {
  stories = new Map<string, Story>([
    ["101", { id: "101", title: "Add CSV export to the invoices list", description: "Users want to export the filtered list.", acceptanceCriteria: "- Export button on invoices list\n- CSV matches visible columns", tags: ["jarvis"] }],
  ]);
  comments: { id: string; markdown: string }[] = [];
  merged: number[] = [];
  ciCancels = 0;

  async getStory(id: string): Promise<Story> {
    const s = this.stories.get(id);
    if (!s) throw new Error(`story ${id} not found`);
    return s;
  }
  async commentOnStory(id: string, markdown: string) {
    this.comments.push({ id, markdown });
  }
  async getCiStatus(): Promise<CiStatus> {
    return { state: "success", headSha: "0000000", checks: [{ name: "ci", conclusion: "success" }] };
  }
  async mergePullRequest(prNumber: number) {
    this.merged.push(prNumber);
    return { merged: true, sha: "fake-merge-sha" };
  }
  async cancelJarvisWorkflowRuns() {
    this.ciCancels += 1;
    return 0;
  }
}

/** Keep tool responses under Studio's ~100 KB limit. Large payloads are cut with a marker so agents paginate. */
export function trimResponse(value: unknown, maxBytes: number): unknown {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return value;
  const head = Buffer.from(text, "utf8").subarray(0, maxBytes - 200).toString("utf8");
  return { truncated: true, note: "Response exceeded the tool size limit. Request a smaller page.", partial: head };
}
