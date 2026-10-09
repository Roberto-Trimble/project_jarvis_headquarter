import express, { type NextFunction, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { decideApproval, type ApprovalRow } from "./approvals.ts";
import type { DB } from "./db.ts";
import type { Deps } from "./deps.ts";
import { handleMcp } from "./mcp.ts";
import { generationMetrics, profileCard } from "./profiles.ts";
import { listShortcuts, retireShortcut } from "./shortcuts.ts";
import { isStopped, resume, stopAll } from "./stop.ts";
import { startStory } from "./stories.ts";
import { onAzureBoardsHook, onGithubHook, onLocalToolCall, verifyAzdoAuth, verifyGithubSignature } from "./triggers.ts";

const isLocal = (req: Request) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");

export function createApp(db: DB, deps: Deps) {
  const app = express();

  // Owner endpoints: board token required, except from localhost when no token is configured.
  const owner = (req: Request, res: Response, next: NextFunction) => {
    if (!deps.boardToken) return isLocal(req) ? next() : res.status(401).json({ error: "board token not configured" });
    const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    const want = Buffer.from(deps.boardToken);
    if (given.length === want.length && timingSafeEqual(given, want)) return next();
    res.status(401).json({ error: "unauthorized" });
  };

  app.get("/healthz", (_req, res) => res.json({ ok: true, stopped: isStopped(db) }));

  // Webhooks need the raw body for signature checks.
  app.post("/hooks/github", express.raw({ type: "*/*", limit: "2mb" }), async (req, res) => {
    const body = req.body as Buffer;
    if (!verifyGithubSignature(body, req.header("x-hub-signature-256"), deps.hookSecrets.github)) return void res.status(401).end();
    res.json(await onGithubHook(db, deps, req.header("x-github-event"), req.header("x-github-delivery"), JSON.parse(body.toString("utf8"))));
  });
  app.post("/hooks/azure-boards", express.json({ limit: "2mb" }), async (req, res) => {
    if (!verifyAzdoAuth(req.header("authorization"), deps.hookSecrets.azdoUser, deps.hookSecrets.azdoPassword)) return void res.status(401).end();
    res.json(await onAzureBoardsHook(db, deps, req.body));
  });

  app.post("/mcp", express.json({ limit: "1mb" }), (req, res) => handleMcp(db, deps, req, res));
  app.get("/mcp", (_req, res) => res.status(405).end());

  const api = express.Router();
  api.use(express.json({ limit: "256kb" }), owner);

  api.get("/state", async (_req, res) => {
    const stories = db.prepare("SELECT * FROM stories ORDER BY updated DESC LIMIT 50").all() as { id: string }[];
    const withSpend = await Promise.all(stories.map(async (s) => ({ ...s, spent: await deps.brake.spent(s.id) })));
    res.json({
      stopped: isStopped(db),
      stories: withSpend,
      runs: db.prepare("SELECT * FROM runs ORDER BY updated DESC LIMIT 50").all(),
      approvals: (db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created").all() as ApprovalRow[])
        .map((a) => (a.kind === "profile" ? { ...a, profile: profileCard(db, a.story_id) } : a)),
      generations: generationMetrics(db).generations,
      shortcuts: listShortcuts(db).slice(0, 50),
      reuseCandidates: await deps.brake.reuseScan(),
      audit: db.prepare("SELECT * FROM audit ORDER BY seq DESC LIMIT 40").all(),
    });
  });
  api.post("/stories/:id/run", async (req, res) => {
    res.json(await startStory(db, deps, req.params.id, "owner", { requireTag: false }));
  });
  api.post("/approvals/:id", async (req, res) => {
    const decision = req.body?.decision;
    if (decision !== "approved" && decision !== "denied") return void res.status(400).json({ error: "decision must be approved or denied" });
    const row = await decideApproval(db, deps.studio, "owner", req.params.id, decision, req.body?.note);
    row ? res.json(row) : res.status(404).end();
  });
  api.post("/shortcuts/:id/retire", (req, res) => {
    res.json({ retired: retireShortcut(db, "owner", req.params.id, String(req.body?.reason ?? "removed_by_owner")) });
  });
  api.post("/stop", async (_req, res) => res.json(await stopAll(db, deps, "owner")));
  api.post("/resume", (_req, res) => {
    resume(db, "owner");
    res.json({ stopped: false });
  });
  api.post("/chat", async (req, res) => {
    const message = String(req.body?.message ?? "").slice(0, 4000);
    if (!message) return void res.status(400).end();
    res.json(await deps.studio.chat(message, req.body?.conversationId));
  });
  // Bridge for Studio local tools until the run event mechanism is confirmed; also drives the offline demo.
  api.post("/runs/:id/local-tool", (req, res) => {
    res.json(onLocalToolCall(db, req.params.id, String(req.body?.tool), req.body?.args));
  });
  app.use("/api", api);

  app.use(express.static(join(process.cwd(), "public")));
  return app;
}
