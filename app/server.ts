import express from "express";
import { readFile, writeFile, mkdir, rm } from "fs/promises";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// SSE clients for real-time updates
interface SSEClient {
  id: number;
  res: express.Response;
}
const sseClients: SSEClient[] = [];
let sseClientId = 0;

function broadcastSSE(event: string, data: unknown) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  let sentCount = 0;
  for (const client of sseClients) {
    try {
      client.res.write(message);
      sentCount++;
    } catch {
      // Client disconnected, will be cleaned up
    }
  }
  if (event === "agent-status" || event === "agent-stream" || event === "agent-complete" || event === "agent-session-created") {
    console.log(`[SSE Broadcast] Sent '${event}' to ${sentCount}/${sseClients.length} clients`);
  }
}

// Resolve pr-watcher root (config/tracking.json and scripts/ live here)
function findRoot(): string {
  // Prefer the actual project directory over bundled app resources
  const projectRoot = join(process.env.HOME || "/tmp", "Projects", "order-up");
  const candidates = [
    projectRoot,
    join(__dirname, ".."),
    process.cwd(),
    join(process.cwd(), ".."),
  ];
  // When running inside Electron app bundle, __dirname may be inside .asar.unpacked
  // Also check the original project location
  if (__dirname.includes("app.asar")) {
    candidates.unshift(projectRoot);
  }
  for (const r of candidates) {
    const p = join(r, "config", "tracking.json");
    if (existsSync(p)) return r;
  }
  return join(__dirname, "..");
}
const ROOT = findRoot();
const CONFIG_PATH = join(ROOT, "config", "tracking.json");
const SETTINGS_PATH = join(ROOT, "config", "settings.json");
const GET_PR_STATUS = join(ROOT, "scripts", "lib", "get-pr-status.sh");
const RUN_AGENT_SCRIPT = join(ROOT, "scripts", "run-agent-for-pr.sh");

type ToolProfile = "cursor-ide" | "cursor-web" | "claude-code" | "generic";
const VALID_TOOLS: ToolProfile[] = ["cursor-ide", "cursor-web", "claude-code", "generic"];

interface SettingsConfig {
  tool: ToolProfile;
  agentCommand: string | null;
}

async function readSettings(): Promise<SettingsConfig> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SettingsConfig>;
    return {
      tool: VALID_TOOLS.includes(parsed.tool as ToolProfile) ? (parsed.tool as ToolProfile) : "cursor-ide",
      agentCommand: typeof parsed.agentCommand === "string" ? parsed.agentCommand : null,
    };
  } catch {
    return { tool: "cursor-ide", agentCommand: null };
  }
}

async function writeSettings(settings: SettingsConfig): Promise<void> {
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

/** Whether this tool profile supports background agent spawning. */
function canSpawnAgent(tool: ToolProfile): boolean {
  return tool === "cursor-ide" || tool === "claude-code";
}

/** Build the prompt string that an agent would receive for a PR fix. */
function buildAgentPrompt(repo: string, number: number, check?: string): string {
  let focus: string;
  switch (check) {
    case "lint":
      focus = "Fix only the failing **Lint** CI checks (lint, eslint, biome, prettier).";
      break;
    case "type":
      focus = "Fix only the failing **Type** CI checks (typecheck, tsc).";
      break;
    case "test":
      focus = "Fix only the failing **Test** CI checks (unit tests, jest, vitest, coverage).";
      break;
    case "e2e":
      focus = "Fix only the failing **E2E** CI checks (playwright, cypress, end-to-end).";
      break;
    case "other":
      focus = "Fix only the failing **Other** CI checks (non-lint/type/test/e2e).";
      break;
    case "comments":
      focus = "Address all unresolved review comments.";
      break;
    default:
      focus = "Fix all failing CI checks and address all unresolved review comments.";
      break;
  }
  return `Handle PR #${number} in ${repo}: ${focus} Use \`gh\` and the pr-manager / handle-pr-comments workflow. Push fixes and re-check. Work in the subfolder for this repo if needed.`;
}

interface TrackingConfig {
  initiatives: Record<
    string,
    { path: string; description: string; prs?: { repo: string; number: number; branch?: string }[] }
  >;
  repoToSubfolder?: Record<string, string>;
  updatedAt?: string;
  /** GitHub org for cloning new/ensure initiative folders. Overrides GITHUB_ORG env. */
  githubOrg?: string;
  /** Repo names to clone into each food project (subfolder = repo name). Overrides default list. */
  foodProjectRepos?: string[];
}

type CheckCategory = "lint" | "type" | "test" | "e2e" | "other";
type CategoryStatus = "success" | "failure" | "pending" | null;

interface PreviewUrls {
  viewer?: string;
  creator?: string;
  storybook?: string;
}

type PreviewDeployState = "pending" | "building" | "deployed" | "failed";

interface PreviewDeployStatus {
  viewer?: PreviewDeployState;
  creator?: PreviewDeployState;
  storybook?: PreviewDeployState;
}

interface PRStatus {
  repo: string;
  number: number;
  branch?: string;
  title: string;
  failingChecks: number;
  unresolved: number;
  checks: { lint: CategoryStatus; type: CategoryStatus; test: CategoryStatus; e2e: CategoryStatus; other: CategoryStatus };
  previews?: PreviewUrls;
  previewDeployStatus?: PreviewDeployStatus;
  initiativePath?: string;
  initiativeName?: string;
  /** true = no conflicts, false = has conflicts, null = unknown */
  mergeable?: boolean | null;
  mergeStateStatus?: string;
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or empty */
  reviewDecision?: string;
}

interface InitiativeStatus {
  name: string;
  description: string;
  path: string;
  prs: PRStatus[];
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd: ROOT, shell: true });
    let out = "";
    let err = "";
    proc.stdout?.on("data", (d) => (out += d.toString()));
    proc.stderr?.on("data", (d) => (err += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0 && code !== 1) reject(new Error(err || `exit ${code}`));
      else resolve(out.trim());
    });
  });
}

/** Like run() but always resolves with stdout (never rejects on exit code). Use when we want to parse output even on 4xx. */
function runAllowExit(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd: ROOT, shell: true });
    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString()));
    proc.stderr?.on("data", () => {}); // ignore stderr
    proc.on("close", () => resolve(out.trim()));
  });
}

/** Run a command in a specific cwd; always resolves with stdout. */
function runAllowExitCwd(cwd: string, cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd, shell: true });
    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString()));
    proc.stderr?.on("data", () => {}); // ignore stderr
    proc.on("close", () => resolve(out.trim()));
  });
}

const LOCAL_SUBFOLDERS = ["backend", "nugs", "frontrow-creator-ios", "frontrow-creator-android"] as const;

/** Parse git remote URL to owner/repo (e.g. https://github.com/owner/repo.git or git@github.com:owner/repo.git). */
function parseGitRemoteUrl(url: string): string | null {
  const u = (url || "").trim();
  const ssh = u.match(/^git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const https = u.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (https) return `${https[1]}/${https[2]}`;
  return null;
}

/** Get current branch and GitHub repo for a subfolder under an initiative path. */
async function getLocalBranchAndRepo(
  initPath: string,
  subfolder: string
): Promise<{ branch: string; repo: string } | null> {
  const dir = join(initPath, subfolder);
  if (!existsSync(join(dir, ".git"))) return null;
  const branch = await runAllowExitCwd(dir, "git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch) return null;
  const remote = await runAllowExitCwd(dir, "git", ["remote", "get-url", "origin"]);
  const repo = parseGitRemoteUrl(remote);
  if (!repo) return null;
  return { branch, repo };
}

/** List my open PRs for a repo. Returns { number, title, headRefName }[]. */
async function listMyOpenPRs(repo: string): Promise<{ number: number; title: string; headRefName: string }[]> {
  const out = await runAllowExit("gh", [
    "pr",
    "list",
    "--repo",
    repo,
    "--author",
    "@me",
    "--state",
    "open",
    "--json",
    "number,title,headRefName",
    "--limit",
    "50",
  ]);
  if (!out) return [];
  try {
    const arr = JSON.parse(out) as { number: number; title: string; headRefName: string }[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/** List all my open PRs across all repos via GitHub search API. Returns { repo, number, title, headRefName }[]. */
async function listAllMyOpenPRs(): Promise<{ repo: string; number: number; title: string; headRefName: string }[]> {
  const userOut = await runAllowExit("gh", ["api", "user", "-q", ".login"]);
  const user = (userOut || "").trim();
  if (!user) return [];
  const q = encodeURIComponent(`author:${user} type:pr state:open`);
  const out = await runAllowExit("gh", [
    "api",
    `search/issues?q=${q}&per_page=100&sort=updated`,
  ]);
  if (!out) return [];
  try {
    const data = JSON.parse(out) as { items?: { number: number; title: string; repository_url?: string; head?: { ref?: string } }[] };
    const items = Array.isArray(data?.items) ? data.items : [];
    const result: { repo: string; number: number; title: string; headRefName: string }[] = [];
    for (const item of items) {
      const url = item.repository_url || "";
      const match = url.match(/\/repos\/([^/]+\/[^/]+?)(?:\/|$)/);
      const repo = match ? match[1] : "";
      if (!repo) continue;
      result.push({
        repo,
        number: item.number,
        title: item.title || "",
        headRefName: item.head?.ref ?? "",
      });
    }
    return result;
  } catch {
    return [];
  }
}

/** Get PR number and title for a branch in a repo, if one exists. */
async function getPRForBranch(repo: string, branch: string): Promise<{ number: number; title: string } | null> {
  const out = await runAllowExit("gh", [
    "pr",
    "view",
    "--repo",
    repo,
    "--head",
    branch,
    "--json",
    "number,title",
  ]);
  if (!out) return null;
  try {
    const data = JSON.parse(out) as { number?: number; title?: string };
    const number = data?.number;
    const title = data?.title;
    if (number == null || typeof title !== "string") return null;
    return { number, title };
  } catch {
    return null;
  }
}

interface LocalBranchRow {
  initiative: string;
  path: string;
  subfolder: string;
  branch: string;
  repo: string;
  prNumber: number | null;
  prTitle: string | null;
}

async function getPRStatus(repo: string, number: number): Promise<{ failingChecks: number; unresolved: number }> {
  const [owner, repoName] = repo.split("/");
  const out = await run(GET_PR_STATUS, [owner, repoName, String(number)]).catch(() => "failing_checks=0 unresolved=0");
  const failing = parseInt(out.match(/failing_checks=(\d+)/)?.[1] ?? "0", 10);
  const unresolved = parseInt(out.match(/unresolved=(\d+)/)?.[1] ?? "0", 10);
  return { failingChecks: failing, unresolved };
}

async function getPRTitle(repo: string, number: number): Promise<string> {
  const out = await run("gh", ["pr", "view", String(number), "--repo", repo, "--json", "title", "-q", ".title"]).catch(
    () => ""
  );
  return out || `PR #${number}`;
}

/** Get PR title and head branch name (one gh pr view call). */
async function getPRTitleAndHead(
  repo: string,
  number: number
): Promise<{ title: string; headRefName: string }> {
  const out = await runAllowExit("gh", [
    "pr",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    "title,headRefName",
  ]);
  if (!out) return { title: `PR #${number}`, headRefName: "" };
  try {
    const data = JSON.parse(out) as { title?: string; headRefName?: string };
    return {
      title: typeof data.title === "string" ? data.title : `PR #${number}`,
      headRefName: typeof data.headRefName === "string" ? data.headRefName : "",
    };
  } catch {
    return { title: `PR #${number}`, headRefName: "" };
  }
}

/** Get PR merge state (mergeable, mergeStateStatus, reviewDecision). mergeable false = conflicts. */
async function getPRMergeState(
  repo: string,
  number: number
): Promise<{ mergeable: boolean | null; mergeStateStatus: string; reviewDecision: string }> {
  const out = await runAllowExit("gh", [
    "pr",
    "view",
    String(number),
    "--repo",
    repo,
    "--json",
    "mergeable,mergeStateStatus,reviewDecision",
  ]);
  if (!out) return { mergeable: null, mergeStateStatus: "", reviewDecision: "" };
  try {
    const data = JSON.parse(out) as { mergeable?: boolean | null; mergeStateStatus?: string; reviewDecision?: string };
    return {
      mergeable: data.mergeable === true ? true : data.mergeable === false ? false : null,
      mergeStateStatus: typeof data.mergeStateStatus === "string" ? data.mergeStateStatus : "",
      reviewDecision: typeof data.reviewDecision === "string" ? data.reviewDecision : "",
    };
  } catch {
    return { mergeable: null, mergeStateStatus: "", reviewDecision: "" };
  }
}

/** Parse preview URLs from a PR comment body (viewer, creator, storybook). */
function parsePreviewUrlsFromBody(body: string): PreviewUrls {
  const out: PreviewUrls = {};
  if (!body || typeof body !== "string") return out;
  const lower = body.toLowerCase();
  // Prefer markdown links: [Viewer](url), [Creator](url), [Storybook](url)
  const markdownLink = /\[([^\]]*?)\]\s*\(\s*(https:\/\/[^)\s]+)\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = markdownLink.exec(body)) !== null) {
    const label = (m[1] || "").trim().toLowerCase();
    const url = m[2].trim();
    if (/viewer/.test(label) && !out.viewer) out.viewer = url;
    else if (/creator/.test(label) && !out.creator) out.creator = url;
    else if (/storybook/.test(label) && !out.storybook) out.storybook = url;
  }
  // Fallback: lines containing keyword then URL (e.g. "**Viewer:** https://...")
  const urlRe = /https:\/\/[^\s)\]">]+/g;
  const lines = body.split(/\n/);
  for (const line of lines) {
    const lineLower = line.toLowerCase();
    const urls = line.match(urlRe) || [];
    const firstUrl = urls[0];
    if (!firstUrl) continue;
    if (/viewer/.test(lineLower) && !out.viewer) out.viewer = firstUrl;
    else if (/creator/.test(lineLower) && !out.creator) out.creator = firstUrl;
    else if (/storybook/.test(lineLower) && !out.storybook) out.storybook = firstUrl;
  }
  return out;
}

/** Fetch PR issue comments and return preview URLs from the preview comment. */
async function getPRPreviewUrls(repo: string, number: number): Promise<PreviewUrls> {
  const [owner, repoName] = repo.split("/");
  const out = await runAllowExit("gh", [
    "api",
    `repos/${owner}/${repoName}/issues/${number}/comments?per_page=100`,
  ]);
  if (!out) return {};
  let comments: { body?: string }[] = [];
  try {
    comments = JSON.parse(out) as { body?: string }[];
  } catch {
    return {};
  }
  for (const c of comments) {
    const body = c.body ?? "";
    const parsed = parsePreviewUrlsFromBody(body);
    if (parsed.viewer || parsed.creator || parsed.storybook) return parsed;
  }
  return {};
}

function categorizeCheck(name: string): CheckCategory {
  const n = name.toLowerCase();
  if (/lint|eslint|biome|prettier/.test(n)) return "lint";
  if (/type|typecheck|tsc/.test(n)) return "type";
  if (/e2e|playwright|cypress|end-to-end|p0tests|p1tests/.test(n)) return "e2e";
  if (/test|jest|vitest|coverage|unit/.test(n)) return "test";
  return "other";
}

interface CheckCategoriesResult {
  checks: PRStatus["checks"];
  previewDeployStatus: PreviewDeployStatus;
}

async function getPRCheckCategories(repo: string, number: number): Promise<CheckCategoriesResult> {
  const emptyChecks: PRStatus["checks"] = {
    lint: null,
    type: null,
    test: null,
    e2e: null,
    other: null,
  };
  const emptyResult: CheckCategoriesResult = { checks: emptyChecks, previewDeployStatus: {} };
  const [owner, repoName] = repo.split("/");
  const shaOut = await runAllowExit("gh", ["pr", "view", String(number), "--repo", repo, "--json", "headRefOid", "-q", ".headRefOid"]);
  const sha = shaOut?.trim();
  if (!sha) return emptyResult;
  
  type Run = { name: string; conclusion: string | null; status: string };
  const runs: Run[] = [];
  let page = 1;
  const maxPages = 10; // Safety limit
  
  // Paginate through all check runs
  while (page <= maxPages) {
    const out = await runAllowExit("gh", [
      "api",
      `repos/${owner}/${repoName}/commits/${sha}/check-runs?per_page=100&page=${page}`,
    ]);
    
    if (!out) break;
    
    try {
      const data = JSON.parse(out) as { check_runs?: Run[] };
      const pageRuns = Array.isArray(data.check_runs) ? data.check_runs : [];
      runs.push(...pageRuns);
      
      // If we got less than 100, we've reached the end
      if (pageRuns.length < 100) break;
      page++;
    } catch {
      break;
    }
  }
  
  const byCat: Record<CheckCategory, { success: number; failure: number; pending: number }> = {
    lint: { success: 0, failure: 0, pending: 0 },
    type: { success: 0, failure: 0, pending: 0 },
    test: { success: 0, failure: 0, pending: 0 },
    e2e: { success: 0, failure: 0, pending: 0 },
    other: { success: 0, failure: 0, pending: 0 },
  };

  // Track preview deployment check runs separately
  const previewDeploy: PreviewDeployStatus = {};

  for (const r of runs) {
    // Check if this is a preview deployment run
    const previewType = categorizePreviewDeploy(r.name);
    if (previewType) {
      const state = checkRunToDeployState(r);
      // For each preview type, take the most "active" state:
      // building > pending > failed > deployed (i.e., if any job is still building, show building)
      const current = previewDeploy[previewType];
      if (!current || deployStatePriority(state) > deployStatePriority(current)) {
        previewDeploy[previewType] = state;
      }
    }

    const cat = categorizeCheck(r.name);
    if (r.status !== "completed") byCat[cat].pending++;
    else if (r.conclusion === "success" || r.conclusion === "skipped" || r.conclusion === "neutral") byCat[cat].success++;
    else if (r.conclusion === "failure" || r.conclusion === "timed_out" || r.conclusion === "cancelled" || r.conclusion === "action_required") byCat[cat].failure++;
    // Ignore other conclusions (stale, etc.) — don't count as failure
  }
  const toStatus = (c: { success: number; failure: number; pending: number }): CategoryStatus => {
    if (c.failure > 0) return "failure";
    if (c.pending > 0) return "pending";
    if (c.success > 0) return "success";
    return null;
  };
  return {
    checks: {
      lint: toStatus(byCat.lint),
      type: toStatus(byCat.type),
      test: toStatus(byCat.test),
      e2e: toStatus(byCat.e2e),
      other: toStatus(byCat.other),
    },
    previewDeployStatus: previewDeploy,
  };
}

// Identify if a check run is a preview deployment and which type
function categorizePreviewDeploy(name: string): keyof PreviewDeployStatus | null {
  const n = name.toLowerCase();
  // Match storybook first (more specific) before viewer/creator
  if (/storybook/.test(n) && /preview|deploy/.test(n)) return "storybook";
  if (/preview/.test(n) && /viewer/.test(n)) return "viewer";
  if (/preview/.test(n) && /creator/.test(n)) return "creator";
  // Also match deploy workflow names
  if (/deploy\s*preview.*viewer/i.test(n)) return "viewer";
  if (/deploy\s*preview.*creator/i.test(n)) return "creator";
  return null;
}

// Map a check run's status/conclusion to a deploy state
function checkRunToDeployState(run: { status: string; conclusion: string | null }): PreviewDeployState {
  if (run.status === "queued" || run.status === "waiting") return "pending";
  if (run.status === "in_progress") return "building";
  if (run.status === "completed") {
    if (run.conclusion === "success" || run.conclusion === "skipped" || run.conclusion === "neutral") return "deployed";
    return "failed";
  }
  return "pending";
}

// Priority for merging multiple check runs of the same preview type
function deployStatePriority(state: PreviewDeployState): number {
  switch (state) {
    case "building": return 3;
    case "pending": return 2;
    case "failed": return 1;
    case "deployed": return 0;
  }
}

// Webhook and API need JSON body
app.use(express.json({ limit: "20mb" }));

// GET /api/settings — read tool preference
app.get("/api/settings", async (_req, res) => {
  const settings = await readSettings();
  res.json(settings);
});

// POST /api/settings — update tool preference
app.post("/api/settings", async (req, res) => {
  const current = await readSettings();
  const tool = req.body?.tool;
  const agentCommand = req.body?.agentCommand;
  if (tool != null) {
    if (!VALID_TOOLS.includes(tool)) {
      res.status(400).json({ error: `tool must be one of: ${VALID_TOOLS.join(", ")}` });
      return;
    }
    current.tool = tool;
  }
  if (agentCommand !== undefined) {
    current.agentCommand = typeof agentCommand === "string" && agentCommand.trim() ? agentCommand.trim() : null;
  }
  await writeSettings(current);
  res.json(current);
});

const FIX_CHECK_CATEGORIES = ["lint", "type", "test", "e2e", "other"] as const;

// Fetch fresh PR data for a single PR (reusable for API and webhook broadcasts)
async function fetchPRData(repo: string, num: number): Promise<PRStatus | null> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const config: TrackingConfig = JSON.parse(raw);
    const localBranches: LocalBranchRow[] = [];
    for (const [initName, init] of Object.entries(config.initiatives)) {
      const initPath = init.path;
      if (!initPath || !existsSync(initPath)) continue;
      for (const subfolder of LOCAL_SUBFOLDERS) {
        const dir = join(initPath, subfolder);
        if (!existsSync(dir)) continue;
        const branchAndRepo = await getLocalBranchAndRepo(initPath, subfolder);
        if (!branchAndRepo) continue;
        const { branch, repo: r } = branchAndRepo;
        const pr = await getPRForBranch(r, branch);
        localBranches.push({
          initiative: initName,
          path: initPath,
          subfolder,
          branch,
          repo: r,
          prNumber: pr?.number ?? null,
          prTitle: pr?.title ?? null,
        });
      }
    }
    const repoAndBranchToInitiative = new Map<string, { path: string; name: string }>();
    for (const lb of localBranches) {
      repoAndBranchToInitiative.set(`${lb.repo}#${lb.branch}`, { path: lb.path, name: lb.initiative });
    }
    const [status, titleAndHead, checkResult, previews, mergeState] = await Promise.all([
      getPRStatus(repo, num),
      getPRTitleAndHead(repo, num),
      getPRCheckCategories(repo, num),
      getPRPreviewUrls(repo, num),
      getPRMergeState(repo, num),
    ]);
    const headRefName = titleAndHead.headRefName || "";
    const init = repoAndBranchToInitiative.get(`${repo}#${headRefName}`);
    const hasPreviews = previews.viewer || previews.creator || previews.storybook;
    const hasDeployStatus = checkResult.previewDeployStatus.viewer || checkResult.previewDeployStatus.creator || checkResult.previewDeployStatus.storybook;
    return {
      repo,
      number: num,
      branch: headRefName,
      title: titleAndHead.title,
      failingChecks: status.failingChecks,
      unresolved: status.unresolved,
      checks: checkResult.checks,
      previews: hasPreviews ? previews : undefined,
      previewDeployStatus: hasDeployStatus ? checkResult.previewDeployStatus : undefined,
      initiativePath: init?.path,
      initiativeName: init?.name,
      mergeable: mergeState.mergeable,
      mergeStateStatus: mergeState.mergeStateStatus,
      reviewDecision: mergeState.reviewDecision,
    };
  } catch {
    return null;
  }
}

// GET /api/pr?repo=...&number=... — fetch status for a single PR (for row refresh)
app.get("/api/pr", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const repo = req.query.repo as string;
  const number = req.query.number;
  const num = typeof number === "string" ? parseInt(number, 10) : Number(number);
  if (!repo || !Number.isInteger(num)) {
    res.status(400).json({ error: "Missing or invalid repo or number" });
    return;
  }
  const pr = await fetchPRData(repo, num);
  if (pr) {
    res.json({ pr });
  } else {
    res.status(500).json({ error: "Failed to fetch PR data" });
  }
});

// POST /api/fix-check — trigger agent to fix a specific check category for a PR
app.post("/api/fix-check", async (req, res) => {
  const repo = req.body?.repo;
  const number = req.body?.number;
  const check = req.body?.check;
  const path = req.body?.path;
  if (typeof repo !== "string" || !repo || typeof number !== "number" || !Number.isInteger(number)) {
    res.status(400).json({ error: "Missing or invalid repo or number" });
    return;
  }
  if (check != null && (typeof check !== "string" || !(FIX_CHECK_CATEGORIES as readonly string[]).includes(check))) {
    res.status(400).json({ error: "check must be one of: lint, type, test, e2e, other" });
    return;
  }
  const settings = await readSettings();
  const prompt = buildAgentPrompt(repo, number, check || undefined);

  if (canSpawnAgent(settings.tool)) {
    const args = [repo, String(number)];
    if (check) args.push(check);
    if (typeof path === "string" && path.trim()) args.push(path.trim());
    spawn(RUN_AGENT_SCRIPT, args, { cwd: ROOT, shell: true, stdio: "ignore" }).unref();
    res.status(202).json({ accepted: true, message: "Fix agent started", tool: settings.tool });
  } else {
    // Non-spawnable tools: return the prompt for the user to copy
    const copyCommand = settings.tool === "cursor-web"
      ? `Use @handle-pr-checks for PR #${number} in ${repo}${check ? ` (focus: ${check})` : ""}`
      : prompt;
    res.json({ accepted: false, mode: "clipboard", tool: settings.tool, prompt, copyCommand });
  }
});

// POST /api/merge — merge a PR (repo + number). Uses squash merge. Only succeeds when PR is mergeable.
// Also checks if initiative has no more open PRs and cleans up if so.
app.post("/api/merge", async (req, res) => {
  const repo = req.body?.repo;
  const number = req.body?.number;
  const initiativeName = typeof req.body?.initiative === "string" ? req.body.initiative.trim() : "";
  if (typeof repo !== "string" || !repo || typeof number !== "number" || !Number.isInteger(number)) {
    res.status(400).json({ error: "Missing or invalid repo or number" });
    return;
  }
  try {
    console.log(`Merging PR #${number} in ${repo}...`);
    // Use --squash for squash merge, --delete-branch to clean up
    const result = await run("gh", ["pr", "merge", String(number), "--repo", repo, "--squash", "--delete-branch"]);
    console.log(`Merge result for PR #${number}:`, result);
    
    // Verify the PR is actually merged by checking its state
    const verifyOut = await runAllowExit("gh", ["pr", "view", String(number), "--repo", repo, "--json", "state"]);
    let merged = false;
    if (verifyOut) {
      try {
        const state = JSON.parse(verifyOut);
        if (state.state === "MERGED") {
          console.log(`PR #${number} confirmed merged`);
          merged = true;
        }
      } catch {}
    }
    if (!merged) merged = true; // gh pr merge is synchronous, trust it

    // Check if this was the last open PR for the initiative
    let initiativeRemoved = false;
    let removedInitiative = "";
    if (initiativeName && initiativeName !== "—") {
      try {
        // Check remaining open PRs for this initiative by scanning local branches
        const raw = await readFile(CONFIG_PATH, "utf-8");
        const config: TrackingConfig = JSON.parse(raw);
        const init = config.initiatives[initiativeName];
        if (init?.path) {
          // Count other open PRs in this initiative
          const allOpen = await listAllMyOpenPRs();
          const initPath = init.path;
          // Scan which branches are checked out in this initiative
          const initBranches: string[] = [];
          for (const subfolder of LOCAL_SUBFOLDERS) {
            const branchAndRepo = await getLocalBranchAndRepo(initPath, subfolder);
            if (branchAndRepo && branchAndRepo.branch !== "main" && branchAndRepo.branch !== "HEAD") {
              initBranches.push(`${branchAndRepo.repo}#${branchAndRepo.branch}`);
            }
          }
          // Check how many of those branches have open PRs (excluding the one we just merged)
          const remainingOpenPRs = allOpen.filter(
            (pr) => pr.number !== number && initBranches.includes(`${pr.repo}#${pr.headRefName}`)
          );
          console.log(`[Merge] Initiative "${initiativeName}" has ${remainingOpenPRs.length} remaining open PRs`);
          
          if (remainingOpenPRs.length === 0) {
            // No more open PRs - remove initiative from config and delete folder
            console.log(`[Merge] Removing initiative "${initiativeName}" - no more open PRs`);
            
            // Remove from config
            delete config.initiatives[initiativeName];
            config.updatedAt = new Date().toISOString();
            await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
            console.log(`[Merge] Removed "${initiativeName}" from tracking config`);
            
            // Delete initiative folder
            if (existsSync(initPath)) {
              await rm(initPath, { recursive: true, force: true });
              console.log(`[Merge] Deleted initiative folder: ${initPath}`);
            }
            
            // Delete initiative image
            const imagePath = join(__dirname, "public", "images", "initiatives", `${initiativeName}.png`);
            if (existsSync(imagePath)) {
              await rm(imagePath, { force: true });
              console.log(`[Merge] Deleted initiative image: ${imagePath}`);
            }
            
            initiativeRemoved = true;
            removedInitiative = initiativeName;
          }
        }
      } catch (e) {
        console.error(`[Merge] Error checking/removing initiative:`, e);
        // Don't fail the merge response for cleanup errors
      }
    }

    res.json({ merged: true, initiativeRemoved, removedInitiative });
  } catch (e) {
    console.error(`Merge failed for PR #${number}:`, e);
    res.status(400).json({ error: String(e) });
  }
});

// GET /api/pr-comments — fetch unresolved review comments for a PR
app.get("/api/pr-comments", async (req, res) => {
  const repo = req.query.repo as string;
  const number = req.query.number;
  const num = typeof number === "string" ? parseInt(number, 10) : Number(number);
  if (!repo || !Number.isInteger(num)) {
    res.status(400).json({ error: "Missing or invalid repo or number" });
    return;
  }
  try {
    const [owner, repoName] = repo.split("/");
    
    // Helper to run GraphQL query with pagination support
    async function fetchGraphQL(query: string, variables: Record<string, unknown>): Promise<string> {
      const body = JSON.stringify({ query, variables });
      return new Promise<string>((resolve) => {
        const proc = spawn("gh", ["api", "graphql", "--input", "-"], { cwd: ROOT });
        let out = "";
        proc.stdout?.on("data", (d) => (out += d.toString()));
        proc.stderr?.on("data", () => {});
        proc.on("close", () => resolve(out.trim()));
        proc.stdin?.write(body);
        proc.stdin?.end();
      });
    }
    
    interface ReviewThread {
      isResolved: boolean;
      path: string;
      line?: number;
      comments?: {
        nodes?: { body: string; author?: { login: string } }[];
      };
    }
    
    interface GraphQLResponse {
      data?: {
        repository?: {
          pullRequest?: {
            reviewThreads?: {
              pageInfo?: { hasNextPage: boolean; endCursor: string | null };
              nodes?: ReviewThread[];
            };
          };
        };
      };
    }
    
    // Paginated query to get all review threads
    const paginatedQuery = 'query($owner:String!, $repo:String!, $number:Int!, $cursor:String) { repository(owner:$owner, name:$repo) { pullRequest(number:$number) { reviewThreads(first:100, after:$cursor) { pageInfo { hasNextPage endCursor } nodes { isResolved path line comments(first:1) { nodes { body author { login } } } } } } } }';
    
    const allThreads: ReviewThread[] = [];
    let cursor: string | null = null;
    let pageCount = 0;
    const maxPages = 10; // Safety limit
    
    // Fetch all pages
    while (pageCount < maxPages) {
      const graphqlOut = await fetchGraphQL(paginatedQuery, { 
        owner, 
        repo: repoName, 
        number: num, 
        cursor 
      });
      
      if (!graphqlOut) {
        console.log(`PR #${num}: No GraphQL output received on page ${pageCount + 1}`);
        break;
      }
      
      try {
        const data = JSON.parse(graphqlOut) as GraphQLResponse;
        const reviewThreads = data.data?.repository?.pullRequest?.reviewThreads;
        const threads = reviewThreads?.nodes || [];
        allThreads.push(...threads);
        
        pageCount++;
        console.log(`PR #${num}: Page ${pageCount} - fetched ${threads.length} threads (total: ${allThreads.length})`);
        
        // Check if there are more pages
        if (reviewThreads?.pageInfo?.hasNextPage && reviewThreads?.pageInfo?.endCursor) {
          cursor = reviewThreads.pageInfo.endCursor;
        } else {
          break;
        }
      } catch (e) {
        console.error("Error parsing GraphQL response:", e, "Raw output:", graphqlOut?.substring(0, 500));
        break;
      }
    }
    
    const comments: { author: string; path: string; line?: number; body: string }[] = [];
    
    console.log(`PR #${num}: Found ${allThreads.length} total review threads`);
    for (const thread of allThreads) {
      // Only include unresolved threads
      if (!thread.isResolved) {
        const firstComment = thread.comments?.nodes?.[0];
        if (firstComment) {
          comments.push({
            author: firstComment.author?.login || "unknown",
            path: thread.path || "",
            line: thread.line,
            body: firstComment.body || "",
          });
        }
      }
    }
    console.log(`PR #${num}: ${comments.length} unresolved comments found`)
    
    res.json({ repo, number: num, comments });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/check-failures — fetch failure details for PR checks
app.get("/api/check-failures", async (req, res) => {
  const repo = req.query.repo as string;
  const number = req.query.number;
  const checkType = req.query.check as string | undefined; // lint, type, test, e2e, other
  const num = typeof number === "string" ? parseInt(number, 10) : Number(number);
  if (!repo || !Number.isInteger(num)) {
    res.status(400).json({ error: "Missing or invalid repo or number" });
    return;
  }
  try {
    const [owner, repoName] = repo.split("/");
    
    // Get the PR's head SHA
    const prOut = await runAllowExit("gh", ["pr", "view", String(num), "--repo", repo, "--json", "headRefOid"]);
    let headSha = "";
    try {
      const prData = JSON.parse(prOut) as { headRefOid?: string };
      headSha = prData.headRefOid || "";
    } catch {}
    
    if (!headSha) {
      res.json({ repo, number: num, failures: [] });
      return;
    }
    
    interface CheckRun {
      id: number;
      name: string;
      conclusion: string | null;
      status: string;
      output?: {
        title?: string;
        summary?: string;
        text?: string;
        annotations_count?: number;
      };
    }
    
    // Get check runs for this commit with pagination
    const allCheckRuns: CheckRun[] = [];
    let page = 1;
    const maxPages = 10; // Safety limit
    
    while (page <= maxPages) {
      const checksOut = await runAllowExit("gh", [
        "api",
        `repos/${owner}/${repoName}/commits/${headSha}/check-runs?per_page=100&page=${page}`,
      ]);
      
      if (!checksOut) break;
      
      try {
        const data = JSON.parse(checksOut) as { check_runs?: CheckRun[]; total_count?: number };
        const runs = data.check_runs || [];
        allCheckRuns.push(...runs);
        
        console.log(`PR #${num}: Check runs page ${page} - fetched ${runs.length} (total: ${allCheckRuns.length})`);
        
        // If we got less than 100, we've reached the end
        if (runs.length < 100) break;
        page++;
      } catch {
        break;
      }
    }
    
    const failures: { name: string; conclusion: string; summary?: string; annotations: { path: string; line?: number; message: string }[]; errors?: string[] }[] = [];
    
    // Filter to failed checks
    const failedRuns = allCheckRuns.filter(run => 
      run.conclusion === "failure" || run.conclusion === "cancelled" || run.conclusion === "timed_out"
    );
    
    // Optionally filter by check type
    console.log(`PR #${num}: ${failedRuns.length} failed runs out of ${allCheckRuns.length} total, filtering by checkType: ${checkType || 'none'}`);
    console.log(`PR #${num}: Failed run names:`, failedRuns.map(r => r.name));
    
    const filteredRuns = checkType ? failedRuns.filter(run => {
      const name = run.name.toLowerCase();
      let match = false;
      if (checkType === "lint") match = name.includes("lint") || name.includes("eslint") || name.includes("prettier");
      else if (checkType === "type") match = name.includes("type") || name.includes("tsc") || name.includes("typescript");
      else if (checkType === "test") match = name.includes("test") && !name.includes("e2e");
      else if (checkType === "e2e") match = name.includes("e2e") || name.includes("playwright") || name.includes("cypress");
      else match = true; // 'other' gets all
      console.log(`PR #${num}: Check "${run.name}" (${name}) matches "${checkType}": ${match}`);
      return match;
    }) : failedRuns;
    
    console.log(`PR #${num}: After filtering: ${filteredRuns.length} runs`);
    
    for (const run of filteredRuns) {
      let errorMessages: string[] = [];
      
      // Try to fetch job logs to get actual error messages
      try {
        const logsOut = await runAllowExit("gh", [
          "api",
          `repos/${owner}/${repoName}/actions/jobs/${run.id}/logs`,
        ]);
        
        if (logsOut) {
          // Parse the logs looking for error patterns
          const lines = logsOut.split('\n');
          const errors: string[] = [];
          
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            // Remove timestamp prefix (e.g., "2026-02-06T23:52:17.3841184Z ")
            const content = line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, '');
            
            // Look for common error patterns
            if (content.includes('[31m✖[39m') || // Red X in ANSI
                content.includes('✖') ||
                content.includes('Error:') ||
                content.includes('error TS') ||
                content.includes('FAILED:') ||
                content.match(/^\s*×/) ||
                content.match(/error\s+[A-Z]+\d+:/i)) {
              // Clean up ANSI codes
              const cleanLine = content
                .replace(/\[\d+m/g, '')
                .replace(/\[39m/g, '')
                .replace(/\[31m/g, '')
                .replace(/\[32m/g, '')
                .replace(/\[33m/g, '')
                .trim();
              if (cleanLine && cleanLine.length > 10 && !cleanLine.includes('##[error]Process completed')) {
                errors.push(cleanLine);
              }
            }
          }
          
          // Deduplicate and limit
          errorMessages = [...new Set(errors)].slice(0, 15);
        }
      } catch (e) {
        console.log(`Error fetching logs for ${run.name}:`, e);
      }
      
      // Also fetch annotations as fallback
      let annotations: { path: string; line?: number; message: string }[] = [];
      if (errorMessages.length === 0) {
        try {
          const annotationsOut = await runAllowExit("gh", [
            "api",
            `repos/${owner}/${repoName}/check-runs/${run.id}/annotations?per_page=50`,
          ]);
          
          interface Annotation {
            path: string;
            start_line?: number;
            annotation_level: string;
            message: string;
            title?: string;
          }
          
          const annotationsData = JSON.parse(annotationsOut) as Annotation[];
          annotations = annotationsData
            .filter(a => a.annotation_level === "failure" || a.annotation_level === "warning")
            .filter(a => !a.message?.includes("Process completed with exit code"))
            .slice(0, 10)
            .map(a => ({
              path: a.path,
              line: a.start_line,
              message: a.message || a.title || "",
            }));
        } catch {}
      }
      
      failures.push({
        name: run.name,
        conclusion: run.conclusion || "unknown",
        summary: run.output?.summary?.substring(0, 500),
        annotations,
        errors: errorMessages,
      });
    }
    
    res.json({ repo, number: num, failures });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /api/toggle-draft — convert PR to/from draft
app.post("/api/toggle-draft", async (req, res) => {
  const repo = req.body?.repo;
  const number = req.body?.number;
  const makeDraft = req.body?.makeDraft; // true = convert to draft, false = mark ready
  if (typeof repo !== "string" || !repo || typeof number !== "number" || !Number.isInteger(number)) {
    res.status(400).json({ error: "Missing or invalid repo or number" });
    return;
  }
  try {
    if (makeDraft) {
      // Convert to draft
      await run("gh", ["pr", "ready", String(number), "--repo", repo, "--undo"]);
    } else {
      // Mark as ready for review
      await run("gh", ["pr", "ready", String(number), "--repo", repo]);
    }
    res.json({ success: true, isDraft: makeDraft });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// POST /api/open-fork — open a folder in Fork git client
app.post("/api/open-fork", (req, res) => {
  const path = req.body?.path;
  if (typeof path !== "string" || !path.trim()) {
    res.status(400).json({ error: "Missing path" });
    return;
  }
  // Use 'open' command to open Fork with the specified path
  spawn("open", ["-a", "Fork", path.trim()], { stdio: "ignore" }).unref();
  res.json({ opened: true });
});

// POST /api/fix-all-issues — spawn agents (or return prompts) for all PRs with failed checks, unresolved comments, or conflicts
app.post("/api/fix-all-issues", async (req, res) => {
  try {
    const settings = await readSettings();
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const config: TrackingConfig = JSON.parse(raw);

    // Get local branches for initiative path mapping
    const localBranches: { initiative: string; path: string; repo: string; branch: string }[] = [];
    for (const [initName, init] of Object.entries(config.initiatives)) {
      const initPath = init.path;
      if (!initPath || !existsSync(initPath)) continue;
      for (const subfolder of LOCAL_SUBFOLDERS) {
        const dir = join(initPath, subfolder);
        if (!existsSync(dir)) continue;
        const branchAndRepo = await getLocalBranchAndRepo(initPath, subfolder);
        if (!branchAndRepo) continue;
        localBranches.push({ initiative: initName, path: initPath, repo: branchAndRepo.repo, branch: branchAndRepo.branch });
      }
    }
    const repoAndBranchToPath = new Map<string, string>();
    for (const lb of localBranches) {
      repoAndBranchToPath.set(`${lb.repo}#${lb.branch}`, lb.path);
    }

    // Get all open PRs
    const allOpen = await listAllMyOpenPRs();
    const spawned: { repo: string; number: number; type: string; path?: string }[] = [];
    const prompts: { repo: string; number: number; type: string; prompt: string }[] = [];
    const conflicts: { repo: string; number: number; path?: string }[] = [];

    for (const pr of allOpen) {
      const [status, titleAndHead, checkResult, mergeState] = await Promise.all([
        getPRStatus(pr.repo, pr.number),
        getPRTitleAndHead(pr.repo, pr.number),
        getPRCheckCategories(pr.repo, pr.number),
        getPRMergeState(pr.repo, pr.number),
      ]);
      const checks = checkResult.checks;
      const headRefName = titleAndHead.headRefName || pr.headRefName || "";
      const path = repoAndBranchToPath.get(`${pr.repo}#${headRefName}`) || "";

      // Check for conflicts (can't auto-fix, but report them)
      const hasConflicts = mergeState.mergeable === false ||
        ["DIRTY", "CONFLICTING"].includes((mergeState.mergeStateStatus || "").toUpperCase());
      if (hasConflicts) {
        conflicts.push({ repo: pr.repo, number: pr.number, path: path || undefined });
      }

      // Check for failed checks
      const failingCategories: string[] = [];
      if (checks.lint === "failure") failingCategories.push("lint");
      if (checks.type === "failure") failingCategories.push("type");
      if (checks.test === "failure") failingCategories.push("test");
      if (checks.e2e === "failure") failingCategories.push("e2e");
      if (checks.other === "failure") failingCategories.push("other");

      for (const cat of failingCategories) {
        if (canSpawnAgent(settings.tool)) {
          const args = [pr.repo, String(pr.number), cat];
          if (path) args.push(path);
          spawn(RUN_AGENT_SCRIPT, args, { cwd: ROOT, shell: true, stdio: "ignore" }).unref();
          spawned.push({ repo: pr.repo, number: pr.number, type: `checks:${cat}`, path: path || undefined });
        } else {
          prompts.push({ repo: pr.repo, number: pr.number, type: `checks:${cat}`, prompt: buildAgentPrompt(pr.repo, pr.number, cat) });
        }
      }

      // Check for unresolved comments
      if (status.unresolved > 0) {
        if (canSpawnAgent(settings.tool)) {
          const args = [pr.repo, String(pr.number), "comments"];
          if (path) args.push(path);
          spawn(RUN_AGENT_SCRIPT, args, { cwd: ROOT, shell: true, stdio: "ignore" }).unref();
          spawned.push({ repo: pr.repo, number: pr.number, type: "comments", path: path || undefined });
        } else {
          prompts.push({ repo: pr.repo, number: pr.number, type: "comments", prompt: buildAgentPrompt(pr.repo, pr.number, "comments") });
        }
      }
    }

    const totalActions = spawned.length + prompts.length;
    res.json({
      tool: settings.tool,
      spawned,
      prompts: prompts.length > 0 ? prompts : undefined,
      conflicts,
      message: canSpawnAgent(settings.tool)
        ? `Spawned ${spawned.length} agent(s). ${conflicts.length} PR(s) have conflicts requiring manual resolution.`
        : `Found ${totalActions} issue(s) to fix. ${conflicts.length} PR(s) have conflicts requiring manual resolution. Copy prompts to your tool.`,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /api/finish-pr — fix ALL issues for a single PR (checks, comments, conflicts info)
app.post("/api/finish-pr", async (req, res) => {
  const repo = req.body?.repo;
  const number = req.body?.number;
  const path = req.body?.path;
  if (typeof repo !== "string" || !repo || typeof number !== "number" || !Number.isInteger(number)) {
    res.status(400).json({ error: "Missing or invalid repo or number" });
    return;
  }
  try {
    const settings = await readSettings();
    const [status, checkResult2, mergeState] = await Promise.all([
      getPRStatus(repo, number),
      getPRCheckCategories(repo, number),
      getPRMergeState(repo, number),
    ]);
    const checks = checkResult2.checks;

    const spawned: { type: string }[] = [];
    const prompts: { type: string; prompt: string }[] = [];
    const issues: string[] = [];

    // Check for conflicts
    const hasConflicts = mergeState.mergeable === false ||
      ["DIRTY", "CONFLICTING"].includes((mergeState.mergeStateStatus || "").toUpperCase());
    if (hasConflicts) {
      issues.push("conflicts");
    }

    // Handle each failing check category
    const failingCategories: string[] = [];
    if (checks.lint === "failure") failingCategories.push("lint");
    if (checks.type === "failure") failingCategories.push("type");
    if (checks.test === "failure") failingCategories.push("test");
    if (checks.e2e === "failure") failingCategories.push("e2e");
    if (checks.other === "failure") failingCategories.push("other");

    for (const cat of failingCategories) {
      if (canSpawnAgent(settings.tool)) {
        const args = [repo, String(number), cat];
        if (path) args.push(path);
        spawn(RUN_AGENT_SCRIPT, args, { cwd: ROOT, shell: true, stdio: "ignore" }).unref();
        spawned.push({ type: `checks:${cat}` });
      } else {
        prompts.push({ type: `checks:${cat}`, prompt: buildAgentPrompt(repo, number, cat) });
      }
      issues.push(cat);
    }

    // Handle unresolved comments
    if (status.unresolved > 0) {
      if (canSpawnAgent(settings.tool)) {
        const args = [repo, String(number), "comments"];
        if (path) args.push(path);
        spawn(RUN_AGENT_SCRIPT, args, { cwd: ROOT, shell: true, stdio: "ignore" }).unref();
        spawned.push({ type: "comments" });
      } else {
        prompts.push({ type: "comments", prompt: buildAgentPrompt(repo, number, "comments") });
      }
      issues.push(`${status.unresolved} comments`);
    }

    const totalActions = spawned.length + prompts.length;
    res.json({
      repo,
      number,
      tool: settings.tool,
      spawned,
      prompts: prompts.length > 0 ? prompts : undefined,
      issues,
      hasConflicts,
      message: totalActions > 0
        ? canSpawnAgent(settings.tool)
          ? `Spawned ${spawned.length} agent(s) for: ${issues.join(", ")}`
          : `Found ${totalActions} issue(s) to fix: ${issues.join(", ")}. Copy prompts to your tool.`
        : "No issues to fix",
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Repos to clone for a new food project (subfolder name -> repo name under GITHUB_ORG)
const FOOD_PROJECT_REPOS = [
  "backend",
  "nugs",
  "frontrow-creator-android",
  "frontrow-creator-ios",
  "docs",
  "frontro-protoypes",
] as const;

const RANDOM_FOOD_ITEMS = [
  "taco",
  "pizza",
  "donut",
  "hotdog",
  "pretzel",
  "waffle",
  "sushi",
  "cookie",
  "pie",
  "onion-ring",
  "muffin",
  "croissant",
];

const PIXEL_ART_PROMPT =
  "High quality 16-bit pixel art of {food} in the style of 1980s arcade game Burger Time. Cute food character, centered composition. The background must be SOLID BRIGHT MAGENTA (#FF00FF, pure fuchsia pink). Visible pixel blocks, thick black outlines, vibrant colors. No text, no extra elements. The entire background must be a uniform flat magenta color for easy chroma key removal.";

// Job tracking for async food project creation
interface CreationJob {
  name: string;
  status: "pending" | "generating_icon" | "creating_folder" | "cloning" | "complete" | "failed";
  step: string;
  progress: number; // 0-100
  image?: string;
  path?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
  cloningRepo?: string;
}
const creationJobs = new Map<string, CreationJob>();

// Clean up old jobs after 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [name, job] of creationJobs) {
    if (job.completedAt && now - job.completedAt > 5 * 60 * 1000) {
      creationJobs.delete(name);
    }
  }
}, 60000);

// Agent job tracking for PR fixes (comments, checks, etc.)
interface AgentJob {
  id: string; // `${repo}#${number}`
  repo: string;
  number: number;
  type: "comments" | "checks" | "conflicts" | "all";
  status: "pending" | "running" | "complete" | "failed";
  startedAt: number;
  completedAt?: number;
  summary?: string;
  error?: string;
}
const agentJobs = new Map<string, AgentJob>();

// Clean up completed agent jobs after 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of agentJobs) {
    if (job.completedAt && now - job.completedAt > 10 * 60 * 1000) {
      agentJobs.delete(id);
    }
  }
}, 60000);

// POST /api/agent-job — report agent job status (called by Cursor agents)
app.post("/api/agent-job", async (req, res) => {
  try {
    console.log(`[Agent Job API] Received request:`, JSON.stringify(req.body));
    
    const { repo, number, status, type, summary, error } = req.body || {};
    if (!repo || !number || !status) {
      console.log(`[Agent Job API] Missing required fields - repo: ${repo}, number: ${number}, status: ${status}`);
      res.status(400).json({ error: "Missing required fields: repo, number, status" });
      return;
    }
    const id = `${repo}#${number}`;
    const num = parseInt(number, 10);
    const existing = agentJobs.get(id);
    
    console.log(`[Agent Job API] Processing job ${id}: ${existing ? 'updating existing' : 'creating new'}`);
    
    const job: AgentJob = {
      id,
      repo,
      number: num,
      type: type || existing?.type || "all",
      status,
      startedAt: existing?.startedAt || Date.now(),
      completedAt: status === "complete" || status === "failed" ? Date.now() : undefined,
      summary: summary || existing?.summary,
      error: error || existing?.error,
    };
    
    agentJobs.set(id, job);
    
    // Broadcast status change via SSE
    console.log(`[Agent Job API] Broadcasting SSE event 'agent-status' to ${sseClients.length} connected clients`);
    broadcastSSE("agent-status", job);
    
    console.log(`[Agent Job API] ✓ Job ${id}: ${status}${summary ? ` - ${summary}` : ""}${error ? ` (error: ${error})` : ""}`);
    
    // When agent completes, refresh the PR data and broadcast update
    if (status === "complete") {
      console.log(`[Agent Job API] Agent completed - fetching fresh PR data for ${repo}#${num}`);
      // Use setTimeout to allow git/GitHub to sync (agent may have just pushed)
      setTimeout(async () => {
        try {
          const pr = await fetchPRData(repo, num);
          if (pr) {
            console.log(`[Agent Job API] Broadcasting PR update for ${repo}#${num}`);
            broadcastSSE("pr-update", { pr });
          } else {
            console.log(`[Agent Job API] Could not fetch PR data for ${repo}#${num}`);
          }
        } catch (e) {
          console.error(`[Agent Job API] Error fetching PR data:`, e);
        }
      }, 3000); // Wait 3 seconds for GitHub to update
    }
    
    res.json(job);
  } catch (e) {
    console.error("[Agent Job API] Error:", e);
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/agent-jobs — get all active agent jobs
app.get("/api/agent-jobs", (_req, res) => {
  const jobs = Array.from(agentJobs.values());
  res.json(jobs);
});

// DELETE /api/agent-job/:repo/:number — clear a specific agent job
app.delete("/api/agent-job/:repo/:number", (req, res) => {
  const repo = decodeURIComponent(req.params.repo);
  const number = req.params.number;
  const id = `${repo}#${number}`;
  
  if (agentJobs.has(id)) {
    agentJobs.delete(id);
    broadcastSSE("agent-status", { id, repo, number: parseInt(number, 10), status: "cleared" });
    res.json({ success: true, id });
  } else {
    res.status(404).json({ error: "Job not found" });
  }
});

// --- Agent CLI & Session Management ---

// Check if agent CLI is available
let agentCliAvailable = false;
let agentCliBin = "agent";
(async () => {
  try {
    const result = await runAllowExit("which", ["agent"]);
    if (result && result.trim()) {
      agentCliBin = result.trim();
      agentCliAvailable = true;
      console.log(`[Agent CLI] Found at: ${agentCliBin}`);
    }
  } catch {
    console.log("[Agent CLI] Not found in PATH, dispatch disabled");
  }
})();

// --- Agent Sessions (embedded chat) ---

interface AgentStreamMessage {
  type: string;        // system, assistant, tool_call, result
  subtype?: string;    // init, started, completed, etc.
  raw: unknown;        // full parsed JSON line from CLI
  ts: number;
}

interface AgentSession {
  id: string;
  repo?: string;
  number?: number;
  prompt: string;
  path: string;
  status: "running" | "complete" | "failed" | "cancelled";
  pid?: number;
  messages: AgentStreamMessage[];
  startedAt: number;
  completedAt?: number;
  exitCode?: number | null;
  label?: string; // human-readable label like "Fix checks for repo#123"
  cursorChatId?: string; // The Cursor CLI session_id, used for --resume
}

const agentSessions = new Map<string, AgentSession>();
const agentProcesses = new Map<string, ReturnType<typeof spawn>>();

// Clean up completed sessions after 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of agentSessions) {
    if (session.completedAt && now - session.completedAt > 30 * 60 * 1000) {
      agentSessions.delete(id);
      agentProcesses.delete(id);
    }
  }
}, 60000);

let sessionIdCounter = 0;

function createAgentSession(opts: {
  path: string;
  prompt: string;
  repo?: string;
  number?: number;
  label?: string;
  type?: AgentJob["type"];
  resumeChatId?: string; // Cursor chatId to resume (for follow-up messages)
}): AgentSession {
  const sessionId = `session-${Date.now()}-${++sessionIdCounter}`;
  const session: AgentSession = {
    id: sessionId,
    repo: opts.repo,
    number: opts.number,
    prompt: opts.prompt,
    path: opts.path,
    status: "running",
    messages: [],
    startedAt: Date.now(),
    label: opts.label,
    cursorChatId: opts.resumeChatId, // Will be updated from init message if new
  };
  agentSessions.set(sessionId, session);

  // Also create/update an agentJob for backward compat with PR status indicators
  if (opts.repo && opts.number) {
    const jobId = `${opts.repo}#${opts.number}`;
    const job: AgentJob = {
      id: jobId,
      repo: opts.repo,
      number: opts.number,
      type: opts.type || "all",
      status: "running",
      startedAt: Date.now(),
    };
    agentJobs.set(jobId, job);
    broadcastSSE("agent-status", job);
  }

  // Broadcast session created BEFORE spawning so SSE clients can prepare
  broadcastSSE("agent-session-created", {
    id: session.id,
    repo: session.repo,
    number: session.number,
    status: session.status,
    label: session.label,
    startedAt: session.startedAt,
    cursorChatId: session.cursorChatId,
  });

  // Build CLI args — use --resume for follow-ups
  const cliArgs: string[] = [];
  if (opts.resumeChatId) {
    cliArgs.push("--resume", opts.resumeChatId);
    cliArgs.push("-p", opts.prompt);
    console.log(`[Session ${sessionId}] Resuming Cursor chat ${opts.resumeChatId} in ${opts.path}`);
  } else {
    cliArgs.push("-p", opts.prompt);
    console.log(`[Session ${sessionId}] Starting new agent in ${opts.path}`);
  }
  cliArgs.push("--force", "--output-format", "stream-json", "--stream-partial-output");
  console.log(`[Session ${sessionId}] CLI: ${agentCliBin} ${cliArgs.join(" ").slice(0, 120)}...`);

  const child = spawn(agentCliBin, cliArgs, {
    cwd: opts.path,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  session.pid = child.pid;
  agentProcesses.set(sessionId, child);

  // Buffer for incomplete JSON lines
  let stdoutBuffer = "";

  child.stdout?.on("data", (data: Buffer) => {
    stdoutBuffer += data.toString();
    // Split by newlines - each complete line is a JSON object
    const lines = stdoutBuffer.split("\n");
    // Keep the last incomplete line in the buffer
    stdoutBuffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        const msg: AgentStreamMessage = {
          type: parsed.type || "unknown",
          subtype: parsed.subtype,
          raw: parsed,
          ts: Date.now(),
        };
        session.messages.push(msg);

        // Capture the Cursor chat session_id from the init message
        if (parsed.type === "system" && parsed.subtype === "init" && parsed.session_id) {
          session.cursorChatId = parsed.session_id;
          console.log(`[Session ${sessionId}] Cursor chatId: ${parsed.session_id}`);
        }

        broadcastSSE("agent-stream", { sessionId, message: msg });
      } catch {
        // Not valid JSON, treat as raw text
        const msg: AgentStreamMessage = {
          type: "raw",
          raw: { text: trimmed },
          ts: Date.now(),
        };
        session.messages.push(msg);
        broadcastSSE("agent-stream", { sessionId, message: msg });
      }
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    const text = data.toString().trim();
    if (text) {
      console.error(`[Session ${sessionId}] stderr: ${text}`);
      const msg: AgentStreamMessage = {
        type: "stderr",
        raw: { text },
        ts: Date.now(),
      };
      session.messages.push(msg);
      broadcastSSE("agent-stream", { sessionId, message: msg });
    }
  });

  child.on("exit", (code: number | null) => {
    console.log(`[Session ${sessionId}] Agent exited with code ${code}`);
    session.exitCode = code;
    session.completedAt = Date.now();
    session.status = code === 0 ? "complete" : (session.status === "cancelled" ? "cancelled" : "failed");
    agentProcesses.delete(sessionId);

    broadcastSSE("agent-complete", {
      sessionId,
      status: session.status,
      exitCode: code,
      durationMs: session.completedAt - session.startedAt,
    });

    // Update the associated agentJob for backward compat
    if (opts.repo && opts.number) {
      const jobId = `${opts.repo}#${opts.number}`;
      const existingJob = agentJobs.get(jobId);
      if (existingJob) {
        existingJob.status = session.status === "complete" ? "complete" : "failed";
        existingJob.completedAt = Date.now();
        if (session.status !== "complete") {
          existingJob.error = `Agent exited with code ${code}`;
        }
        broadcastSSE("agent-status", existingJob);
      }

      // Refresh PR data after completion
      if (session.status === "complete") {
        setTimeout(async () => {
          try {
            const pr = await fetchPRData(opts.repo!, opts.number!);
            if (pr) {
              broadcastSSE("pr-update", { pr });
            }
          } catch (e) {
            console.error(`[Session ${sessionId}] Error refreshing PR data:`, e);
          }
        }, 3000);
      }
    }
  });

  return session;
}

// GET /api/capabilities — check what features are available
app.get("/api/capabilities", (_req, res) => {
  res.json({
    agentCli: agentCliAvailable,
    agentCliBin,
  });
});

// POST /api/agent-session — start a new agent session or resume an existing one
app.post("/api/agent-session", (req, res) => {
  const { path: projectPath, prompt, repo, number, label, type, resumeSessionId } = req.body || {};
  if (!projectPath || !prompt) {
    res.status(400).json({ error: "Missing required fields: path, prompt" });
    return;
  }
  if (!agentCliAvailable) {
    res.status(503).json({ error: "Agent CLI not available. Install with: curl https://cursor.com/install -fsSL | bash" });
    return;
  }
  if (!existsSync(projectPath)) {
    res.status(400).json({ error: `Path does not exist: ${projectPath}` });
    return;
  }

  // If resuming, look up the cursorChatId from the previous session
  let resumeChatId: string | undefined;
  if (resumeSessionId) {
    const prevSession = agentSessions.get(resumeSessionId);
    if (prevSession?.cursorChatId) {
      resumeChatId = prevSession.cursorChatId;
      console.log(`[API] Resuming session ${resumeSessionId} → Cursor chatId ${resumeChatId}`);
    } else {
      console.log(`[API] Resume requested but no cursorChatId found for ${resumeSessionId}`);
    }
  }

  const session = createAgentSession({
    path: projectPath,
    prompt,
    repo: repo || undefined,
    number: number ? parseInt(number, 10) : undefined,
    label: label || undefined,
    type: type || undefined,
    resumeChatId,
  });

  res.json({
    dispatched: true,
    sessionId: session.id,
    pid: session.pid,
    resumed: !!resumeChatId,
  });
});

// GET /api/agent-sessions — list all active/recent sessions
app.get("/api/agent-sessions", (_req, res) => {
  const sessions = Array.from(agentSessions.values()).map((s) => ({
    id: s.id,
    repo: s.repo,
    number: s.number,
    status: s.status,
    label: s.label,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    messageCount: s.messages.length,
    cursorChatId: s.cursorChatId,
  }));
  res.json(sessions);
});

// GET /api/agent-session/:id — get a specific session with full message buffer
app.get("/api/agent-session/:id", (req, res) => {
  const id = req.params.id;
  const session = agentSessions.get(id);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json({
    id: session.id,
    repo: session.repo,
    number: session.number,
    prompt: session.prompt,
    path: session.path,
    status: session.status,
    label: session.label,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    exitCode: session.exitCode,
    messages: session.messages,
    cursorChatId: session.cursorChatId,
  });
});

// DELETE /api/agent-session/:id — kill a running session
app.delete("/api/agent-session/:id", (req, res) => {
  const id = req.params.id;
  const session = agentSessions.get(id);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const proc = agentProcesses.get(id);
  if (proc && session.status === "running") {
    session.status = "cancelled";
    proc.kill("SIGTERM");
    // Force kill after 5 seconds
    setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
    }, 5000);
  }

  res.json({ success: true, id, status: session.status });
});

// POST /api/upload-image — save an image to the project for agent access
const uploadsDir = join(tmpdir(), "orderup-uploads");
if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

app.post("/api/upload-image", (req, res) => {
  const { data, filename, projectPath } = req.body || {};
  if (!data) {
    res.status(400).json({ error: "Missing image data" });
    return;
  }

  // data is a base64 data URL like "data:image/png;base64,..."
  const match = (data as string).match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) {
    res.status(400).json({ error: "Invalid image data format" });
    return;
  }

  const mimeType = match[1];
  const base64Data = match[2];
  const ext = mimeType.split("/")[1] || "png";
  const safeName = (filename || `screenshot-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, "_");
  const finalName = safeName.endsWith(`.${ext}`) ? safeName : `${safeName}.${ext}`;

  // Save to project path if provided, otherwise uploads dir
  let saveDir = uploadsDir;
  if (projectPath && existsSync(projectPath)) {
    const projUploads = join(projectPath, ".orderup-uploads");
    if (!existsSync(projUploads)) mkdirSync(projUploads, { recursive: true });
    saveDir = projUploads;
  }

  const filePath = join(saveDir, finalName);
  try {
    writeFileSync(filePath, Buffer.from(base64Data, "base64"));
    console.log(`[Upload] Saved image to ${filePath}`);
    res.json({ success: true, path: filePath, filename: finalName });
  } catch (err: unknown) {
    console.error("[Upload] Failed:", err);
    res.status(500).json({ error: "Failed to save image" });
  }
});

// POST /api/dispatch-agent — reworked: creates an agent session instead of AppleScript
app.post("/api/dispatch-agent", (req, res) => {
  const { path: projectPath, prompt, repo, number, taskId, label, type } = req.body || {};
  if (!projectPath || !prompt) {
    res.status(400).json({ error: "Missing required fields: path, prompt" });
    return;
  }
  if (!agentCliAvailable) {
    res.status(503).json({ error: "Agent CLI not available. Install with: curl https://cursor.com/install -fsSL | bash" });
    return;
  }
  if (!existsSync(projectPath)) {
    res.status(400).json({ error: `Path does not exist: ${projectPath}` });
    return;
  }

  const session = createAgentSession({
    path: projectPath,
    prompt,
    repo: repo || undefined,
    number: number ? parseInt(number, 10) : undefined,
    label: label || undefined,
    type: type || undefined,
  });

  res.json({ dispatched: true, sessionId: session.id, jobId: repo && number ? `${repo}#${number}` : taskId || null, pid: session.pid });
});

// --- Initiative Tasks (non-PR agent work) ---

interface InitiativeTask {
  id: string;
  initiative: string;
  path: string;
  command: string;
  status: "pending" | "running" | "complete" | "failed";
  startedAt: number;
  completedAt?: number;
  summary?: string;
  error?: string;
}
const initiativeTasks = new Map<string, InitiativeTask>();

// Clean up completed initiative tasks after 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, task] of initiativeTasks) {
    if (task.completedAt && now - task.completedAt > 30 * 60 * 1000) {
      initiativeTasks.delete(id);
    }
  }
}, 60000);

// POST /api/initiative-task — create or update an initiative task
app.post("/api/initiative-task", (req, res) => {
  try {
    const { id, initiative, path, command, status, summary, error } = req.body || {};
    if (!id || !status) {
      res.status(400).json({ error: "Missing required fields: id, status" });
      return;
    }
    const existing = initiativeTasks.get(id);
    const task: InitiativeTask = {
      id,
      initiative: initiative || existing?.initiative || "",
      path: path || existing?.path || "",
      command: command || existing?.command || "",
      status,
      startedAt: existing?.startedAt || Date.now(),
      completedAt: status === "complete" || status === "failed" ? Date.now() : undefined,
      summary: summary || existing?.summary,
      error: error || existing?.error,
    };
    initiativeTasks.set(id, task);
    console.log(`[Initiative Task] ${id}: ${status}${summary ? ` - ${summary}` : ""}`);
    broadcastSSE("initiative-task", task);
    res.json(task);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/initiative-tasks — get all active initiative tasks
app.get("/api/initiative-tasks", (_req, res) => {
  res.json(Array.from(initiativeTasks.values()));
});

// DELETE /api/initiative-task/:id — clear a specific initiative task
app.delete("/api/initiative-task/:id", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  if (initiativeTasks.has(id)) {
    initiativeTasks.delete(id);
    broadcastSSE("initiative-task", { id, status: "cleared" });
    res.json({ success: true, id });
  } else {
    res.status(404).json({ error: "Task not found" });
  }
});

// GET /api/creation-status/:name — poll for creation job status
app.get("/api/creation-status/:name", (req, res) => {
  const name = req.params.name;
  const job = creationJobs.get(name);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(job);
});

// POST /api/create-food-project — starts async creation, returns immediately with name
app.post("/api/create-food-project", async (req, res) => {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const config: TrackingConfig = JSON.parse(raw);
    const existing = new Set(Object.keys(config.initiatives).map((k) => k.toLowerCase()));
    
    // Use provided name if passed, otherwise pick a random one
    let foodName = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim() : "";
    if (!foodName) {
      for (let i = 0; i < 20; i++) {
        const candidate = RANDOM_FOOD_ITEMS[Math.floor(Math.random() * RANDOM_FOOD_ITEMS.length)];
        if (!existing.has(candidate.toLowerCase())) {
          foodName = candidate;
          break;
        }
        const withSuffix = `${candidate}-${Math.floor(Math.random() * 100)}`;
        if (!existing.has(withSuffix.toLowerCase())) {
          foodName = withSuffix;
          break;
        }
      }
    }
    if (!foodName) {
      res.status(400).json({ error: "Could not pick a unique food name; too many initiatives." });
      return;
    }
    if (existing.has(foodName.toLowerCase())) {
      res.status(400).json({ error: `Initiative "${foodName}" already exists.` });
      return;
    }
    if (creationJobs.has(foodName)) {
      res.status(400).json({ error: `Creation already in progress for "${foodName}"` });
      return;
    }

    // Initialize job
    const job: CreationJob = {
      name: foodName,
      status: "pending",
      step: "Starting...",
      progress: 0,
      startedAt: Date.now(),
    };
    creationJobs.set(foodName, job);

    // Return immediately with the name - work happens in background
    res.json({ name: foodName, started: true });

    // Run creation in background (don't await)
    runCreationJob(foodName, config).catch((e) => {
      const j = creationJobs.get(foodName);
      if (j) {
        j.status = "failed";
        j.error = String(e);
        j.completedAt = Date.now();
      }
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Background job runner
async function runCreationJob(foodName: string, config: TrackingConfig) {
  const job = creationJobs.get(foodName);
  if (!job) return;

  let createdImagePath: string | null = null;
  let createdProjectPath: string | null = null;

  async function cleanup() {
    const { unlink, rm } = await import("fs/promises");
    if (createdImagePath && existsSync(createdImagePath)) {
      await unlink(createdImagePath).catch(() => {});
    }
    if (createdProjectPath && existsSync(createdProjectPath)) {
      await rm(createdProjectPath, { recursive: true, force: true }).catch(() => {});
    }
  }

  try {
    // Step 1: Generate icon
    job.status = "generating_icon";
    job.step = "Generating icon...";
    job.progress = 10;

    const initiativesDir = join(__dirname, "public", "images", "initiatives");
    await mkdir(initiativesDir, { recursive: true });
    const imagePath = join(initiativesDir, `${foodName}.png`);
    const apiKey = process.env.GEMINI_API_KEY;
    
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY not set");
    }

    const prompt = PIXEL_ART_PROMPT.replace("{food}", foodName);
    const genRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instances: [{ prompt }],
          parameters: { sampleCount: 1 },
        }),
      }
    );
    
    if (!genRes.ok) {
      const errText = await genRes.text();
      throw new Error(`Gemini image generation failed: ${errText}`);
    }
    
    const genData = (await genRes.json()) as { predictions?: { bytesBase64Encoded?: string }[] };
    const base64Data = genData.predictions?.[0]?.bytesBase64Encoded;
    if (!base64Data) throw new Error("Gemini returned no image data");

    job.progress = 25;
    job.step = "Processing icon...";

    const buf = Buffer.from(base64Data, "base64");
    const tempPath = join(dirname(imagePath), `_tmp_${foodName}.png`);
    await writeFile(tempPath, buf);
    
    // Remove black background (common in pixel art generation)
    const magickOk = await new Promise<{ ok: boolean }>((resolve) => {
      const proc = spawn(
        "magick",
        [
          tempPath,
          "-alpha", "set",
          "-fuzz", "20%", "-fill", "none", "-opaque", "#FF00FF",
          imagePath
        ],
        { cwd: ROOT }
      );
      proc.on("close", (code) => resolve({ ok: code === 0 }));
    });
    
    const { unlink } = await import("fs/promises");
    await unlink(tempPath).catch(() => {});
    
    if (!magickOk.ok) {
      await writeFile(imagePath, buf);
    }
    
    createdImagePath = imagePath;
    job.image = `/images/initiatives/${foodName}.png`;
    job.progress = 35;

    // Step 2: Create folder
    job.status = "creating_folder";
    job.step = "Creating folder...";
    job.progress = 40;

    const firstPath = Object.values(config.initiatives)[0]?.path;
    const projectsDir = firstPath ? dirname(firstPath) : join(process.env.HOME || "/tmp", "Projects");
    const projectPath = join(projectsDir, foodName);
    await mkdir(projectPath, { recursive: true });
    createdProjectPath = projectPath;
    job.path = projectPath;
    job.progress = 45;

    // Step 3: Clone repos
    job.status = "cloning";
    const org = config.githubOrg || process.env.GITHUB_ORG || "FrontRowXP";
    const reposToClone = Array.isArray(config.foodProjectRepos) && config.foodProjectRepos.length > 0
      ? config.foodProjectRepos
      : [...FOOD_PROJECT_REPOS];
    
    const progressPerRepo = 45 / reposToClone.length; // Remaining 45% for cloning
    let cloneProgress = 45;

    for (const repo of reposToClone) {
      job.step = `Cloning ${repo}...`;
      job.cloningRepo = repo;
      
      const repoPath = join(projectPath, repo);
      if (!existsSync(repoPath)) {
        await new Promise<void>((resolve, reject) => {
          let stderr = "";
          const proc = spawn("git", ["clone", `https://github.com/${org}/${repo}.git`, repoPath], {
            cwd: ROOT,
            shell: true,
          });
          proc.stderr?.on("data", (d) => (stderr += d.toString()));
          proc.on("close", (code) => {
            if (code === 0) return resolve();
            const msg = stderr.trim() || `exit ${code}`;
            reject(new Error(`git clone ${repo}: ${msg}`));
          });
        });
      }
      
      cloneProgress += progressPerRepo;
      job.progress = Math.min(90, Math.round(cloneProgress));
    }

    // Step 4: Update config
    job.step = "Saving config...";
    job.progress = 95;

    // Re-read config to avoid race conditions
    const freshRaw = await readFile(CONFIG_PATH, "utf-8");
    const freshConfig: TrackingConfig = JSON.parse(freshRaw);
    
    freshConfig.initiatives[foodName] = { path: projectPath, description: "", prs: [] };
    freshConfig.repoToSubfolder = freshConfig.repoToSubfolder || {};
    for (const repo of reposToClone) {
      const fullName = `${org}/${repo}`;
      if (!freshConfig.repoToSubfolder[fullName]) freshConfig.repoToSubfolder[fullName] = repo;
    }
    freshConfig.updatedAt = new Date().toISOString();
    await writeFile(CONFIG_PATH, JSON.stringify(freshConfig, null, 2));

    // Complete
    job.status = "complete";
    job.step = "Done!";
    job.progress = 100;
    job.completedAt = Date.now();

  } catch (e) {
    await cleanup();
    job.status = "failed";
    job.error = String(e);
    job.step = "Failed";
    job.completedAt = Date.now();
  }
}

// POST /api/regenerate-initiative-image — regenerate the initiative icon using DALL-E
app.post("/api/regenerate-initiative-image", async (req, res) => {
  try {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) {
      res.status(400).json({ error: "Missing or invalid initiative name" });
      return;
    }
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      res.status(400).json({ error: "GEMINI_API_KEY not set. Cannot regenerate image." });
      return;
    }
    const initiativesDir = join(__dirname, "public", "images", "initiatives");
    await mkdir(initiativesDir, { recursive: true });
    const imagePath = join(initiativesDir, `${name}.png`);
    const prompt = PIXEL_ART_PROMPT.replace("{food}", name);
    const genRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instances: [{ prompt }],
          parameters: { sampleCount: 1 },
        }),
      }
    );
    if (!genRes.ok) {
      const errText = await genRes.text();
      res.status(400).json({ error: `Gemini image generation failed: ${errText}` });
      return;
    }
    const genData = (await genRes.json()) as { predictions?: { bytesBase64Encoded?: string }[] };
    const base64Data = genData.predictions?.[0]?.bytesBase64Encoded;
    if (!base64Data) {
      res.status(500).json({ error: "Gemini returned no image data" });
      return;
    }
    const buf = Buffer.from(base64Data, "base64");
    const tempPath = join(dirname(imagePath), `_tmp_${name}.png`);
    await writeFile(tempPath, buf);
    // Remove black background (common in pixel art generation)
    const magickOk = await new Promise<{ ok: boolean; stderr: string }>((resolve) => {
      let stderr = "";
      const proc = spawn(
        "magick",
        [
          tempPath,
          "-alpha", "set",
          "-fuzz", "20%", "-fill", "none", "-opaque", "#FF00FF",
          imagePath
        ],
        { cwd: ROOT }
      );
      proc.stderr?.on("data", (d) => (stderr += d.toString()));
      proc.on("close", (code) => resolve({ ok: code === 0, stderr: stderr.trim() }));
    });
    const { unlink } = await import("fs/promises");
    await unlink(tempPath).catch(() => {});
    if (!magickOk.ok) {
      // Fallback: save image without transparency
      await writeFile(imagePath, buf);
    }
    res.json({ name, image: `/images/initiatives/${name}.png`, regenerated: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /api/ensure-initiative-folder — ensure the initiative folder exists; create dir + clone repos if missing.
app.post("/api/ensure-initiative-folder", async (req, res) => {
  try {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) {
      res.status(400).json({ error: "Missing or invalid initiative name" });
      return;
    }
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const config: TrackingConfig = JSON.parse(raw);
    const byLower = new Map<string, string>();
    for (const k of Object.keys(config.initiatives)) byLower.set(k.toLowerCase(), k);
    const canonicalName = byLower.get(name.toLowerCase()) ?? name;
    const initiative = config.initiatives[canonicalName];
    if (!initiative?.path) {
      res.status(404).json({ error: `Initiative not found: ${name}` });
      return;
    }
    const projectPath = initiative.path;
    if (existsSync(projectPath)) {
      res.json({ path: projectPath, newlyCreated: false });
      return;
    }
    const projectsDir = dirname(projectPath);
    await mkdir(projectsDir, { recursive: true });
    await mkdir(projectPath, { recursive: true });
    const org = config.githubOrg || process.env.GITHUB_ORG || "FrontRowXP";
    const reposToClone = Array.isArray(config.foodProjectRepos) && config.foodProjectRepos.length > 0
      ? config.foodProjectRepos
      : [...FOOD_PROJECT_REPOS];
    for (const repo of reposToClone) {
      const repoPath = join(projectPath, repo);
      if (existsSync(repoPath)) continue;
      await new Promise<void>((resolve, reject) => {
        let stderr = "";
        const proc = spawn("git", ["clone", `https://github.com/${org}/${repo}.git`, repoPath], {
          cwd: ROOT,
          shell: true,
        });
        proc.stderr?.on("data", (d) => (stderr += d.toString()));
        proc.on("close", (code) => {
          if (code === 0) return resolve();
          const msg = stderr.trim() || `exit ${code}`;
          reject(new Error(`git clone ${repo}: ${msg}`));
        });
      });
    }
    res.json({ path: projectPath, newlyCreated: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// API routes first so /api/* is never served as static files
app.get("/api/status", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const config: TrackingConfig = JSON.parse(raw);

    // Local branches first: scan initiative paths for backend, nugs, frontrow-creator-ios, frontrow-creator-android
    const localBranches: LocalBranchRow[] = [];
    for (const [initName, init] of Object.entries(config.initiatives)) {
      const initPath = init.path;
      if (!initPath || !existsSync(initPath)) continue;
      for (const subfolder of LOCAL_SUBFOLDERS) {
        const dir = join(initPath, subfolder);
        if (!existsSync(dir)) continue;
        const branchAndRepo = await getLocalBranchAndRepo(initPath, subfolder);
        if (!branchAndRepo) continue;
        const { branch, repo } = branchAndRepo;
        const pr = await getPRForBranch(repo, branch);
        localBranches.push({
          initiative: initName,
          path: initPath,
          subfolder,
          branch,
          repo,
          prNumber: pr?.number ?? null,
          prTitle: pr?.title ?? null,
        });
      }
    }

    // (repo, branch) -> initiative path/name — only show initiative when that exact branch is checked out locally
    const repoAndBranchToInitiative = new Map<string, { path: string; name: string }>();
    for (const lb of localBranches) {
      const key = `${lb.repo}#${lb.branch}`;
      repoAndBranchToInitiative.set(key, { path: lb.path, name: lb.initiative });
    }

    // All my open PRs from GitHub (search API)
    const allOpen = await listAllMyOpenPRs();
    const openPRs = allOpen;

    const prs: PRStatus[] = [];
    for (const pr of openPRs) {
      const [status, titleAndHead, checkResult3, previews, mergeState] = await Promise.all([
        getPRStatus(pr.repo, pr.number),
        getPRTitleAndHead(pr.repo, pr.number),
        getPRCheckCategories(pr.repo, pr.number),
        getPRPreviewUrls(pr.repo, pr.number),
        getPRMergeState(pr.repo, pr.number),
      ]);
      const headRefName = titleAndHead.headRefName || pr.headRefName || "";
      const init = repoAndBranchToInitiative.get(`${pr.repo}#${headRefName}`);
      const hasPreviews3 = previews.viewer || previews.creator || previews.storybook;
      const hasDeployStatus3 = checkResult3.previewDeployStatus.viewer || checkResult3.previewDeployStatus.creator || checkResult3.previewDeployStatus.storybook;
      prs.push({
        repo: pr.repo,
        number: pr.number,
        branch: headRefName,
        title: titleAndHead.title,
        failingChecks: status.failingChecks,
        unresolved: status.unresolved,
        checks: checkResult3.checks,
        previews: hasPreviews3 ? previews : undefined,
        previewDeployStatus: hasDeployStatus3 ? checkResult3.previewDeployStatus : undefined,
        initiativePath: init?.path,
        initiativeName: init?.name,
        mergeable: mergeState.mergeable,
        mergeStateStatus: mergeState.mergeStateStatus,
        reviewDecision: mergeState.reviewDecision,
      });
    }

    // Group open PRs by initiative name
    const byInitiative = new Map<string, PRStatus[]>();
    for (const p of prs) {
      const key = (p.initiativeName && p.initiativeName.trim()) || "—";
      const list = byInitiative.get(key) ?? [];
      list.push(p);
      byInitiative.set(key, list);
    }
    const initiatives: InitiativeStatus[] = [];
    const dashFirst = (a: string, b: string) => (a === "—" ? 1 : b === "—" ? -1 : a.localeCompare(b));
    for (const name of [...byInitiative.keys()].sort(dashFirst)) {
      const groupPrs = byInitiative.get(name)!;
      const path = groupPrs[0]?.initiativePath ?? "";
      initiatives.push({ name, description: "", path, prs: groupPrs });
    }

    // Local branches: only show rows whose (repo, branch) is not already in My open PRs
    const openBranchSet = new Set(prs.map((p) => `${p.repo}#${p.branch}`));
    const filteredLocalBranches = localBranches.filter(
      (lb) => !openBranchSet.has(`${lb.repo}#${lb.branch}`)
    );

    const allInitiatives = Object.entries(config.initiatives).map(([name, init]) => ({
      name,
      path: init.path || "",
    }));

    res.json({
      initiatives,
      allInitiatives,
      localBranches: filteredLocalBranches,
      updatedAt: new Date().toISOString(),
      projectRoot: ROOT,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GitHub repo events for tracked PRs only
interface GHEvent {
  type: string;
  created_at: string;
  repo: string;
  number: number;
  actor: string;
  action: string | null;
  summary: string;
  url: string;
}

app.get("/api/events", async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const allOpen = await listAllMyOpenPRs();
    const repoPrs = new Map<string, Set<number>>();
    for (const pr of allOpen) {
      const set = repoPrs.get(pr.repo) ?? new Set<number>();
      set.add(pr.number);
      repoPrs.set(pr.repo, set);
    }
    const all: GHEvent[] = [];
    for (const repo of repoPrs.keys()) {
      const prNums = repoPrs.get(repo)!;
      const [owner, repoName] = repo.split("/");
      const out = await run("gh", ["api", `repos/${owner}/${repoName}/events`]).catch(() => "[]");
      type Payload = { issue?: number | { number?: number }; pull_request?: number | { number?: number }; action?: string };
      let items: { type: string; created_at: string; actor?: { login?: string }; payload?: Payload }[];
      try {
        items = JSON.parse(out || "[]");
      } catch {
        items = [];
      }
      for (const e of items) {
        if (e.type === "PullRequestReviewEvent") continue; // ignore review events
        const payload = e.payload ?? {};
        const issueNum = typeof payload.issue === "number" ? payload.issue : (payload.issue as { number?: number })?.number;
        const prNum =
          typeof payload.pull_request === "number" ? payload.pull_request : (payload.pull_request as { number?: number })?.number;
        const num = issueNum ?? prNum;
        if (num == null || !prNums.has(num)) continue;
        const action = payload.action ?? "";
        const summary =
          e.type === "IssueCommentEvent"
            ? "comment"
            : e.type === "PullRequestEvent"
              ? `PR ${action}`
              : e.type;
        all.push({
          type: e.type,
          created_at: e.created_at,
          repo,
          number: num,
          actor: e.actor?.login ?? "",
          action: action || null,
          summary,
          url: `https://github.com/${repo}/pull/${num}`,
        });
      }
    }
    all.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    res.json({ events: all.slice(0, 50), updatedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// SSE endpoint for real-time updates
app.get("/api/sse", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Disable nginx buffering
  res.flushHeaders();

  const clientId = ++sseClientId;
  const client: SSEClient = { id: clientId, res };
  sseClients.push(client);
  console.log(`SSE client ${clientId} connected (${sseClients.length} total)`);

  // Send initial ping
  res.write(`event: connected\ndata: ${JSON.stringify({ clientId })}\n\n`);

  // Keep-alive ping every 30 seconds
  const pingInterval = setInterval(() => {
    try {
      res.write(`event: ping\ndata: ${JSON.stringify({ time: Date.now() })}\n\n`);
    } catch {
      clearInterval(pingInterval);
    }
  }, 30000);

  req.on("close", () => {
    clearInterval(pingInterval);
    const idx = sseClients.findIndex((c) => c.id === clientId);
    if (idx !== -1) sseClients.splice(idx, 1);
    console.log(`SSE client ${clientId} disconnected (${sseClients.length} remaining)`);
  });
});

// GitHub webhook: when GH events come in, trigger the Cursor agent for that PR if tracked.
// Configure in GitHub repo → Settings → Webhooks: Payload URL = https://your-host/webhook/github,
// Content type = application/json, Secret = optional (set GITHUB_WEBHOOK_SECRET env).
app.post("/webhook/github", async (req, res) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (secret) {
    const sig = req.headers["x-hub-signature-256"] as string;
    if (!sig?.startsWith("sha256=")) {
      res.status(401).send("Missing signature");
      return;
    }
    const crypto = await import("crypto");
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(JSON.stringify(req.body));
    const expected = "sha256=" + hmac.digest("hex");
    if (sig !== expected) {
      res.status(401).send("Invalid signature");
      return;
    }
  }
  res.status(202).send("Accepted");
  const eventType = req.headers["x-github-event"] as string;
  const payload = req.body as {
    repository?: { full_name?: string };
    issue?: { number?: number; pull_request?: unknown };
    pull_request?: { number?: number };
    check_suite?: { pull_requests?: { number: number }[] };
    check_run?: { pull_requests?: { number: number }[] };
    action?: string;
  };
  const repo = payload.repository?.full_name;
  
  // Get PR number from various event types
  let num = payload.pull_request?.number ?? (payload.issue?.pull_request ? payload.issue?.number : undefined);
  
  // For check_suite and check_run events, get PR from nested array
  if (!num && payload.check_suite?.pull_requests?.[0]) {
    num = payload.check_suite.pull_requests[0].number;
  }
  if (!num && payload.check_run?.pull_requests?.[0]) {
    num = payload.check_run.pull_requests[0].number;
  }
  
  if (!repo || !num) return;
  
  console.log(`Webhook: ${eventType} for ${repo}#${num} (action: ${payload.action || "n/a"})`);
  
  // Always fetch fresh data and broadcast to connected clients
  // Small delay to let GitHub's API update
  setTimeout(async () => {
    try {
      const pr = await fetchPRData(repo, num!);
      if (pr) {
        console.log(`Broadcasting PR update: ${repo}#${num} (unresolved: ${pr.unresolved}, checks: ${JSON.stringify(pr.checks)})`);
        broadcastSSE("pr-update", { pr, eventType, timestamp: Date.now() });
      }
    } catch (e) {
      console.error(`Failed to fetch PR data for broadcast: ${e}`);
    }
  }, 2000); // 2 second delay to let GitHub API reflect changes
  
  // Also run agent if tracked (existing behavior)
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const config: TrackingConfig = JSON.parse(raw);
    const tracked = Object.values(config.initiatives).some((init) =>
      init.prs?.some((pr) => pr.repo === repo && pr.number === num)
    );
    if (!tracked) return;
    // Don't auto-run agent anymore, just broadcast updates
    // spawn(RUN_AGENT_SCRIPT, [repo, String(num)], { cwd: ROOT, shell: true, stdio: "ignore" }).unref();
  } catch {
    // ignore
  }
});

app.use(express.static(join(__dirname, "public")));

// Ensure API routes always get JSON responses (no HTML 404)
app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    res.status(404).json({ error: "Not found" });
  } else {
    res.status(404).send("Not found");
  }
});

const PORT = process.env.PORT ?? 3333;
app.listen(PORT, () => {
  console.log(`Order Up!: http://localhost:${PORT}`);
  console.log(`Config: ${CONFIG_PATH}`);
});
