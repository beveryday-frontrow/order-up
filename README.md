# 🍔 Order Up!

A fun, food-themed PR monitoring dashboard that helps you track and manage pull requests across multiple repositories. Each "initiative" (feature/project) gets its own food-themed icon, and you can monitor check statuses, unresolved comments, and quickly copy commands to fix issues.

## Features

- **Initiative-based PR grouping** — Organize PRs by project/feature with custom food icons
- **Real-time status monitoring** — Track lint, type, test, e2e checks and unresolved comments
- **One-click commands** — Copy fix commands to paste into Cursor
- **Drag-and-drop reordering** — Prioritize initiatives your way
- **Auto-generated pixel art icons** — Creates retro Burger Time-style icons via DALL-E
- **Cursor Skills integration** — Use `@handle-pr-checks` and `@handle-pr-comments` skills

---

## Prerequisites

Before setting up Order Up!, make sure you have the following installed:

### 1. Node.js (v18+)

```bash
# Check if installed
node --version

# Install via Homebrew (macOS)
brew install node

# Or download from https://nodejs.org/
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

### 3. ImageMagick

Required for removing backgrounds from generated initiative icons.

```bash
# Check if installed
magick --version

# Install via Homebrew (macOS)
brew install imagemagick
```

### 4. OpenAI API Key (Optional)

Only needed if you want to generate custom initiative icons via DALL-E.

```bash
# Set in your shell profile (~/.zshrc or ~/.bashrc)
export GEMINI_API_KEY="your-gemini-api-key-here"
```

Get your API key from: https://platform.openai.com/api-keys

---

## Quick Setup

Run these commands to get up and running:

```bash
# 1. Clone the repository
git clone https://github.com/beveryday-frontrow/order-up.git
cd order-up

# 2. Install dependencies for the dashboard app
cd app && npm install

# 3. Start the dashboard
npm run dev
```

Then open **http://localhost:3333** in your browser.

---

## Configuration

### `config/tracking.json`

This file defines your initiatives and which PRs they track:

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

#### Initiative Properties

| Property | Description |
|----------|-------------|
| `path` | Absolute path to the project folder (used for "Open in Cursor" links) |
| `description` | Optional description shown in the focus input |
| `prs` | Array of PRs this initiative manages |

#### PR Properties

| Property | Description |
|----------|-------------|
| `repo` | GitHub repo in `owner/repo` format |
| `number` | PR number |
| `branch` | Branch name (optional, helps with checkout commands) |

### Adding a New Initiative

1. **Via the Dashboard:** Click the "+" button, enter a food name, and it will:
   - Generate a pixel art icon via DALL-E
   - Create the folder structure
   - Clone your configured repos into it

2. **Manually:** Add an entry to `config/tracking.json`:

```json
"taco": {
  "path": "/Users/you/Projects/taco",
  "description": "Taco feature",
  "prs": []
}
```

---

## Cursor Skills

Order Up! includes Cursor skills that help AI agents fix PR issues:

### `@handle-pr-checks`

Fetches failing check details and helps fix lint, type, test, or e2e failures.

**Usage:** When a check is failing, click on it to copy a command like:
```
Use @handle-pr-checks for PR #123 (failing lint check): https://github.com/owner/repo/pull/123
```

### `@handle-pr-comments`

Fetches unresolved PR comments and helps address reviewer feedback.

**Usage:** Click on unresolved comments count to copy:
```
Use @handle-pr-comments for PR #123 (3 unresolved comments): https://github.com/owner/repo/pull/123
```

### `@pr-manager`

Dashboard view skill for managing multiple PRs.

---

## MCP Server (Optional)

An MCP server allows Cursor to trigger PR fixes directly:

```bash
# Install and run
cd mcp-server && npm install
npx tsx server.ts
```

Add to your Cursor MCP settings (`.cursor/mcp.json`):

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

---

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/show-tracking.sh` | Print which initiatives manage which PRs |
| `scripts/pull-open-prs.sh` | List open PRs for all configured repos |
| `scripts/run-agent-for-pr.sh REPO NUMBER` | Run Cursor agent to fix a specific PR |
| `scripts/poll-and-fix.sh` | Check all tracked PRs and fix any with issues |

---

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `GEMINI_API_KEY` | Google Gemini API key for generating initiative icons (Imagen) | No (icons are optional) |
| `GITHUB_TOKEN` | GitHub token (uses `gh` auth by default) | No |
| `PORT` | Dashboard port (default: 3333) | No |

---

## One-Line Setup Script

Copy and paste this to set everything up at once:

```bash
# Full setup (run from anywhere)
git clone https://github.com/beveryday-frontrow/order-up.git ~/Projects/order-up && \
cd ~/Projects/order-up/app && \
npm install && \
npm run dev
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

### Initiative icons have green backgrounds

The app uses ImageMagick to remove green backgrounds from DALL-E generated images. If this fails:

```bash
# Manually remove green background from an image
magick input.png -alpha set -fuzz 30% -fill none -opaque "#00FF00" output.png
```

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

---

**Made with 🍟 by the Order Up! team**
