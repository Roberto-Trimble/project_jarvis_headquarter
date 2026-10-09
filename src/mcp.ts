import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import type { DB } from "./db.ts";
import type { Deps } from "./deps.ts";
import { callTool, TOOLS } from "./tools.ts";

/** One MCP server per request (stateless), scoped to the calling agent so it only sees tools its role may call. */
function buildServer(db: DB, deps: Deps, agent: string): McpServer {
  const server = new McpServer({ name: "jarvis", version: "0.1.0" });
  for (const tool of TOOLS) {
    if (tool.roles !== "*" && !tool.roles.includes(agent)) continue;
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (args: unknown) => {
      const { result, isError } = await callTool(tool.name, args, { db, deps, agent });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], isError };
    });
  }
  return server;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Compares against every agent token without stopping at a match, so timing doesn't reveal which tokens exist. */
export function agentForToken(tokens: Map<string, string>, given: string): string | undefined {
  if (!given) return undefined;
  const g = digest(given);
  let found: string | undefined;
  for (const [token, agent] of tokens) if (timingSafeEqual(g, digest(token)) && !found) found = agent;
  return found;
}

const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const NAMED_CLAIMS = ["iss", "aud", "sub", "azp", "client_id"];
const clip = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 200 ? `${s.slice(0, 200)}...` : s;
};

/**
 * Temporary, to learn what Studio's "Agent token" option sends: one line with the JWT's claim names and a few
 * claim values. Never includes the token, its header, or its signature.
 */
export function describeJwt(token: string): string | null {
  if (!JWT.test(token)) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
  const c = claims as Record<string, unknown>;
  const names = Object.keys(c).slice(0, 100);
  const values = Object.fromEntries(names.filter((k) => NAMED_CLAIMS.includes(k) || /agent/i.test(k)).map((k) => [k, clip(c[k])]));
  return `mcp: unknown bearer is a JWT; claims=${JSON.stringify(names)} values=${JSON.stringify(values)}`;
}

/**
 * Studio calls this with one token per agent, either as a bearer header on /mcp or in the path on /mcp/:agentToken
 * (Studio's custom MCP form can't set headers). A path token wins over any Authorization header.
 * The path token must never be logged.
 */
export async function handleMcp(db: DB, deps: Deps, req: Request, res: Response): Promise<void> {
  const pathToken = typeof req.params?.agentToken === "string" ? req.params.agentToken : "";
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const agent = agentForToken(deps.agentTokens, pathToken || bearer);
  if (!agent) {
    if (!pathToken) {
      const line = describeJwt(bearer);
      if (line) console.log(line);
    }
    res.status(401).json({ error: "unknown agent token" });
    return;
  }
  const server = buildServer(db, deps, agent);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
