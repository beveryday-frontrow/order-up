#!/usr/bin/env bash
# Show which initiative folders manage which PRs (reads config/tracking.json)
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${DIR}/config/tracking.json"
if [[ ! -f "$CONFIG" ]]; then
  echo "Missing $CONFIG"
  exit 1
fi
echo "Initiative → path"
echo "----------------"
jq -r '.initiatives | to_entries[] | "\(.key): \(.value.path)"' "$CONFIG"
echo ""
echo "Initiative → PRs"
echo "----------------"
jq -r '
  .initiatives | to_entries[] |
  .key as $name | .value.prs as $prs |
  ($prs | map("  \(.repo)#\(.number) (\(.branch // "?"))") | join("\n")) as $lines |
  (if ($prs | length) == 0 then "  (none)" else $lines end) as $body |
  "\($name):\n\($body)\n"
' "$CONFIG"
