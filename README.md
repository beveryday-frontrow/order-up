# PR Watcher

Local app that tracks which initiative folders manage which PRs and can run Cursor to fix checks/comments.

**Location:** `~/Projects/pr-watcher` — lives in the Projects folder on purpose so it stays **outside** any single initiative (burger, fries, nuggies, sauce, etc.) and can drive all of them.

## Config: `config/tracking.json`

- **initiatives** – Each key (e.g. `nuggies`, `sauce`) is an initiative name. Value:
  - **path** – Absolute path to that Cursor project folder.
  - **description** – Optional label (e.g. "Stripe", "RN Community Chat").
  - **prs** – Array of `{ repo, number, branch? }` that this folder owns.
- **repoToSubfolder** – Maps GitHub repo (e.g. `FrontRowXP/nugs`) to the subfolder name under each initiative (`nugs`, `backend`, etc.).

## How the app uses it

1. **Lookup PR → folder**  
   On event for `FrontRowXP/nugs#3199`: find initiative whose `prs` contains that repo+number → use that initiative’s `path` to run Cursor.

2. **Lookup folder → PRs**  
   For "which PRs is nuggies managing?": read `initiatives.nuggies.prs`.

3. **Updating**  
   - When you assign a new PR to an initiative: append to that initiative’s `prs` and set `updatedAt`.
   - When a PR is merged/closed: remove from `prs` (or have the app do it when it polls and sees closed).

## Example: add a PR to an initiative

Edit `config/tracking.json` and add to the right initiative’s `prs`:

```json
"prs": [
  { "repo": "FrontRowXP/nugs", "number": 3199, "branch": "feat/user-stripe-management-ui" },
  { "repo": "FrontRowXP/backend", "number": 4596, "branch": "feat/new-thing" }
]
```

Or have the app support a command like: `assign FrontRowXP/backend#4596 to nuggies`.

## Scripts

From `~/Projects/pr-watcher` (or with paths from there):

| Script | Purpose |
|--------|---------|
| `scripts/show-tracking.sh` | Print which initiative folders manage which PRs (from `config/tracking.json`). |
| `scripts/pull-open-prs.sh` | Report-only: list open PRs for every repo in `repoToSubfolder`; shows which are already tracked. Does not modify config. |
| `scripts/lib/get-pr-status.sh OWNER REPO NUMBER` | Check one PR: outputs `failing_checks=N unresolved=M`; exit 1 if it needs attention. |
| `scripts/run-agent-for-pr.sh REPO NUMBER` | Look up initiative for that PR, `cd` to its path, run Cursor `agent` to fix checks and comments. Example: `scripts/run-agent-for-pr.sh FrontRowXP/nugs 3199`. |
| `scripts/poll-and-fix.sh` | For every tracked PR, if it has failing checks or unresolved comments, run the agent in the owning initiative folder. One agent per initiative at a time (uses `.locks/<initiative>.lock`). |

**Dashboard (browser):** A small TS app serves the same PR status in the browser. From `pr-watcher`:

```bash
cd app && npm install && npm start
```

Then open **http://localhost:3333**. Uses `config/tracking.json` and `scripts/lib/get-pr-status.sh` (requires `gh`).

## MCP: trigger Cursor agent from Cursor (or any MCP client)

An MCP server exposes a tool so Cursor (or another MCP client) can trigger the agent for a tracked PR when you ask (e.g. "fix PR FrontRowXP/nugs 3214").

**Run the MCP server** (stdio; Cursor spawns it):

```bash
cd ~/Projects/pr-watcher/mcp-server && npm install && npx tsx server.ts
```

**Add to Cursor MCP settings** (e.g. in Cursor → Settings → MCP, or project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "pr-watcher": {
      "command": "npx",
      "args": ["tsx", "server.ts"],
      "cwd": "/Users/brandonevery/Projects/pr-watcher/mcp-server"
    }
  }
}
```

**Tool:** `trigger_agent_for_pr(repo, number)` — runs the Cursor agent in the initiative folder that owns that PR (same as `run-agent-for-pr.sh`). Use when GH events come in and you want to fix that PR from Cursor.

## Webhook: trigger agent when GH events come in

The dashboard app can receive GitHub webhooks and run the agent for the PR in the event (comment, review, etc.) if that PR is tracked.

1. **Expose the app** (e.g. ngrok: `ngrok http 3333`) so GitHub can POST to it.
2. **GitHub repo → Settings → Webhooks → Add webhook:**
   - Payload URL: `https://your-host/webhook/github`
   - Content type: `application/json`
   - Secret: optional; if set, also set `GITHUB_WEBHOOK_SECRET` in the app env.
   - Events: e.g. "Let me select individual events" → Issue comments, Pull request reviews, Pushes (optional).
3. **Start the app** with the same config (and optional `GITHUB_WEBHOOK_SECRET`).

When GitHub sends an event for a tracked PR, the app runs `run-agent-for-pr.sh` for that PR in the background (one agent per event).

**Requirements:** `gh` (GitHub CLI), `jq`, Cursor CLI (`agent`). Install Cursor CLI: `curl https://cursor.com/install -fsS | bash`.

**One-off fix for a PR:**

```bash
cd ~/Projects/pr-watcher
./scripts/run-agent-for-pr.sh FrontRowXP/nugs 3199
```

**Poll once and fix any PR that needs attention:**

```bash
cd ~/Projects/pr-watcher
./scripts/poll-and-fix.sh
```

**Cron or loop to poll every N minutes:**

```bash
while true; do ./scripts/poll-and-fix.sh; sleep 300; done
```
