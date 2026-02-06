#!/usr/bin/env bash
# Usage: run-agent-for-pr.sh REPO NUMBER [CHECK] [PATH]
#   REPO = owner/name (e.g. FrontRowXP/nugs)
#   NUMBER = PR number
#   CHECK = optional: lint|type|test|e2e|other — fix only this category of CI checks
#   PATH = optional: initiative folder path (if not set, looked up from config)
set -e
REPO="$1"
NUMBER="$2"
CHECK="${3:-}"
PATH_="${4:-}"
if [[ -z "$REPO" || -z "$NUMBER" ]]; then
  echo "Usage: run-agent-for-pr.sh REPO NUMBER [CHECK] [PATH]" >&2
  echo "  CHECK = optional: lint, type, test, e2e, other" >&2
  echo "  PATH = optional: initiative folder (else looked up from config)" >&2
  echo "  e.g. run-agent-for-pr.sh FrontRowXP/nugs 3199 lint" >&2
  exit 2
fi

if [[ -z "$PATH_" ]]; then
  DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  CONFIG="${DIR}/config/tracking.json"
  if [[ ! -f "$CONFIG" ]]; then
    echo "Missing $CONFIG" >&2
    exit 1
  fi
  PATH_=$(jq -r --arg repo "$REPO" --argjson num "$NUMBER" '
    .initiatives | to_entries[] |
    select(.value.prs | length > 0) |
    select(.value.prs | any(.repo == $repo and .number == $num)) |
    .value.path
  ' "$CONFIG" 2>/dev/null)
  if [[ -z "$PATH_" || "$PATH_" == "null" ]]; then
    echo "No initiative path for $REPO#$NUMBER. Pass PATH as 4th arg or add PR to config." >&2
    exit 1
  fi
fi

# Cursor CLI: prefer agent, else cursor-agent in ~/.local/bin
AGENT_CMD=""
if command -v agent &>/dev/null; then
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

echo "Initiative path: $PATH_"
echo "Running Cursor agent for $REPO#$NUMBER${CHECK:+ (focus: $CHECK)}..."
cd "$PATH_"

case "$CHECK" in
  lint)   FOCUS="Fix only the failing **Lint** CI checks (lint, eslint, biome, prettier)."; ;;
  type)   FOCUS="Fix only the failing **Type** CI checks (typecheck, tsc)."; ;;
  test)   FOCUS="Fix only the failing **Test** CI checks (unit tests, jest, vitest, coverage)."; ;;
  e2e)    FOCUS="Fix only the failing **E2E** CI checks (playwright, cypress, end-to-end)."; ;;
  other)  FOCUS="Fix only the failing **Other** CI checks (non-lint/type/test/e2e)."; ;;
  *)      FOCUS="Fix all failing CI checks and address all unresolved review comments."; ;;
esac

exec "$AGENT_CMD" -p "Handle PR #${NUMBER} in ${REPO}: ${FOCUS} Use \`gh\` and the pr-manager / handle-pr-comments workflow. Push fixes and re-check. Work in the subfolder for this repo if needed."
