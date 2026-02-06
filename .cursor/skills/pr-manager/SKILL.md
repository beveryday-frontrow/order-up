---
name: pr-manager
description: Track and manage multiple PRs across repos. Lists all open PRs with check status and unresolved comments, providing a dashboard view and easy triggers to fix issues. Supports Feature Bundles to group related PRs across repos. Use when user wants to see PR status, manage multiple PRs, get a PR dashboard, check what needs attention, or track related PRs for a feature.
---

# PR Manager

Dashboard view and orchestration for managing multiple PRs across repositories.

## Feature Bundles

Group related PRs across repos to track a complete feature rollout.

### Active Feature Bundles

#### RN Community Chat (4 PRs)

| Repo | PR | Branch | Status | Preview |
|------|-----|--------|--------|---------|
| FrontRowXP/nugs | [#3188](https://github.com/FrontRowXP/nugs/pull/3188) | `feat/rn-community-chat` | ⏳ Pending | [Viewer](https://preview-3188.frontrow.cc?earlyAccess=G0WEBSG0) / [Creator](https://preview-3188.creator.frontro.com) |
| FrontRowXP/backend | [#4567](https://github.com/FrontRowXP/backend/pull/4567) | `feat/realtime-sse-polls-chat` | ⏳ Skipping | [API](https://pr-4567.preview.api.frontrow.cc) / [GraphQL](https://pr-4567.preview.api.frontrow.cc/query) |
| FrontRowXP/creator-ios | [#2102](https://github.com/FrontRowXP/frontrow-creator-ios/pull/2102) | `asana-.../rn-community-chat` | ✅ Pass | TestFlight |
| FrontRowXP/creator-android | [#1530](https://github.com/FrontRowXP/frontrow-creator-android/pull/1530) | `feat/rn-community-chat` | ❌ 2 Failing | Firebase |

**Bundle Status**: 🟡 1 PR needs attention (Android #1530 has failing checks)

### Creating a Feature Bundle

To create a bundle, provide:
1. Feature name
2. List of PRs (repo + number)

Example command: "Create a feature bundle called 'New Onboarding' with nugs#3200, backend#4580, ios#2110"

### Bundle Commands

- **"Show RN Community Chat bundle"** → Display the bundle table above
- **"Fix all checks in RN Community Chat bundle"** → Run handle-pr-checks on each failing PR
- **"Handle all comments in [bundle]"** → Run handle-pr-comments on each PR with unresolved comments
- **"Update bundle status"** → Refresh all PR statuses

## Quick Commands

### Show Feature Bundle Status
```bash
# For each PR in the bundle, get status in parallel
for PR in "FrontRowXP/nugs#3188" "FrontRowXP/backend#4567" "FrontRowXP/frontrow-creator-ios#2102" "FrontRowXP/frontrow-creator-android#1530"; do
  REPO=$(echo "$PR" | cut -d'#' -f1)
  NUM=$(echo "$PR" | cut -d'#' -f2)
  gh pr checks "$NUM" --repo "$REPO" 2>/dev/null | grep -c "fail" || echo "0"
done
```

### List All My Open PRs (Current Repo)

```bash
gh pr list --author "@me" --state open --json number,title,headRefName,statusCheckRollup,reviewDecision,url --jq '.[] | {number, title, branch: .headRefName, url}'
```

### List All My PRs Across All Repos I've Contributed To

```bash
gh search prs --author "@me" --state open --json repository,number,title,url --jq '.[] | "\(.repository.nameWithOwner) #\(.number): \(.title)"'
```

### Get Preview URLs for a PR
```bash
gh pr view {NUMBER} --repo {OWNER/REPO} --json comments --jq '.comments[] | select(.body | test("preview|deploy"; "i")) | .body'
```

## Full Dashboard Workflow

### Step 1: Get All Open PRs with Full Status

Run this to get a comprehensive view of all your PRs:

```bash
# Get all open PRs you authored
gh search prs --author "@me" --state open --limit 50 --json repository,number,title,url
```

### Step 2: For Each PR, Get Detailed Status

For each PR found, gather details:

```bash
# Get check status
gh pr checks {NUMBER} --repo {OWNER/REPO}
```

#### Getting Unresolved Comments (WITH PAGINATION)

**IMPORTANT:** GitHub's GraphQL API limits results to 100 items per page. PRs with many review threads need pagination to get accurate unresolved counts.

```bash
# Function to get ALL unresolved threads with pagination
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
UNRESOLVED=$(get_unresolved_count "FrontRowXP" "nugs" 3188)
echo "Unresolved comments: $UNRESOLVED"
```

#### Simple Query (for PRs with <100 review threads)

For smaller PRs, this simpler query works:

```bash
gh api graphql -f query='
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        totalCount
        pageInfo { hasNextPage }
        nodes { isResolved, isOutdated }
      }
    }
  }
}' -f owner="{OWNER}" -f repo="{REPO}" -F number={NUMBER} --jq '{
  total: .data.repository.pullRequest.reviewThreads.totalCount,
  hasMore: .data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage,
  unresolvedInPage: [.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false and .isOutdated == false)] | length
}'
```

**If `hasMore` is true, you MUST paginate to get accurate counts!**

#### Comprehensive Status Query

```bash
gh api graphql -f query='
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        totalCount
        pageInfo { hasNextPage }
        nodes { isResolved isOutdated }
      }
      reviews(first: 50, states: [PENDING]) {
        totalCount
      }
      latestReviews(first: 10) {
        nodes {
          author { login }
          state
          body
        }
      }
    }
  }
}' -f owner="{OWNER}" -f repo="{REPO}" -F number={NUMBER} --jq '{
  totalThreads: .data.repository.pullRequest.reviewThreads.totalCount,
  needsPagination: .data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage,
  unresolvedInFirstPage: [.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false and .isOutdated == false)] | length,
  pendingReviews: .data.repository.pullRequest.reviews.totalCount,
  recentReviewsWithBody: [.data.repository.pullRequest.latestReviews.nodes[] | select(.body != "")] | length
}'
```

**Why the comprehensive query matters:**
- `reviewThreads` - Inline code comments (most common)
- `totalCount` - Total threads to know if pagination needed
- `hasNextPage` - **Critical** - if true, must paginate for accurate count
- `isOutdated` filter - Excludes comments on old code that's been updated
- `pendingReviews` - Your own draft reviews not yet submitted
- `latestReviews with body` - Review summaries (like Cursor Bugbot findings) that need attention

### Step 3: Display Dashboard Summary

Present results in this format:

```
┌─────────────────────────────────────────────────────────────────────┐
│ PR DASHBOARD - {DATE}                                               │
├─────────────────────────────────────────────────────────────────────┤
│ REPO                  │ PR#  │ TITLE              │ CHECKS │ COMMENTS│
├───────────────────────┼──────┼────────────────────┼────────┼─────────┤
│ FrontRowXP/nugs       │ 3188 │ feat: RN Chat...   │ ⏳ 2/5 │ 3 unres │
│ FrontRowXP/backend    │ 456  │ fix: auth flow     │ ✅ 5/5 │ 0       │
│ FrontRowXP/infra      │ 789  │ chore: k8s update  │ ❌ 1/3 │ 5 unres │
└───────────────────────┴──────┴────────────────────┴────────┴─────────┘

Legend: ✅ All passing  ⏳ In progress  ❌ Failing  🔴 Blocked
```

## Status Indicators

| Icon | Meaning |
|------|---------|
| ✅ | All checks passing |
| ⏳ | Checks in progress |
| ❌ | One or more checks failing |
| 🔴 | Blocked (merge conflicts, required reviews) |
| 🟡 | Needs attention (stale, comments pending) |

## Actions

After viewing the dashboard, the user can request:

1. **"Handle checks for PR #{N}"** → Triggers `handle-pr-checks` skill
2. **"Handle comments for PR #{N}"** → Triggers `handle-pr-comments` skill
3. **"Fix all issues on PR #{N}"** → Runs both skills sequentially
4. **"Refresh dashboard"** → Re-run status checks

## Automated Status Script

For a quick one-liner status check:

```bash
# Quick status of all your PRs
gh search prs --author "@me" --state open --json repository,number,title | while read -r line; do
  REPO=$(echo "$line" | jq -r '.repository.nameWithOwner')
  NUM=$(echo "$line" | jq -r '.number')
  TITLE=$(echo "$line" | jq -r '.title' | cut -c1-40)
  CHECKS=$(gh pr checks "$NUM" --repo "$REPO" 2>/dev/null | grep -c "pass" || echo "?")
  TOTAL=$(gh pr checks "$NUM" --repo "$REPO" 2>/dev/null | wc -l | tr -d ' ')
  echo "$REPO #$NUM: $TITLE [$CHECKS/$TOTAL checks]"
done
```

## Priority Sorting

When displaying PRs, sort by urgency:

1. **Critical**: Failing checks + unresolved comments (needs immediate attention)
2. **High**: Failing checks OR unresolved comments
3. **Medium**: Checks in progress
4. **Low**: All green, ready to merge

## Integration with Other Skills

This skill works in conjunction with:

- **handle-pr-checks**: For fixing failing CI/CD
- **handle-pr-comments**: For addressing review feedback

Typical workflow:
1. Run PR Manager to see dashboard
2. Identify PRs needing attention
3. User picks which PR to work on
4. Delegate to appropriate skill (checks or comments)
5. Return to dashboard to verify progress

## Batch Operations

For handling multiple PRs efficiently:

### Fix All Checks Across PRs
```bash
# List PRs with failing checks
gh search prs --author "@me" --state open --json repository,number | jq -r '.[] | "\(.repository.nameWithOwner) \(.number)"' | while read REPO NUM; do
  FAILING=$(gh pr checks "$NUM" --repo "$REPO" 2>/dev/null | grep -c "fail" || echo "0")
  if [ "$FAILING" -gt 0 ]; then
    echo "PR $REPO#$NUM has $FAILING failing checks"
  fi
done
```

## Common Questions

### "What PRs need my attention?"
Run the dashboard and look for ❌ or 🟡 indicators.

### "Which PR should I fix first?"
PRs with failing checks that block merging take priority over comment resolution.

### "Is this PR ready to merge?"
Check for:
- ✅ All checks passing
- 0 unresolved comments
- Approved reviews (if required)
- No merge conflicts

## Repository Context

To work with PRs in repos other than the current directory:

```bash
# Clone/navigate to the repo
cd /path/to/repo

# Or use --repo flag
gh pr view 123 --repo owner/repo
gh pr checks 123 --repo owner/repo
```

## Troubleshooting

### "No PRs found"
- Verify `gh auth status` shows correct user
- Check `gh api user --jq '.login'` matches expected username
- Ensure you're searching the right org/repos

### "Can't access repo"
- Verify permissions: `gh api repos/{owner}/{repo} --jq '.permissions'`
- May need to re-authenticate: `gh auth refresh`
