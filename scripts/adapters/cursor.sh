#!/usr/bin/env bash
# Adapter: spawn a Cursor IDE agent with the given prompt.
# Usage: cursor.sh WORKING_DIR PROMPT [AGENT_CMD_OVERRIDE]
set -e

WORKING_DIR="$1"
PROMPT="$2"
AGENT_CMD_OVERRIDE="$3"

if [[ -z "$WORKING_DIR" || -z "$PROMPT" ]]; then
  echo "Usage: cursor.sh WORKING_DIR PROMPT [AGENT_CMD_OVERRIDE]" >&2
  exit 2
fi

# Resolve the Cursor agent CLI
AGENT_CMD=""
if [[ -n "$AGENT_CMD_OVERRIDE" ]]; then
  AGENT_CMD="$AGENT_CMD_OVERRIDE"
elif command -v agent &>/dev/null; then
  AGENT_CMD="agent"
elif [[ -x "$HOME/.local/bin/cursor-agent" ]]; then
  AGENT_CMD="$HOME/.local/bin/cursor-agent"
elif [[ -x "$HOME/.local/bin/agent" ]]; then
  AGENT_CMD="$HOME/.local/bin/agent"
fi

if [[ -z "$AGENT_CMD" ]]; then
  echo "Cursor CLI not found. Add ~/.local/bin to PATH or install: curl https://cursor.com/install -fsS | bash" >&2
  exit 1
fi

cd "$WORKING_DIR"
exec "$AGENT_CMD" -p "$PROMPT"
