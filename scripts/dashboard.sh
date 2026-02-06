#!/usr/bin/env bash
# Show status of all tracked PRs (checks + unresolved comments).
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${DIR}/config/tracking.json"
LIB="${DIR}/scripts/lib"
if [[ ! -f "$CONFIG" ]]; then
  echo "Missing $CONFIG" >&2
  exit 1
fi

echo "PR DASHBOARD — $(date '+%Y-%m-%d %H:%M')"
echo "────────────────────────────────────────────────────────────────────────────"
printf "%-12s %-28s %5s %-20s %8s %8s\n" "INITIATIVE" "REPO" "PR#" "BRANCH" "CHECKS" "COMMENTS"
echo "────────────────────────────────────────────────────────────────────────────"

jq -r '
  .initiatives | to_entries[] | .key as $init |
  .value.prs[] | "\($init)\t\(.repo)\t\(.number)\t\(.branch // "?")"
' "$CONFIG" | while IFS=$'\t' read -r init repo number branch; do
  [[ -z "$repo" ]] && continue
  owner="${repo%%/*}"
  reponame="${repo#*/}"
  status=$("${LIB}/get-pr-status.sh" "$owner" "$reponame" "$number" 2>/dev/null) || status="failing_checks=? unresolved=?"
  failing=0
  unresolved=0
  if [[ "$status" =~ failing_checks=([0-9]+) ]]; then failing="${BASH_REMATCH[1]}"; fi
  if [[ "$status" =~ unresolved=([0-9]+) ]]; then unresolved="${BASH_REMATCH[1]}"; fi
  if [[ "$failing" -gt 0 ]]; then
    checks="❌ $failing fail"
  else
    checks="✅ pass"
  fi
  if [[ "$unresolved" -gt 0 ]]; then
    comments="${unresolved} unres"
  else
    comments="0"
  fi
  branch_short="${branch:0:18}"
  [[ ${#branch} -gt 18 ]] && branch_short="${branch_short}.."
  printf "%-12s %-28s %5s %-20s %8s %8s\n" "$init" "$repo" "#$number" "$branch_short" "$checks" "$comments"
done

echo "────────────────────────────────────────────────────────────────────────────"
echo "Legend: ✅ All passing  ❌ Failing  N unres = N unresolved review comments"
