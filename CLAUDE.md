# Order Up! — Claude Code Context

Order Up is a food-themed PR monitoring dashboard that tracks and manages pull requests across multiple repositories. Each "initiative" (feature/project) gets a food-themed icon, and you can monitor check statuses, unresolved comments, and trigger fixes.

## Project Structure

```
order-up/
├── app/                    # Express server + dashboard UI
│   ├── server.ts           # Main backend (port 3333)
│   └── public/index.html   # Dashboard frontend
├── config/
│   ├── tracking.json       # Initiative/PR tracking config
│   └── settings.json       # Tool preference (cursor-ide, claude-code, etc.)
├── skills/workflows/       # Portable workflow definitions (tool-agnostic)
│   ├── handle-checks.md    # Fix failing CI checks
│   ├── handle-comments.md  # Resolve PR review comments
│   └── pr-manager.md       # PR dashboard & orchestration
├── scripts/
│   ├── adapters/           # Tool-specific agent adapters
│   ├── run-agent-for-pr.sh # Agent router (reads settings, delegates to adapter)
│   └── lib/                # Helper scripts
└── mcp-server/             # MCP server for IDE integration
```

## Workflows

When asked to handle PR issues, follow the workflows in `skills/workflows/`:

- **Failing CI checks**: Follow `skills/workflows/handle-checks.md`
- **Unresolved PR comments**: Follow `skills/workflows/handle-comments.md`
- **PR dashboard overview**: Follow `skills/workflows/pr-manager.md`

## Status Reporting

When working on PR fixes, report your status to the Order Up dashboard API so the user can track progress in real-time:

```bash
# Report start
curl -X POST http://localhost:3333/api/agent-job \
  -H "Content-Type: application/json" \
  -d '{"repo":"OWNER/REPO","number":PR_NUM,"status":"running","type":"checks"}'

# Report completion
curl -X POST http://localhost:3333/api/agent-job \
  -H "Content-Type: application/json" \
  -d '{"repo":"OWNER/REPO","number":PR_NUM,"status":"complete","type":"checks","summary":"Fixed 3 failing checks"}'

# Report failure
curl -X POST http://localhost:3333/api/agent-job \
  -H "Content-Type: application/json" \
  -d '{"repo":"OWNER/REPO","number":PR_NUM,"status":"failed","type":"checks","error":"Could not resolve type errors"}'
```

The `type` field should be `"checks"`, `"comments"`, or `"all"`.

## Key APIs

The dashboard runs at `http://localhost:3333` and exposes:

- `GET /api/status` — All PR statuses grouped by initiative
- `GET /api/pr?repo=OWNER/REPO&number=N` — Single PR status
- `GET /api/pr-comments?repo=OWNER/REPO&number=N` — Unresolved review comments
- `GET /api/check-failures?repo=OWNER/REPO&number=N` — Detailed check failure info
- `POST /api/agent-job` — Report agent job status (see above)
- `GET /api/settings` — Read tool preference
- `POST /api/settings` — Update tool preference

## Configuration

### `config/tracking.json`

Defines initiatives and their tracked PRs:

```json
{
  "initiatives": {
    "burger": {
      "path": "/Users/you/Projects/burger",
      "description": "My feature",
      "prs": [
        { "repo": "owner/repo", "number": 123, "branch": "feat/my-feature" }
      ]
    }
  }
}
```

### `config/settings.json`

Tool preference — should be set to `"claude-code"` for Claude Code users:

```json
{
  "tool": "claude-code",
  "agentCommand": null
}
```

## Prerequisites

- `gh` CLI authenticated (`gh auth login`)
- Node.js v18+ (for running the dashboard)
- Dashboard running (`cd app && npm run dev`)
