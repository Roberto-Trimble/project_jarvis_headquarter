import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentForToken, describeJwt } from "../src/mcp.ts";
import { createApp } from "../src/server.ts";
import { setup } from "./helpers.ts";

let server: Server;
let url: string;
let logged: string[];

beforeEach(async () => {
  const { db, deps } = await setup();
  server = createApp(db, deps).listen(0);
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  logged = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
  }
});

afterEach(() => {
  server.close();
  vi.restoreAllMocks();
});

async function rpc(path: string, method: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
  });
  const text = await res.text();
  const data = text.split("\n").filter((l) => l.startsWith("data:")).at(-1)?.slice(5) ?? text;
  return { status: res.status, body: data ? JSON.parse(data) : null };
}

async function toolNames(path: string, headers: Record<string, string> = {}) {
  const r = await rpc(path, "tools/list", headers);
  expect(r.status).toBe(200);
  return (r.body.result.tools as { name: string }[]).map((t) => t.name);
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

function jwt(claims: object) {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT", kid: "key-1" })}.${part(claims)}.c2lnbmF0dXJlLXNlZ21lbnQtbm90LWZvci1sb2dz`;
}

describe("/mcp with a bearer header", () => {
  it("serves the caller's role tools for a valid token", async () => {
    const builder = await toolNames("/mcp", bearer("builder-token"));
    expect(builder).toEqual(expect.arrayContaining(["get_profile", "claim_task"]));
    expect(builder).not.toContain("merge_pull_request");
    expect(await toolNames("/mcp", bearer("pm-token"))).toContain("merge_pull_request");
  });

  it("returns 401 for an unknown or missing token", async () => {
    expect((await rpc("/mcp", "tools/list", bearer("nope"))).status).toBe(401);
    expect((await rpc("/mcp", "tools/list")).status).toBe(401);
  });
});

describe("/mcp/:agentToken", () => {
  it("serves the caller's role tools for a valid path token", async () => {
    const builder = await toolNames("/mcp/builder-token");
    expect(builder).toEqual(expect.arrayContaining(["get_profile", "claim_task"]));
    expect(builder).not.toContain("merge_pull_request");
    expect(await toolNames("/mcp/pm-token")).toContain("merge_pull_request");
  });

  it("returns 401 for an unknown path token", async () => {
    expect(await rpc("/mcp/nope", "tools/list")).toEqual({ status: 401, body: { error: "unknown agent token" } });
  });

  it("uses the path token over any Authorization header", async () => {
    const tools = await toolNames("/mcp/builder-token", bearer("pm-token"));
    expect(tools).not.toContain("merge_pull_request");
    expect((await rpc("/mcp/nope", "tools/list", bearer("pm-token"))).status).toBe(401);
    expect((await rpc("/mcp/nope", "tools/list", bearer(jwt({ iss: "studio" })))).status).toBe(401);
  });

  it("answers GET with 405", async () => {
    expect((await fetch(`${url}/mcp/builder-token`)).status).toBe(405);
  });

  it("never logs the path token", async () => {
    await rpc("/mcp/builder-token", "tools/list");
    await rpc("/mcp/nope-secret-path", "tools/list", bearer(jwt({ iss: "studio" })));
    await fetch(`${url}/mcp/builder-token`);
    expect(logged.join("\n")).not.toMatch(/builder-token|nope-secret-path/);
    expect(logged).toEqual([]);
  });
});

describe("unknown JWT bearer on /mcp (temporary claim logging)", () => {
  it("logs claim names and selected values once, never the token, and still returns 401", async () => {
    const token = jwt({
      iss: "https://login.example/tenant", aud: ["api://jarvis"], sub: "user-1", azp: "studio-app",
      client_id: "client-9", agent_id: "agent-42", studioAgentName: "Builder", exp: 1, scp: "mcp",
    });
    const [header, , signature] = token.split(".");
    expect((await rpc("/mcp", "tools/list", bearer(token))).status).toBe(401);

    expect(logged).toHaveLength(1);
    const line = logged[0];
    expect(line).toContain('claims=["iss","aud","sub","azp","client_id","agent_id","studioAgentName","exp","scp"]');
    for (const v of ["https://login.example/tenant", "api://jarvis", "user-1", "studio-app", "client-9", "agent-42", "Builder"]) {
      expect(line).toContain(v);
    }
    expect(line).not.toContain('"scp":');
    expect(line).not.toContain(token);
    expect(line).not.toContain(header);
    expect(line).not.toContain(signature);
    expect(line).not.toContain(token.split(".")[1]);
  });

  it("logs nothing for a non-JWT unknown token or a valid agent token", async () => {
    await rpc("/mcp", "tools/list", bearer("plain-unknown-token"));
    await rpc("/mcp", "tools/list", bearer("builder-token"));
    expect(logged).toEqual([]);
  });

  it("describeJwt ignores malformed tokens", () => {
    expect(describeJwt("a.b")).toBeNull();
    expect(describeJwt("not-base64!.x.y")).toBeNull();
    expect(describeJwt(`${Buffer.from("{}").toString("base64url")}.${Buffer.from("[1]").toString("base64url")}.s`)).toBeNull();
  });
});

describe("agentForToken", () => {
  it("matches exactly and rejects empty, prefix, and longer tokens", () => {
    const tokens = new Map([["abc", "builder"], ["xyz", "verifier"]]);
    expect(agentForToken(tokens, "abc")).toBe("builder");
    expect(agentForToken(tokens, "xyz")).toBe("verifier");
    for (const t of ["", "ab", "abcd", "ABC"]) expect(agentForToken(tokens, t)).toBeUndefined();
  });
});
