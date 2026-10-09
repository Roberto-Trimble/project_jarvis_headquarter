import { randomUUID } from "node:crypto";

// Trimble Agent Studio, Agents API. Only the calls Jarvis needs.
// Per the Studio platform agent: cancel is a `cancel` query param on the run endpoint and usage is on the run payload.
// Exact routes still to confirm from the /api/agents OpenAPI spec;
// HttpStudio keeps every path in one place so confirming them is a one-file change.

export type RunUsage = { inputTokens: number | null; outputTokens: number | null; costMicroUsd: number | null };

export interface Studio {
  /** Start the Project Manager run for a story. Returns the Studio run ID. */
  startRun(input: { storyId: string; message: string }): Promise<string>;
  /** Submit a suspended local tool's result (request_approval, wait_for_ci) so the run resumes. */
  resumeRun(runId: string, toolResult: unknown): Promise<void>;
  cancelRun(runId: string): Promise<void>;
  /** Usage for a finished run. Unknown fields stay null; nothing is estimated as fact. */
  getRunUsage(runId: string): Promise<RunUsage>;
  /** Send an owner chat message to the Project Manager. */
  chat(message: string, conversationId?: string): Promise<{ reply: string; conversationId: string }>;
}

export class FakeStudio implements Studio {
  readonly started: { runId: string; storyId: string; message: string }[] = [];
  readonly resumed: { runId: string; toolResult: unknown }[] = [];
  readonly cancelled: string[] = [];

  async startRun(input: { storyId: string; message: string }): Promise<string> {
    const runId = `run-${randomUUID()}`;
    this.started.push({ runId, ...input });
    return runId;
  }
  async resumeRun(runId: string, toolResult: unknown): Promise<void> {
    this.resumed.push({ runId, toolResult });
  }
  async cancelRun(runId: string): Promise<void> {
    this.cancelled.push(runId);
  }
  async getRunUsage(): Promise<RunUsage> {
    return { inputTokens: null, outputTokens: null, costMicroUsd: null };
  }
  async chat(message: string, conversationId = randomUUID()) {
    return { reply: `(offline) Jarvis received: ${message}`, conversationId };
  }
}

export class HttpStudio implements Studio {
  constructor(private base: string, private apiKey: string, private pmAgentId: string) {}

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`studio ${method} ${path}: ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  // POST /agents/{agentId}/runs starts a run (or resumes one when threadId/runId are passed) and streams
  // AG-UI events. messages accepts only user, tool, and activity roles. context is at most 10
  // {description, value} items, read by the agent with get_run_context, and must never hold secrets.
  // Auth: TID bearer token with openid + agents scopes.
  // TODO(confirm): cancel/get paths and the exact resume body against the /api/agents OpenAPI spec.
  private threads = new Map<string, string>();

  private async stream(body: unknown): Promise<{ runId: string; threadId: string }> {
    const res = await fetch(`${this.base}/agents/${this.pmAgentId}/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) throw new Error(`studio run: ${res.status}`);
    // Read until RUN_STARTED gives the IDs. The rest of the stream drains in the background, so the
    // connection stays open (it isn't yet confirmed whether closing it cancels the run).
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const line of buffer.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          const event = JSON.parse(line.slice(5));
          if (event.type === "RUN_STARTED" && event.runId) {
            void (async () => { while (!(await reader.read()).done); })().catch(() => {});
            return { runId: String(event.runId), threadId: String(event.threadId ?? "") };
          }
        } catch { /* partial line; keep reading */ }
      }
    }
    throw new Error("studio run: stream ended without RUN_STARTED");
  }

  async startRun(input: { storyId: string; message: string }) {
    const { runId, threadId } = await this.stream({
      messages: [{ role: "user", content: input.message }],
      context: [{ description: "storyId", value: input.storyId }],
    });
    this.threads.set(runId, threadId);
    return runId;
  }
  async resumeRun(runId: string, toolResult: unknown) {
    await this.stream({
      threadId: this.threads.get(runId),
      runId,
      messages: [{ role: "tool", content: JSON.stringify(toolResult) }],
    });
  }
  async cancelRun(runId: string) {
    await this.call("POST", `/runs/${runId}/cancel`);
  }
  async getRunUsage(runId: string): Promise<RunUsage> {
    const out = await this.call("GET", `/runs/${runId}`);
    const u = out?.usage ?? {};
    return {
      inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : null,
      outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : null,
      costMicroUsd: typeof u.cost_microusd === "number" ? u.cost_microusd : null,
    };
  }
  async chat(message: string, conversationId?: string) {
    const out = await this.call("POST", `/agents/${this.pmAgentId}/chat`, { message, conversationId });
    return { reply: String(out.reply ?? ""), conversationId: String(out.conversationId ?? conversationId ?? "") };
  }
}
