/**
 * Order Up MCP server: exposes tools to trigger agents for tracked PRs.
 * Works with Cursor IDE, Claude Code, or any MCP-compatible client.
 * Reads config/settings.json to determine which tool adapter to use.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync } from "fs";

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
const SETTINGS_PATH = join(ROOT, "config", "settings.json");

type ToolProfile = "cursor-ide" | "cursor-web" | "claude-code" | "generic";

function readToolSetting(): ToolProfile {
  try {
    const raw = readFileSync(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as { tool?: string };
    const valid: ToolProfile[] = ["cursor-ide", "cursor-web", "claude-code", "generic"];
    return valid.includes(parsed.tool as ToolProfile) ? (parsed.tool as ToolProfile) : "cursor-ide";
  } catch {
    return "cursor-ide";
  }
}

function runAgent(repo: string, number: number, check?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const args = [repo, String(number)];
    if (check) args.push(check);
    const proc = spawn(RUN_AGENT_SCRIPT, args, { cwd: ROOT, shell: true });
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
    name: "order-up",
    version: "1.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.tool(
  "trigger_agent_for_pr",
  "Run the configured AI agent (Cursor, Claude Code, etc.) in the initiative folder that owns this PR to fix checks and comments.",
  {
    repo: z.string().describe("GitHub repo in owner/name form, e.g. FrontRowXP/nugs"),
    number: z.number().int().positive().describe("PR number"),
    check: z.string().optional().describe("Optional: focus on a specific check category (lint, type, test, e2e, other)"),
  },
  async ({ repo, number, check }) => {
    const tool = readToolSetting();
    const result = await runAgent(repo, number, check);
    const toolLabel = tool === "claude-code" ? "Claude Code" : tool === "cursor-ide" ? "Cursor" : tool;
    const text = result.ok
      ? `${toolLabel} agent started for ${repo}#${number}${check ? ` (${check})` : ""}.\n${result.stdout}`
      : `Agent failed for ${repo}#${number}.\n${result.stderr || result.stdout}`;
    return {
      content: [{ type: "text" as const, text }],
      isError: !result.ok,
    };
  }
);

server.tool(
  "get_tool_setting",
  "Get the current tool preference (cursor-ide, cursor-web, claude-code, generic).",
  {},
  async () => {
    const tool = readToolSetting();
    return {
      content: [{ type: "text" as const, text: `Current tool: ${tool}` }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
