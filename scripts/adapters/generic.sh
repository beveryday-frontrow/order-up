#!/usr/bin/env bash
# Adapter: no agent spawning — prints the prompt so it can be captured or copied.
# Usage: generic.sh WORKING_DIR PROMPT
set -e

WORKING_DIR="$1"
PROMPT="$2"

if [[ -z "$WORKING_DIR" || -z "$PROMPT" ]]; then
  echo "Usage: generic.sh WORKING_DIR PROMPT" >&2
  exit 2
fi

echo "=== Order Up! Agent Prompt ==="
echo "Working directory: $WORKING_DIR"
echo ""
echo "$PROMPT"
echo ""
echo "Paste the prompt above into your AI coding tool."
