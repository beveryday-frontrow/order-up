---
name: handle-pr-comments
description: Handle unresolved PR comments by fetching them via gh CLI, addressing the issues in code, replying with resolutions, and marking them as resolved. Use when the user asks to handle PR comments, address review feedback, resolve PR discussions, or mentions unresolved comments on a pull request.
---

# Handle PR Comments

Automatically fetch, address, and resolve unresolved PR review comments using GitHub CLI.

## Workflow

Follow these steps to handle all unresolved PR comments:

### Step 1: Get Current PR Number

```bash
gh pr view --json number --jq '.number'
```

If not in a PR branch, ask the user which PR number to work with.

### Step 2: Fetch Unresolved Comments

```bash
# Get all unresolved review threads (inline code comments)
gh api graphql -f query='
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 100) {
            nodes {
              id
              databaseId
              body
              author {
                login
              }
              createdAt
            }
          }
        }
      }
      # Also check for reviews with body comments (like Bugbot summaries)
      latestReviews(first: 10) {
        nodes {
          id
          author { login }
          state
          body
        }
      }
    }
  }
}' -f owner="{OWNER}" -f repo="{REPO}" -F number={PR_NUMBER}
```

Replace `{OWNER}`, `{REPO}`, and `{PR_NUMBER}` with actual values from the repo.

**What this captures:**
- `reviewThreads` - Inline code comments on specific lines (most common)
- `isOutdated` - Helps identify comments on code that's been updated
- `latestReviews.body` - Review summaries (like Cursor Bugbot findings)

**Note:** Focus on threads where `isResolved: false` AND `isOutdated: false` - outdated comments are on code that's already been changed.

### Step 3: Filter Unresolved Threads

Parse the JSON response and identify threads where `isResolved: false` AND `isOutdated: false`.

**Priority order:**
1. **Active unresolved** (`isResolved: false`, `isOutdated: false`) - Address these first
2. **Outdated unresolved** (`isResolved: false`, `isOutdated: true`) - May auto-resolve or need review
3. **Review body comments** - Check `latestReviews` for Bugbot/Cursor summaries

For each unresolved thread:
1. Note the file path, line number, comment body, and author
2. Understand what issue is being raised
3. Determine if it's from bugbot, cursor, or human reviewer

### Step 4: Address Each Comment

For each unresolved comment, **in order**:

1. **Read the relevant file** mentioned in the comment path
2. **Analyze the issue** described in the comment body
3. **Make the necessary code changes** to address the concern
4. **Track the change** but don't commit yet (batch all fixes)

### Step 5: Prepare Resolution Replies

For each comment you've addressed, draft a reply explaining:
- What you changed
- Why it addresses the concern
- Any trade-offs or alternative approaches considered (if relevant)

Keep replies concise and technical.

### Step 6: Commit and Push All Fixes

Once all comments are addressed:

```bash
git add .
git commit -m "Address PR review comments

- Fix issue raised in {file1}
- Update {file2} per review feedback
- Resolve {specific concern}"

git push
```

### Step 7: Reply to Comments and Mark as Resolved

For each thread, reply and resolve using the thread's ID:

```bash
# Reply to the review thread (use addPullRequestReviewThreadReply, NOT addComment)
gh api graphql -f query='
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $threadId, body: $body}) {
    comment {
      id
      body
    }
  }
}' -f threadId="{THREAD_NODE_ID}" -f body="{YOUR_REPLY}"

# Mark the thread as resolved
gh api graphql -f query='
mutation($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) {
    thread {
      id
      isResolved
    }
  }
}' -f threadId="{THREAD_NODE_ID}"
```

**Important**: 
- Use `addPullRequestReviewThreadReply` (not `addComment`) for review threads
- Use the thread's node ID (starts with `PRRT_`) for both reply and resolve
- The comment node ID (starts with `PRRC_`) is for the individual comments within a thread

### Step 8: Verify All Comments Resolved

Re-run Step 2 to confirm all threads show `isResolved: true`.

If any remain unresolved:
- Review what was missed
- Address remaining issues
- Repeat Steps 4-7

## Handling Special Cases

### Bugbot/Cursor Comments

These typically flag:
- Linting errors
- Type errors
- Security issues
- Test failures

Treat these as **must-fix** - don't just prove them wrong, actually fix the underlying issue.

### Disagreeing with a Comment

If you determine a comment is incorrect or not applicable:
1. **Explain clearly** why the concern doesn't apply
2. **Provide evidence** (link to docs, show test coverage, etc.)
3. **Still reply and resolve** the thread with your explanation

### Comments Requiring Clarification

If a comment is unclear:
1. Reply asking for specific clarification
2. **Do not mark as resolved** yet
3. Wait for response before proceeding

## GitHub CLI Context

The GraphQL queries assume you're using GitHub CLI v2.0+. If queries fail:
- Check `gh --version`
- Ensure `gh auth status` shows proper authentication
- Verify you have write access to the repository

## Common Pitfalls

- **Don't mark as resolved before replying** - Always reply first, then resolve
- **Don't skip the commit message** - Explain what review feedback you're addressing
- **Don't resolve in bulk** - Handle each comment individually with specific replies
- **Don't forget to push** - Changes must be pushed before marking as resolved
