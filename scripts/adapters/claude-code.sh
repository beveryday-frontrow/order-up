#!/usr/bin/env bash
# Adapter: spawn a Claude Code agent with the given prompt.
# Usage: claude-code.sh WORKING_DIR PROMPT [AGENT_CMD_OVERRIDE]
set -e

WORKING_DIR="$1"
PROMPT="$2"
AGENT_CMD_OVERRIDE="$3"

if [[ -z "$WORKING_DIR" || -z "$PROMPT" ]]; then
  echo "Usage: claude-code.sh WORKING_DIR PROMPT [AGENT_CMD_OVERRIDE]" >&2
  exit 2
fi

# Resolve the Claude CLI
CLAUDE_CMD=""
if [[ -n "$AGENT_CMD_OVERRIDE" ]]; then
  CLAUDE_CMD="$AGENT_CMD_OVERRIDE"
elif command -v claude &>/dev/null; then
  CLAUDE_CMD="claude"
elif [[ -x "$HOME/.local/bin/claude" ]]; then
  CLAUDE_CMD="$HOME/.local/bin/claude"
elif [[ -x "/usr/local/bin/claude" ]]; then
  CLAUDE_CMD="/usr/local/bin/claude"
fi

if [[ -z "$CLAUDE_CMD" ]]; then
  echo "Claude Code CLI not found. Install: https://docs.anthropic.com/en/docs/claude-code" >&2
  exit 1
fi

cd "$WORKING_DIR"
exec "$CLAUDE_CMD" -p "$PROMPT" --allowedTools "Bash,Read,Write,Edit,Glob,Grep"
