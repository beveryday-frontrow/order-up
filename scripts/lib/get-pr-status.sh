#!/usr/bin/env bash
# Usage: get-pr-status.sh OWNER REPO NUMBER
# Output (stdout): failing_checks=N unresolved=N (one line)
# Exit: 0 if ok, 1 if PR needs attention (failing > 0 or unresolved > 0)
set -e
OWNER="$1"
REPO="$2"
NUMBER="$3"
if [[ -z "$OWNER" || -z "$REPO" || -z "$NUMBER" ]]; then
  echo "Usage: get-pr-status.sh OWNER REPO NUMBER" >&2
  exit 2
fi

# Failing checks count (only status column "fail", not job names like "on-failure")
FAILING=$(gh pr checks "$NUMBER" --repo "$OWNER/$REPO" 2>/dev/null | awk -F'\t' '$2=="fail" {count++} END {print count+0}' || echo "0")

# Unresolved review threads: paginate through ALL pages (GitHub returns max 100 per page)
get_unresolved_count() {
  local o="$1" r="$2" num="$3"
  local cursor total=0
  while true; do
    local result
    # Pass $after as a variable so cursor is safe (no injection / special chars in query string)
    if [[ -n "${cursor:-}" ]]; then
      result=$(gh api graphql -f query='
        query($owner: String!, $repo: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes { isResolved isOutdated }
              }
            }
          }
        }' -f owner="$o" -f repo="$r" -F number="$num" -f after="$cursor" 2>/dev/null) || result='{"data":{}}'
    else
      result=$(gh api graphql -f query='
        query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewThreads(first: 100) {
                pageInfo { hasNextPage endCursor }
                nodes { isResolved isOutdated }
              }
            }
          }
        }' -f owner="$o" -f repo="$r" -F number="$num" 2>/dev/null) || result='{"data":{}}'
    fi
    local page
    page=$(echo "$result" | jq -r '[.data.repository.pullRequest.reviewThreads.nodes[]? | select(.isResolved == false and .isOutdated == false)] | length' 2>/dev/null || echo "0")
    page=${page//[^0-9]/}
    page=${page:-0}
    total=$((total + page))
    local has_next
    has_next=$(echo "$result" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage // false' 2>/dev/null)
    [[ "$has_next" != "true" ]] && break
    cursor=$(echo "$result" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor // ""' 2>/dev/null)
    [[ -z "$cursor" ]] && break
  done
  echo "$total"
}
UNRESOLVED=$(get_unresolved_count "$OWNER" "$REPO" "$NUMBER" 2>/dev/null | head -1 || echo "0")
# Ensure numeric (strip non-digits, default to 0 if empty)
FAILING=${FAILING//[^0-9]/}
UNRESOLVED=${UNRESOLVED//[^0-9]/}
FAILING=${FAILING:-0}
UNRESOLVED=${UNRESOLVED:-0}
FAILING=$((FAILING + 0))
UNRESOLVED=$((UNRESOLVED + 0))

echo "failing_checks=$FAILING unresolved=$UNRESOLVED"
if [[ "$FAILING" -gt 0 || "$UNRESOLVED" -gt 0 ]]; then
  exit 1
fi
exit 0
