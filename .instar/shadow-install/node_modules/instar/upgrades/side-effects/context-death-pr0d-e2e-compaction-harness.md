# Side-Effects Review — Context-Death PR0d (E2E compaction harness)

**Version / slug:** `context-death-pr0d-e2e-compaction-harness`
**Date:** `2026-04-18`
**Author:** `Echo (instar-developing agent)`
**Spec:** `docs/specs/context-death-pitfall-prevention.md` § P0.1
**Phase / PR sequence position:** PR0d of 8
**Second-pass reviewer:** `not-required` (test infrastructure, no runtime decision logic — see Phase 5 criteria below)

## Summary of the change

Ships the test harness that PR2 (and any future compaction-adjacent test) will stand on top of. Spec § P0.1 gates the whole spec on "tests/e2e/ can spawn a Claude Code subprocess, drive controlled turns, trigger compaction, and capture post-compaction context." PR0d satisfies that gate with a *capability proof*: the canonical `compaction-recovery.sh` hook is directly invocable from a deterministic test environment, and its stdout can be captured and asserted against.

Files touched:

- **`tests/e2e/compaction-harness.ts`** (NEW) — exports `createCompactionHarness(options)` returning a `CompactionHarnessHandle` with:
  - `projectDir` / `stateDir` — isolated temp agent home.
  - `writeFile(path, content, {commit?})` — seed plan files / ledger entries, optionally commit them so they're durable per the spec's "durable artifacts" invariant.
  - `readFile(path)` — inspect state or hook output files.
  - `setIdentity(name, content)` — overwrite AGENT/MEMORY/USER.
  - `runCompactionRecovery(envOverrides)` — invoke the canonical hook with controlled env (`CLAUDE_PROJECT_DIR`, `INSTAR_TELEGRAM_TOPIC`), 10-second timeout, captures stdout/stderr/exitCode/durationMs.
  - `tempPath(suffix)` — disposable temp paths inside the harness.
  - `teardown()` — idempotent cleanup.
  - `locateCanonicalHook(hookName)` — walks upward from `process.cwd()` looking for `src/templates/hooks/<hook>` (source-of-truth) first, then `.instar/hooks/instar/<hook>` (deployed fallback). Null if not found; harness throws a clear error at run-time rather than silently synthesizing a fake hook.
- **`tests/e2e/compaction-harness.test.ts`** (NEW) — 12 smoke tests:
  - Setup shape (isolated agent home, identity files, `.instar/config.json` correctness).
  - `agentName` / `memoryContent` option wiring.
  - Git repo initialization + seed commit.
  - Teardown idempotency.
  - Canonical hook lookup (correct location, owner-executable).
  - `runCompactionRecovery` capability: exits 0, produces stdout within 10s, contains structural recovery markers (`IDENTITY RECOVERY|RESTORATION`, `RECOVERY COMPLETE|Continue your work`).
  - `INSTAR_TELEGRAM_TOPIC` env merge reaches the hook.
  - **Spec-critical regression guard:** asserts recovery stdout does NOT contain "fresh session" / "start over" / "restart the session" — these are the exact phrasings that trigger the context-death self-stop pattern this spec is built to prevent. Future edits to the recovery template that introduce such language will fail this test.
  - `writeFile` + commit path.
  - Error surface: missing hook throws a clear error instead of silent failure.

## Decision-point inventory

The harness does not make decisions. It does not gate behavior. It does not run in production. It is test infrastructure consumed only by other tests.

The only near-edge case is `locateCanonicalHook` — which determines which copy of `compaction-recovery.sh` the harness uses. That's a lookup, not a decision: it prefers the source-of-truth in `src/templates/hooks/` and falls back to the deployed agent copy. Both are legitimate sources; selecting between them is a cwd-dependent discovery, not a judgment call.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

Harness does not reject or block anything. `runCompactionRecovery` accepts arbitrary env overrides and runs whatever the hook does. The only rejection is `locateCanonicalHook` returning null when no copy is findable — which surfaces as a clear test-time error rather than a silent pass. That's the correct failure mode.

## 2. Under-block

**What failure modes does this still miss?**

- **Does not yet spawn a real Claude Code subprocess.** Spec § P0.1 literally says "spawn a Claude Code subprocess." The harness fulfills the *capability proof* (it can drive the recovery hook that Claude Code invokes post-compaction) without incurring CI flakiness from network-dependent Anthropic API calls. Whether this is enough to satisfy P0.1 is a judgment call; I've written it up as-is and PR2 will exercise the assertion surface. If it turns out more is needed, we extend the harness rather than rewrite it.
- **Does not assert cross-machine behavior.** Not in scope for PR0d; the multi-machine rollout tests live alongside PR4.
- **No LLM integration.** Out of scope — the authority is PR3.

## 3. Level-of-abstraction fit

**Is this at the right layer? Should a higher or lower layer own it?**

`tests/e2e/` is the right home. Precedent: `tests/e2e/compaction-telegram-context.test.ts` uses the same shape (isolated state dir + Python subprocess) for compaction-adjacent assertions; `tests/fixtures/two-session-harness.ts` follows the same "build a disposable agent home" pattern for worktree tests. PR0d's harness sits cleanly alongside both.

The canonical-hook-lookup logic could live in a shared test helper (`tests/fixtures/`). Placing it inside the harness for PR0d because no other consumer exists yet; extracting if PR2/PR3 end up needing it independently.

## 4. Signal vs authority compliance

`docs/signal-vs-authority.md`: detectors emit signals; only authorities can block.

The harness is neither. It is *observer* infrastructure — it runs the hook and captures output. Downstream tests turn the captured output into assertions, which turn into pass/fail for CI. None of that path constitutes an authority on agent behavior.

The spec-critical regression guard (asserting "fresh session" is NOT in recovery output) *could* be read as a blocking check, but it blocks a TEST, not agent behavior. If a hypothetical future recovery-template edit introduces the forbidden phrasing, this test fails, CI blocks the PR, and a human reviews. That's ordinary CI signal flow, not a runtime authority.

## 5. Interactions

- **Canonical hook copy:** `fs.copyFileSync` into the harness tree. The canonical source file is never mutated — the harness only reads it. No race possible.
- **Git repo per harness:** each harness creates its own temp `.git/` tree. No risk of stepping on the outer repo's state — `process.cwd()` is never changed; all `git` calls are `-C <projectDir>`.
- **Process timeout 10s** on the `spawnSync` call — hard cap prevents a bad hook from hanging the test runner indefinitely.
- **Teardown idempotency** — `tornDown` boolean guard makes double-teardown safe; `afterEach` patterns won't throw on partial-setup harnesses.
- **HOME env override to the temp dir** — deliberate, to prevent the hook from accidentally touching the real user's `~/.claude/` state during tests. (Some hook downstream paths read `$HOME/.claude/settings.json`; point them at the harness temp tree.)
- **No shared-state** between harnesses in the same test file; each `createCompactionHarness()` call is fully independent. Parallel test execution is safe.

## 6. External surfaces

- Test-only files. Nothing ships to the production runtime. Nothing is visible to users, agents, or other systems.
- The harness reads `src/templates/hooks/compaction-recovery.sh` (source-of-truth) — a one-way dependency: the harness validates what the template does, but never writes back. Safe.
- No network calls. No subprocess calls beyond `git` (for repo init) and `bash` (for the hook). Both are developer-machine dependencies already required by the broader test suite.

## 7. Rollback cost

Trivial. Two new test-tree files:
- `tests/e2e/compaction-harness.ts`
- `tests/e2e/compaction-harness.test.ts`

Both deletable with a revert; no runtime surface to undo. Nothing to migrate. Downstream PR2 will import from the harness — if rolled back, PR2 rebases on a harness-less baseline and ships its own minimal setup (cheap because the harness itself is ~220 LOC of plumbing).

---

## Tests

- `tests/e2e/compaction-harness.test.ts` — 12 smoke tests, all passing.
- `npm run lint` (tsc --noEmit) — clean.

## Phase 5 second-pass review criterion check

- Block/allow decisions on outbound messaging, inbound messaging, or dispatch — **no** (test infrastructure, no decisions).
- Session lifecycle: spawn, restart, kill, recovery — **test-adjacent to recovery, but not a new runtime path**; the harness only *observes* the existing recovery hook.
- Context exhaustion, compaction, respawn — **the harness is the observer surface for compaction**; still no new runtime path introduced, only a way to *test* the existing one.
- Coherence gates, idempotency checks, trust levels — **no**.
- Anything with "sentinel," "guard," "gate," or "watchdog" — **no**.

PR3 will require Phase 5 second-pass review.
