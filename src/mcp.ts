import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response } from "express";
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

/** Studio registers this endpoint with a static bearer token per agent; the token decides who the caller is. */
export async function handleMcp(db: DB, deps: Deps, req: Request, res: Response): Promise<void> {
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const agent = token ? deps.agentTokens.get(token) : undefined;
  if (!agent) {
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
