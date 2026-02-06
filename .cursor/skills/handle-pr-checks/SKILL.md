---
name: handle-pr-checks
description: Monitor and fix PR status check failures by fetching check status via gh CLI, investigating failures, fixing issues, and polling until all checks pass. Use when the user asks to handle PR checks, fix failing CI/CD, address test failures, resolve build errors, or mentions status checks on a pull request.
---

# Handle PR Status Checks

Automatically monitor, investigate, and fix failing PR status checks until all checks pass.

## Workflow

Follow these steps to handle PR status check failures:

### Step 1: Get Current PR Number

```bash
gh pr view --json number --jq '.number'
```

If not in a PR branch, ask the user which PR number to work with.

### Step 2: Fetch Status Checks

```bash
gh pr checks {PR_NUMBER}
```

This shows a summary of all checks. For detailed information:

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

1. **For build errors**:
   - Check package.json / go.mod / requirements.txt for missing dependencies
   - Fix import statements
   - Resolve compilation errors

2. **For test failures**:
   - Read the failing test output
   - Identify what assertion failed
   - Fix the code or update the test if requirements changed
   - Run tests locally to verify: `npm test` / `go test ./...` / `pytest`

3. **For linting issues**:
   - Run linter locally: `npm run lint` / `golangci-lint run` / `eslint .`
   - Fix reported issues
   - Re-run linter to confirm all issues resolved

4. **For type errors**:
   - Run type checker locally: `tsc --noEmit` / `mypy .`
   - Fix type mismatches
   - Add missing type annotations

### Step 6: Verify Fixes Locally

Before pushing, verify fixes locally:

```bash
# For Node/TypeScript projects
npm run lint
npm run type-check
npm test

# For Go projects
go test ./...
golangci-lint run

# For Python projects
pytest
mypy .
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
3. If all checks pass → Done!
4. If any checks still failing → Go to Step 4 (investigate new failures)
5. If checks are pending/in_progress → Continue polling

```bash
# Poll every 60 seconds until all checks pass
while true; do
  STATUS=$(gh pr checks --json state --jq '.[] | select(.state != "SUCCESS") | .state')
  if [ -z "$STATUS" ]; then
    echo "All checks passed!"
    break
  fi
  echo "Checks still running or failing, waiting 60s..."
  sleep 60
done
```

### Step 9: Handle Persistent Failures

If after multiple iterations checks still fail:

1. **Review the full check history**:
```bash
gh pr view --web
```
Navigate to the "Checks" tab to see detailed timeline

2. **Check for infrastructure issues**:
   - Is the CI runner having issues?
   - Are there timeout problems?
   - Is there a dependency on external services that's flaky?

3. **Consider if changes need a different approach**:
   - Maybe the failure reveals a deeper architectural issue
   - Perhaps tests need updating alongside the feature
   - Check if there are dependency conflicts

## Common Check Types

### Build/Compilation Checks
- Look for: `error: cannot find module`, `undefined reference`, `syntax error`
- Fix: Install dependencies, fix imports, resolve syntax issues

### Unit/Integration Tests
- Look for: `FAIL`, `AssertionError`, `expected X but got Y`
- Fix: Update code logic, fix test expectations, ensure test data is correct

### Linting/Code Quality
- Look for: `eslint`, `golangci-lint`, `pylint` errors
- Fix: Follow style guide, fix code smells, add missing documentation

### Type Checking
- Look for: `Type 'X' is not assignable to type 'Y'`, `undefined property`
- Fix: Add proper type annotations, fix type mismatches, update interfaces

### End-to-End Tests
- Look for: Browser errors, timeout errors, element not found
- Fix: Update selectors, fix race conditions, ensure proper test setup

## GitHub Actions Context

Most checks run via GitHub Actions. Key concepts:
- **Workflow**: The overall CI/CD pipeline
- **Job**: Individual tasks within a workflow (build, test, lint)
- **Step**: Commands within a job
- **Run**: A specific execution of a workflow

When investigating failures, drill down: Workflow → Job → Step → Error line.

## Optimization Tips

1. **Run checks locally first** before pushing to save CI time
2. **Fix multiple issues in one commit** to trigger checks only once
3. **Use check run IDs** for faster log access: `gh run view <run-id>`
4. **Cache dependencies** in CI to speed up builds
5. **Parallelize tests** if possible to reduce check time

## Common Pitfalls

- **Don't push partial fixes** - Fix all issues together
- **Don't skip local verification** - Always verify locally first
- **Don't poll too frequently** - Checks need time to run (30-60s intervals)
- **Don't ignore flaky tests** - If a test is flaky, fix or skip it explicitly
- **Don't assume checks are instant** - Some check suites take 5-10+ minutes
