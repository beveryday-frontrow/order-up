# PR Manager

Dashboard view and orchestration for managing multiple PRs across repositories.

## Quick Commands

### List All My Open PRs (Current Repo)

```bash
gh pr list --author "@me" --state open --json number,title,headRefName,statusCheckRollup,reviewDecision,url --jq '.[] | {number, title, branch: .headRefName, url}'
```

### List All My PRs Across All Repos

```bash
gh search prs --author "@me" --state open --json repository,number,title,url --jq '.[] | "\(.repository.nameWithOwner) #\(.number): \(.title)"'
```

### Get Preview URLs for a PR
```bash
gh pr view {NUMBER} --repo {OWNER/REPO} --json comments --jq '.comments[] | select(.body | test("preview|deploy"; "i")) | .body'
```

## Full Dashboard Workflow

### Step 1: Get All Open PRs with Full Status

```bash
gh search prs --author "@me" --state open --limit 50 --json repository,number,title,url
```

### Step 2: For Each PR, Get Detailed Status

```bash
# Get check status
gh pr checks {NUMBER} --repo {OWNER/REPO}
```

#### Getting Unresolved Comments (WITH PAGINATION)

GitHub's GraphQL API limits results to 100 items per page. PRs with many review threads need pagination.

```bash
get_unresolved_count() {
  OWNER=$1
  REPO=$2
  NUMBER=$3
  CURSOR=""
  TOTAL_UNRESOLVED=0

  while true; do
    if [ -z "$CURSOR" ]; then
      AFTER_ARG=""
    else
      AFTER_ARG=", after: \"$CURSOR\""
    fi

    RESULT=$(gh api graphql -f query="
      query(\$owner: String!, \$repo: String!, \$number: Int!) {
        repository(owner: \$owner, name: \$repo) {
          pullRequest(number: \$number) {
            reviewThreads(first: 100${AFTER_ARG}) {
              pageInfo { hasNextPage endCursor }
              nodes { isResolved isOutdated }
            }
          }
        }
      }" -f owner="$OWNER" -f repo="$REPO" -F number=$NUMBER)

    PAGE_UNRESOLVED=$(echo "$RESULT" | jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false and .isOutdated == false)] | length')
    TOTAL_UNRESOLVED=$((TOTAL_UNRESOLVED + PAGE_UNRESOLVED))

    HAS_NEXT=$(echo "$RESULT" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage')
    if [ "$HAS_NEXT" != "true" ]; then
      break
    fi
    CURSOR=$(echo "$RESULT" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor')
  done

  echo $TOTAL_UNRESOLVED
}

# Usage:
UNRESOLVED=$(get_unresolved_count "OWNER" "REPO" PR_NUMBER)
echo "Unresolved comments: $UNRESOLVED"
```

### Step 3: Display Dashboard Summary

Present results in this format:

```
+--------+------+--------------------+--------+---------+
| REPO   | PR#  | TITLE              | CHECKS | COMMENTS|
+--------+------+--------------------+--------+---------+
| org/r1 | 123  | feat: RN Chat...   |  2/5   | 3 unres |
| org/r2 | 456  | fix: auth flow     |  5/5   | 0       |
+--------+------+--------------------+--------+---------+
```

## Status Indicators

| Icon | Meaning |
|------|---------|
| PASS | All checks passing |
| PENDING | Checks in progress |
| FAIL | One or more checks failing |
| BLOCKED | Blocked (merge conflicts, required reviews) |
| ATTENTION | Needs attention (stale, comments pending) |

## Actions

After viewing the dashboard, the user can request:

1. **"Handle checks for PR #N"** - Triggers handle-checks workflow
2. **"Handle comments for PR #N"** - Triggers handle-comments workflow
3. **"Fix all issues on PR #N"** - Runs both workflows sequentially
4. **"Refresh dashboard"** - Re-run status checks

## Priority Sorting

When displaying PRs, sort by urgency:

1. **Critical**: Failing checks + unresolved comments (needs immediate attention)
2. **High**: Failing checks OR unresolved comments
3. **Medium**: Checks in progress
4. **Low**: All green, ready to merge

## Integration with Other Workflows

This workflow works in conjunction with:

- **handle-checks** - For fixing failing CI/CD
- **handle-comments** - For addressing review feedback

Typical workflow:
1. Run PR Manager to see dashboard
2. Identify PRs needing attention
3. User picks which PR to work on
4. Delegate to appropriate workflow (checks or comments)
5. Return to dashboard to verify progress

## Common Questions

### "What PRs need my attention?"
Run the dashboard and look for FAIL or ATTENTION indicators.

### "Which PR should I fix first?"
PRs with failing checks that block merging take priority over comment resolution.

### "Is this PR ready to merge?"
Check for: All checks passing, 0 unresolved comments, Approved reviews (if required), No merge conflicts.
