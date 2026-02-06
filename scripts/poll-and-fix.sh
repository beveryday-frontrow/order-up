#!/usr/bin/env bash
# Poll all tracked PRs; for any with failing checks or unresolved comments, run Cursor agent
# in the initiative folder that owns that PR. One agent per initiative at a time (lock).
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${DIR}/config/tracking.json"
LIB="${DIR}/scripts/lib"
LOCK_DIR="${DIR}/.locks"
mkdir -p "$LOCK_DIR"

if [[ ! -f "$CONFIG" ]]; then
  echo "Missing $CONFIG" >&2
  exit 1
fi

# get-pr-status.sh exits 1 when PR has failing checks or unresolved comments
needs_attention() {
  local owner="$1" repo="$2" num="$3"
  "${LIB}/get-pr-status.sh" "$owner" "$repo" "$num" >/dev/null 2>&1
  [[ $? -eq 1 ]]
}

# Build list: REPO NUMBER INITIATIVE (one per line)
PR_LIST=$(jq -r '
  .initiatives | to_entries[] | .key as $init |
  .value.prs[] | "\(.repo) \(.number) \($init)"
' "$CONFIG")

while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  repo=$(echo "$line" | awk '{print $1}')
  num=$(echo "$line" | awk '{print $2}')
  init=$(echo "$line" | awk '{print $3}')
  owner="${repo%%/*}"
  reponame="${repo#*/}"

  if ! needs_attention "$owner" "$reponame" "$num" 2>/dev/null; then
    continue
  fi
  echo "Needs attention: $repo#$num (initiative: $init)"

  lockfile="${LOCK_DIR}/${init}.lock"
  if [[ -f "$lockfile" ]]; then
    echo "  Skipping: $init already has an agent run in progress" >&2
    continue
  fi
  echo "  Starting agent for $repo#$num in $init..."
  touch "$lockfile"
  if "${DIR}/scripts/run-agent-for-pr.sh" "$repo" "$num"; then
    echo "  Done: $repo#$num"
  else
    echo "  Agent exited non-zero: $repo#$num" >&2
  fi
  rm -f "$lockfile"
done <<< "$PR_LIST"

echo "Poll complete."
