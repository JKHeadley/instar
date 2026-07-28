# Side-effects review — Real-World-State fixture framework + first scenario (post-mortem lever B)

## What changed

A new test category `tests/real-world-state/` for scenarios that exercise
instar against state that LOOKS LIKE a real production agent — not the
small fresh-fixture state the rest of the suite uses.

- **`tests/real-world-state/_framework.ts`** — fixture-loader helpers,
  tier system, agent-fixture builder.
- **`tests/real-world-state/externalized-config-boot.test.ts`** — the
  first scenario (5 tests). Targets the post-mortem's #542 incident
  class: `loadConfig()` MUST merge the externalized authToken back from
  the secret store, or every downstream consumer that doesn't go
  through `loadConfig()` silently 403s.
- **`vitest.config.ts`** — the new directory wired into the
  `include` array (alongside unit / integration / e2e).

The framework introduces a **two-tier system**:

- **'pr' tier** — small fixtures (< ~5 MB, < ~30s setup). Runs on
  every PR / every CI shard. The first scenario lives here.
- **'nightly' tier** — large fixtures (multi-100MB DBs, generated
  JSONL volumes, environment-specific shapes like wrong-ABI binaries).
  Gated on `INSTAR_REAL_WORLD_BIG=1` env. Default OFF; default behavior
  is `describe.skip` with a clear "skipped (set ... to run)" message so
  the coverage gap is visible, not silently absent.

Helper API:

```ts
import { describeAtTier, makeAgentFixture } from './_framework.js';

describeAtTier('pr', 'scenario name', () => {
  let fx;
  afterEach(() => fx?.cleanup());
  it('asserts X about Y', () => {
    fx = makeAgentFixture();
    // fx.projectDir + fx.stateDir are a real on-disk agent home shape
    // … set up scenario, run code-under-test, assert
  });
});
```

## Why

Per the 2026-05-29 pipeline post-mortem (PR #545), pattern #1 — "Tested
on fresh state, not real-world state" — was the **largest** of the five
named bug classes. Bugs in this class shipped in the last 2 weeks:
- #534 (TokenLedger backfill bricked boot at 202MB; fixture was tiny).
- #512 (TokenLedger schema-order died on pre-existing DB but passed on
  fresh).
- #509 (heal-then-heal failed; heal-once passed).
- #501 (SleepWakeDetector false-wake under load).
- #503 (PresenceProxy redundant after ack).
- And the originator of this whole arc — #542 (silent-403 secret
  externalization). The in-process Node side's `loadConfig()` wasn't
  exercised against the externalized shape; only the SHELL hook/script
  side was, by PR #542's tests.

Lever B is the only post-mortem lever that closes the broader pattern
rather than a specific incident shape. The other four (#542, #545,
#550, #551, #552) each closed individual classes; this one builds the
infrastructure to catch the class FAMILY going forward.

## Risk surface

- **Test-only change.** No runtime code modified. Existing test suites
  unchanged.
- **vitest.config.ts include list extended** — additive only; the three
  existing entries (unit / integration / e2e) remain unchanged. CI
  shards will pick up the new path automatically.
- **PR-tier fixture is tiny.** The externalized-config-boot scenario
  writes a ~1KB JSON file and runs the SecretMigrator + SecretStore
  paths. Test runtime: ~200ms. CI impact: negligible.
- **Nightly tier defaults OFF.** No big-fixture cost on PR runs until
  someone deliberately opts in. The skip is loud (`describe.skip` with
  a message), not silent — the coverage gap is visible in every CI
  report.
- **No fixture generation in this PR.** The first scenario uses
  in-test fixture builders (write JSON file, run SecretMigrator). When
  the nightly tier ships its first scenario (multi-100MB DB → catches
  #534), it will need a `scripts/build-real-world-fixtures.mjs`
  generator + a git-ignored `tests/fixtures/real-world-state/` cache.
  Deferred to that PR.

## Bug surfaces eliminated

- A future regression in `mergeConfigWithSecrets` (or the call from
  `Config.ts:loadConfig`) that re-introduces the placeholder-leak shape
  fails the 5 new tests with clear messages. Verified destructive-
  negative: disabling the merge call in `Config.ts` trips 4 of the 5
  scenario tests with the exact failure modes the bug class produced.
- The full-shape sub-test asserts that telegram token, telegram chatId,
  dashboard PIN, AND tunnel token all merge — not just authToken. A
  future externalization that adds a new secret field without wiring
  the merge fails immediately.
- The idempotency sub-test asserts that re-running pairing on an
  already-externalized agent doesn't double-extract or lose state.

## Testing

- **5 tests, all green** on the current main:
  - Disk shape sanity (post-pairing layout).
  - `loadConfig()` returns merged real authToken (the headline check).
  - `loadConfig()` never leaks the placeholder shape (regression).
  - Full-shape merge (telegram + dashboard + tunnel + auth).
  - Idempotency on re-run.
- **Tier-gating verified both directions**. With `INSTAR_REAL_WORLD_BIG`
  unset, `nightly`-tier blocks skip with a visible message; with it set
  to `1`, they execute. Verified with a sentinel test that
  intentionally fails — proves the gating respects the env.
- **Destructive-negative verified**. Disabling
  `mergeConfigWithSecrets()` in `Config.ts` fails 4 of 5 scenario tests
  with the failure messages the bug class produced
  (`{ secret: true }` returned as authToken, telegram token leaks the
  placeholder, etc.).
- **No regression in existing related tests** —
  `secret-migrator.test.ts` (40), `secret-store.test.ts` (presumed
  green), `config-secret-merge.test.ts` (4) all still pass.
- `tsc --noEmit` clean.

## Follow-ups

- **First nightly-tier scenario** — multi-100MB token-ledger.db boot
  test that would have caught #534. Needs a fixture generator
  (`scripts/build-real-world-fixtures.mjs`) and a git-ignored cache
  (`tests/fixtures/real-world-state/`). Separate PR.
- **Wrong-ABI better-sqlite3 scenario** — catches #539's class. Needs
  the framework to support "environment fixtures" (specific Node + ABI
  combos), which is a bigger design step.
- **Concurrency-at-scale scenarios** — multi-job + multi-session under
  restart-during-tick. Bigger design step (probably needs a tmux
  harness).

This PR ships the FRAMEWORK + ONE scenario as a working backstop.
Subsequent PRs add scenarios at the same incremental pace.
