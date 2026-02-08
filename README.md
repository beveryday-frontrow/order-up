# Order Up!

A fun, food-themed PR monitoring dashboard that helps you track and manage pull requests across multiple repositories. Each "initiative" (feature/project) gets its own food-themed icon, and you can monitor check statuses, unresolved comments, and trigger AI agents to fix issues.

## Features

- **Initiative-based PR grouping** -- Organize PRs by project/feature with custom food icons
- **Real-time status monitoring** -- Track lint, type, test, e2e checks and unresolved comments
- **Multi-tool support** -- Works with Cursor IDE, Cursor Web, Claude Code, or any AI coding tool
- **One-click fix actions** -- Spawn agents or copy prompts to fix failing checks and comments
- **Drag-and-drop reordering** -- Prioritize initiatives your way
- **Auto-generated pixel art icons** -- Creates retro Burger Time-style icons via Gemini Imagen
- **MCP server** -- Integrates with any MCP-compatible AI tool

---

## Quick Setup

```bash
# 1. Clone the repository
git clone https://github.com/beveryday-frontrow/order-up.git
cd order-up

# 2. Install dependencies for the dashboard app
cd app && npm install

# 3. Start the dashboard
npm run dev
```

Then open **http://localhost:3333** in your browser and select your tool from the dropdown in the header.

---

## Choosing Your Tool

Order Up supports multiple AI coding tools. Select your tool from the dropdown in the dashboard header, or set it in `config/settings.json`:

```json
{
  "tool": "cursor-ide",
  "agentCommand": null
}
```

### Tool Profiles

| Tool | Agent Spawning | Deep Links | How Fix Buttons Work |
|------|---------------|------------|---------------------|
| **Cursor IDE** | Background agents via CLI | `cursor://` links | Spawns agent automatically |
| **Cursor Web** | No | `cursor://` links | Copies `@skill` command to clipboard |
| **Claude Code** | Background agents via CLI | No | Shows terminal command in modal |
| **Generic** | No | No | Shows raw prompt in modal to copy |

### Cursor IDE Setup

This is the default. Requires the Cursor CLI agent:

```bash
# Install Cursor CLI (if not already installed)
curl https://cursor.com/install -fsS | bash
```

The dashboard will spawn Cursor agents in the background when you click fix buttons. Cursor skills in `.cursor/skills/` provide context to the agent.

### Cursor Web Setup

Set tool to `cursor-web` in the dashboard dropdown. Fix actions will copy `@handle-pr-checks` or `@handle-pr-comments` commands to your clipboard for pasting into Cursor chat.

### Claude Code Setup

```bash
# 1. Install Claude Code CLI
# See: https://docs.anthropic.com/en/docs/claude-code

# 2. Set tool preference
echo '{"tool": "claude-code", "agentCommand": null}' > config/settings.json
# Or use the dashboard dropdown

# 3. Start the dashboard
cd app && npm run dev
```

Claude Code reads `CLAUDE.md` at the repo root for context, and follows the workflows in `skills/workflows/`. The dashboard will show terminal commands (`claude -p "..."`) when you click fix buttons.

### Generic / Other Tools

Set tool to `generic`. Fix actions will show the raw agent prompt in a modal for you to copy into whatever tool you use.

---

## Prerequisites

### 1. Node.js (v18+)

```bash
# Check if installed
node --version

# Install via Homebrew (macOS)
brew install node
```

### 2. GitHub CLI (`gh`)

Required for fetching PR data and check statuses.

```bash
# Check if installed
gh --version

# Install via Homebrew (macOS)
brew install gh

# Authenticate with GitHub
gh auth login
```

### 3. ImageMagick (Optional)

Required for removing backgrounds from generated initiative icons.

```bash
# Install via Homebrew (macOS)
brew install imagemagick
```

### 4. Gemini API Key (Optional)

Only needed if you want to generate custom initiative icons.

```bash
# Set in your shell profile (~/.zshrc or ~/.bashrc)
export GEMINI_API_KEY="your-gemini-api-key-here"
```

---

## Configuration

### `config/tracking.json`

Defines your initiatives and which PRs they track:

```json
{
  "initiatives": {
    "burger": {
      "path": "/Users/you/Projects/burger",
      "description": "My awesome feature",
      "prs": [
        { "repo": "owner/repo", "number": 123, "branch": "feat/my-feature" }
      ]
    }
  },
  "repoToSubfolder": {
    "owner/repo": "subfolder-name"
  }
}
```

### `config/settings.json`

Tool preference and optional agent command override:

```json
{
  "tool": "cursor-ide",
  "agentCommand": null
}
```

| Field | Description |
|-------|-------------|
| `tool` | One of: `cursor-ide`, `cursor-web`, `claude-code`, `generic` |
| `agentCommand` | Optional override for the agent CLI binary path (e.g., `/usr/local/bin/claude`). When `null`, auto-detected. |

### Adding a New Initiative

1. **Via the Dashboard:** Click the "+" button, enter a food name, and it will generate an icon, create folders, and clone repos.

2. **Manually:** Add an entry to `config/tracking.json`.

---

## AI Tool Integration

### Cursor Skills

For Cursor IDE/Web users, Order Up includes skills in `.cursor/skills/`:

- `@handle-pr-checks` -- Fix failing CI checks
- `@handle-pr-comments` -- Resolve PR review comments
- `@pr-manager` -- PR dashboard and orchestration

### Claude Code

For Claude Code users, `CLAUDE.md` at the repo root provides equivalent context. Workflows are in `skills/workflows/`.

### Portable Workflows

Tool-agnostic workflow definitions live in `skills/workflows/`:

- `handle-checks.md` -- Step-by-step guide to fix failing CI checks
- `handle-comments.md` -- Step-by-step guide to resolve PR review comments
- `pr-manager.md` -- PR dashboard and orchestration

These contain `gh` CLI commands and git operations that work with any tool.

---

## MCP Server (Optional)

The MCP server allows AI tools to trigger PR fixes programmatically:

```bash
# Install and run
cd mcp-server && npm install
npx tsx server.ts
```

### Add to Cursor MCP settings (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "order-up": {
      "command": "npx",
      "args": ["tsx", "server.ts"],
      "cwd": "/path/to/order-up/mcp-server"
    }
  }
}
```

### Add to Claude Code MCP settings:

Claude Code also supports MCP servers. Add the same configuration to your Claude Code MCP settings.

The MCP server reads `config/settings.json` to determine which agent adapter to use.

---

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/show-tracking.sh` | Print which initiatives manage which PRs |
| `scripts/pull-open-prs.sh` | List open PRs for all configured repos |
| `scripts/run-agent-for-pr.sh REPO NUMBER` | Run agent to fix a specific PR (uses configured tool) |
| `scripts/poll-and-fix.sh` | Check all tracked PRs and fix any with issues |
| `scripts/dashboard.sh` | CLI dashboard view (terminal-friendly) |

### Agent Adapters

The `scripts/adapters/` directory contains tool-specific agent runners:

| Adapter | Used By |
|---------|---------|
| `adapters/cursor.sh` | Cursor IDE, Cursor Web |
| `adapters/claude-code.sh` | Claude Code |
| `adapters/generic.sh` | Generic (prints prompt) |

`run-agent-for-pr.sh` reads `config/settings.json` and delegates to the appropriate adapter.

---

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `GEMINI_API_KEY` | Google Gemini API key for generating initiative icons (Imagen) | No (icons are optional) |
| `GITHUB_TOKEN` | GitHub token (uses `gh` auth by default) | No |
| `PORT` | Dashboard port (default: 3333) | No |

---

## Project Structure

```
order-up/
├── app/                        # Express server + dashboard UI
│   ├── server.ts               # Main backend (port 3333)
│   ├── public/index.html       # Dashboard frontend
│   └── electron-main.cjs       # Electron desktop wrapper
├── config/
│   ├── tracking.json           # Initiative/PR tracking config
│   └── settings.json           # Tool preference
├── skills/
│   └── workflows/              # Portable workflow definitions
│       ├── handle-checks.md
│       ├── handle-comments.md
│       └── pr-manager.md
├── scripts/
│   ├── adapters/               # Tool-specific agent adapters
│   │   ├── cursor.sh
│   │   ├── claude-code.sh
│   │   └── generic.sh
│   ├── run-agent-for-pr.sh     # Agent router
│   └── lib/                    # Helper scripts
├── mcp-server/                 # MCP server for IDE integration
├── .cursor/skills/             # Cursor-specific skills
├── CLAUDE.md                   # Claude Code context file
└── README.md
```

---

## Troubleshooting

### "gh: command not found"

Install GitHub CLI:
```bash
brew install gh && gh auth login
```

### "magick: command not found"

Install ImageMagick:
```bash
brew install imagemagick
```

### Agent not spawning

1. Check your tool setting: `cat config/settings.json`
2. For Cursor IDE: verify `agent` or `cursor-agent` is in your PATH
3. For Claude Code: verify `claude` is in your PATH
4. Check adapter scripts have execute permission: `chmod +x scripts/adapters/*.sh`

### PR data not loading

1. Check that `gh` is authenticated: `gh auth status`
2. Verify you have access to the repos in your config
3. Check the terminal for error messages

---

## Development

```bash
# Run in development mode (auto-restart on changes)
cd app && npm run dev

# The app watches for changes to server.ts
```

---

## License

MIT
