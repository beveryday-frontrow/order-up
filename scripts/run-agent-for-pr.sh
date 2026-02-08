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

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "$PATH_" ]]; then
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

# Read tool preference from settings
SETTINGS="${DIR}/config/settings.json"
TOOL="cursor-ide"
AGENT_CMD_OVERRIDE=""
if [[ -f "$SETTINGS" ]]; then
  TOOL=$(jq -r '.tool // "cursor-ide"' "$SETTINGS" 2>/dev/null || echo "cursor-ide")
  AGENT_CMD_OVERRIDE=$(jq -r '.agentCommand // ""' "$SETTINGS" 2>/dev/null || echo "")
fi

echo "Initiative path: $PATH_"
echo "Tool: $TOOL"
echo "Running agent for $REPO#$NUMBER${CHECK:+ (focus: $CHECK)}..."

case "$CHECK" in
  lint)   FOCUS="Fix only the failing **Lint** CI checks (lint, eslint, biome, prettier)."; ;;
  type)   FOCUS="Fix only the failing **Type** CI checks (typecheck, tsc)."; ;;
  test)   FOCUS="Fix only the failing **Test** CI checks (unit tests, jest, vitest, coverage)."; ;;
  e2e)    FOCUS="Fix only the failing **E2E** CI checks (playwright, cypress, end-to-end)."; ;;
  other)  FOCUS="Fix only the failing **Other** CI checks (non-lint/type/test/e2e)."; ;;
  *)      FOCUS="Fix all failing CI checks and address all unresolved review comments."; ;;
esac

PROMPT="Handle PR #${NUMBER} in ${REPO}: ${FOCUS} Use \`gh\` and the pr-manager / handle-pr-comments workflow. Push fixes and re-check. Work in the subfolder for this repo if needed."

ADAPTERS_DIR="${DIR}/scripts/adapters"

case "$TOOL" in
  cursor-ide|cursor-web)
    exec "${ADAPTERS_DIR}/cursor.sh" "$PATH_" "$PROMPT" "$AGENT_CMD_OVERRIDE"
    ;;
  claude-code)
    exec "${ADAPTERS_DIR}/claude-code.sh" "$PATH_" "$PROMPT" "$AGENT_CMD_OVERRIDE"
    ;;
  generic|*)
    exec "${ADAPTERS_DIR}/generic.sh" "$PATH_" "$PROMPT"
    ;;
esac
