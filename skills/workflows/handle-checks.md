# Handle PR Status Checks

Automatically monitor, investigate, and fix failing PR status checks until all checks pass.

## Status Reporting

Report your status to the Order Up dashboard so the user can track progress.

### On Start (run immediately after getting PR info):
```bash
curl -X POST http://localhost:3333/api/agent-job \
  -H "Content-Type: application/json" \
  -d '{"repo":"{OWNER}/{REPO}","number":{PR_NUMBER},"status":"running","type":"checks"}'
```

### On Complete (run after all checks pass):
```bash
curl -X POST http://localhost:3333/api/agent-job \
  -H "Content-Type: application/json" \
  -d '{"repo":"{OWNER}/{REPO}","number":{PR_NUMBER},"status":"complete","type":"checks","summary":"Fixed X failing checks"}'
```

### On Failure (if you cannot complete):
```bash
curl -X POST http://localhost:3333/api/agent-job \
  -H "Content-Type: application/json" \
  -d '{"repo":"{OWNER}/{REPO}","number":{PR_NUMBER},"status":"failed","type":"checks","error":"Brief description of why"}'
```

Replace `{OWNER}`, `{REPO}`, `{PR_NUMBER}`, and the summary/error messages with actual values.

## Workflow

### Step 1: Get Current PR Number

```bash
gh pr view --json number --jq '.number'
```

If not in a PR branch, ask the user which PR number to work with.

### Step 2: Fetch Status Checks

```bash
gh pr checks {PR_NUMBER}
```

For detailed information:

```bash
gh pr view {PR_NUMBER} --json statusCheckRollup --jq '.statusCheckRollup[]'
```

### Step 3: Identify Failing Checks

Parse the output and identify checks with status:
- `FAILURE`
- `ERROR`
- `TIMED_OUT`

For each failing check, note:
- Check name (e.g., "Build", "Test", "Lint")
- Conclusion reason
- Details URL if available

### Step 4: Investigate Each Failure

For each failing check:

1. **Get detailed logs**:
```bash
gh run view {RUN_ID} --log-failed
```

Or if run ID isn't obvious, list recent runs:
```bash
gh run list --limit 5
```

2. **Analyze the error**:
   - Read the log output carefully
   - Identify the root cause (build error, test failure, linting issue, etc.)
   - Determine which files are involved

3. **Categorize the failure**:
   - **Build errors**: Missing dependencies, compilation failures
   - **Test failures**: Failing unit/integration tests
   - **Linting**: Code style or static analysis issues
   - **Type errors**: TypeScript/type checking failures
   - **Other**: Timeouts, infrastructure issues, etc.

### Step 5: Fix All Issues (Batch Mode)

Address all failing checks before committing:

1. **For build errors**: Check package.json / go.mod / requirements.txt for missing dependencies. Fix import statements. Resolve compilation errors.
2. **For test failures**: Read the failing test output. Identify what assertion failed. Fix the code or update the test if requirements changed.
3. **For linting issues**: Run linter locally. Fix reported issues. Re-run linter to confirm all issues resolved.
4. **For type errors**: Run type checker locally. Fix type mismatches. Add missing type annotations.

### Step 6: Verify Fixes Locally

Before pushing, verify fixes locally:

```bash
# For Node/TypeScript projects
npm run lint
npm run type-check
npm test
```

Only proceed to push if all local checks pass.

### Step 7: Commit and Push Fixes

```bash
git add .
git commit -m "Fix PR check failures

- Fix {specific build error}
- Resolve test failures in {test suite}
- Address linting issues in {files}
- Fix type errors in {components}"

git push
```

### Step 8: Poll Checks Until Pass

After pushing, wait for checks to start, then poll:

```bash
# Wait 30 seconds for checks to start
sleep 30

# Check status
gh pr checks
```

**Polling loop**:
1. Wait 30-60 seconds between polls (checks take time to run)
2. Fetch latest check status
3. If all checks pass -> Done!
4. If any checks still failing -> Go to Step 4 (investigate new failures)
5. If checks are pending/in_progress -> Continue polling

### Step 9: Handle Persistent Failures

If after multiple iterations checks still fail:
- Review the full check history
- Check for infrastructure issues (CI runner problems, timeout issues, flaky external services)
- Consider if changes need a different approach

## Common Check Types

| Type | Look For | Fix |
|------|----------|-----|
| Build/Compilation | `cannot find module`, `syntax error` | Install deps, fix imports |
| Unit/Integration Tests | `FAIL`, `AssertionError` | Update code logic or test expectations |
| Linting/Code Quality | `eslint`, `biome`, `pylint` errors | Follow style guide, fix code smells |
| Type Checking | `Type 'X' is not assignable` | Add type annotations, fix mismatches |
| End-to-End Tests | Browser errors, timeout errors | Update selectors, fix race conditions |

## Common Pitfalls

- **Don't push partial fixes** - Fix all issues together
- **Don't skip local verification** - Always verify locally first
- **Don't poll too frequently** - Checks need time to run (30-60s intervals)
- **Don't ignore flaky tests** - If a test is flaky, fix or skip it explicitly
- **Don't assume checks are instant** - Some check suites take 5-10+ minutes
