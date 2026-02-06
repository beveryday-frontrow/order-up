#!/usr/bin/env bash
# Report-only: list open PRs for every repo in config repoToSubfolder.
# Does not modify config/tracking.json.
# Usage: pull-open-prs.sh [config path]
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${1:-${DIR}/config/tracking.json}"

if [[ ! -f "$CONFIG" ]]; then
  echo "Missing $CONFIG" >&2
  exit 1
fi

# Repos from repoToSubfolder
REPOS=$(jq -r '.repoToSubfolder | keys[]' "$CONFIG")

echo "Open PRs (repos from config repoToSubfolder)"
echo "============================================="

for repo in $REPOS; do
  echo ""
  echo "--- $repo ---"
  list=$(gh pr list --repo "$repo" --state open --json number,title,headRefName 2>/dev/null) || list="[]"
  count=$(echo "$list" | jq -r 'length')
  if [[ "$count" -eq 0 ]]; then
    echo "  (none)"
    continue
  fi
  lines=$(echo "$list" | jq -r '.[] | "\(.number)\t\(.headRefName)\t\(.title)"')
  while IFS=$'\t' read -r num branch title; do
    init=$(jq -r --arg repo "$repo" --argjson num "$num" '
      .initiatives | to_entries[] | select(.value.prs | any(.repo == $repo and .number == $num)) | .key
    ' "$CONFIG" 2>/dev/null | head -n1)
    if [[ -n "$init" && "$init" != "null" ]]; then
      echo "  #${num} ${branch}  (tracked: ${init})"
    else
      echo "  #${num} ${branch}"
    fi
    echo "    ${title}"
  done <<< "$lines"
done

echo ""
echo "Done. Edit config/tracking.json to add or move PRs."
