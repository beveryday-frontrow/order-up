/**
 * pr-watcher MCP server: exposes tools to trigger the Cursor agent for tracked PRs.
 * Use from Cursor (add this server in MCP settings) or from any MCP client.
 * When GH events come in, call trigger_agent_for_pr(repo, number) to run the agent in the owning initiative folder.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findRoot(): string {
  const candidates = [join(__dirname, ".."), process.cwd(), join(process.cwd(), "..")];
  for (const r of candidates) {
    const p = join(r, "config", "tracking.json");
    if (existsSync(p)) return r;
  }
  return join(__dirname, "..");
}

const ROOT = findRoot();
const RUN_AGENT_SCRIPT = join(ROOT, "scripts", "run-agent-for-pr.sh");

function runAgent(repo: string, number: number): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(RUN_AGENT_SCRIPT, [repo, String(number)], { cwd: ROOT, shell: true });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => (stdout += d.toString()));
    proc.stderr?.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

const server = new McpServer(
  {
    name: "pr-watcher",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.tool(
  "trigger_agent_for_pr",
  "Run the Cursor agent in the initiative folder that owns this PR (fix checks and comments).",
  {
    repo: z.string().describe("GitHub repo in owner/name form, e.g. FrontRowXP/nugs"),
    number: z.number().int().positive().describe("PR number"),
  },
  async ({ repo, number }) => {
    const result = await runAgent(repo, number);
    const text = result.ok
      ? `Agent started for ${repo}#${number}.\n${result.stdout}`
      : `Agent failed for ${repo}#${number}.\n${result.stderr || result.stdout}`;
    return {
      content: [{ type: "text" as const, text }],
      isError: !result.ok,
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
