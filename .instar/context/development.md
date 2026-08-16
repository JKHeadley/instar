# Development Patterns

## Before Writing Code

1. Read existing code before modifying it
2. Check the project map for file locations
3. Follow existing patterns in the codebase

## Testing (NON-NEGOTIABLE)

**Every code change MUST include regression tests.** No exceptions.

### The Rule
- **Bug fix** → Add a test that reproduces the bug, then verify the fix makes it pass
- **New feature** → Add unit tests covering the new logic; integration/e2e if it touches HTTP routes
- **Refactor** → Existing tests must still pass; add tests for any new edge cases introduced
- **Config/wiring change** → Add a wiring integrity test that verifies the component is connected

### Test Structure (instar project)
- **Unit tests**: `tests/unit/` — Pure logic, mocked dependencies, 10s timeout
- **Integration tests**: `tests/integration/` — Real HTTP routes, 60s timeout
- **E2E tests**: `tests/e2e/` — Full lifecycle validation, 60s timeout
- Framework: **Vitest** — use `describe`, `it`, `expect`, `vi` for mocks/fakes

### Test Quality
- Tests must be **deterministic** — no flaky timing dependencies
- Use `vi.useFakeTimers()` for timer-dependent tests
- Test both the **happy path** and the **boundary/failure case**
- Name tests descriptively: "cancels tier 2 when agent responds after tier 1 sends"

### Verification
- Run affected tests: `cd /Users/justin/Documents/Projects/instar && npx vitest run tests/unit/FILE.test.ts`
- Run full suite before commit: `npm test`
- Pre-push gate enforced by Husky: `npm run test:push`

## Git Workflow

- Commit with clear messages
- Check coherence gate before pushing
- Verify CI passes after push

## Project-Specific Conventions

- **Structure > Willpower** — Enforce behaviors architecturally, not via documentation
- **Sequential test execution** — `fileParallelism: false` to prevent port collisions
- **Flaky test quarantine** — Known flaky tests excluded from pre-push in vitest.push.config.ts
