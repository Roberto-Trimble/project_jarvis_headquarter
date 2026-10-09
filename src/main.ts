import { join } from "node:path";
import { openDb } from "./db.ts";
import { depsFromEnv } from "./deps.ts";
import { createApp } from "./server.ts";
import { expireStale } from "./shortcuts.ts";

const deps = depsFromEnv();
const db = await openDb(join(process.env.JARVIS_DATA_DIR || "data", "jarvis.sqlite"));
const port = Number(process.env.PORT || 8787);

// Scheduled housekeeping: retire stale shortcuts. The reuse scan runs on each board refresh.
setInterval(() => expireStale(db), 15 * 60_000).unref();

createApp(db, deps).listen(port, () => {
  const fakes = [
    deps.studio.constructor.name === "FakeStudio" && "Studio",
    deps.brake.constructor.name === "FakeBrake" && "AgentBrake",
    deps.gateway.constructor.name === "FakeGateway" && "Azure Boards/GitHub",
  ].filter(Boolean);
  console.log(`Jarvis service on http://localhost:${port}` + (fakes.length ? ` (fakes: ${fakes.join(", ")})` : ""));
});
