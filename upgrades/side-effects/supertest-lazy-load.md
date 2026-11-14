# Side-Effects Review — Load Supertest only in test files that use it

**Version / slug:** `supertest-lazy-load`
**Date:** `2026-10-27`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (required: harness-changing — vitest*.config.ts, tests/vitest-setup.ts, tests/setup/**)`

## Summary of the change

Tier 1, test harness only. `tests/vitest-setup.ts` runs before every test file in all four vitest lanes. It imported Supertest (and superagent beneath it) and installed the suite-wide connect retry on `Test.prototype`, so all ~2,500 unit files paid for loading a library only ~470 test files use.

Now:
- `tests/setup/supertest-with-retry.ts` imports the real package by file path (`supertest/index.js`), installs the same retry with the same installer, and re-exports it.
- `tests/setup/supertest-alias.ts` exports a Vite alias that maps only the bare specifier `supertest` to that wrapper.
- `vitest.config.ts`, `vitest.integration.config.ts`, `vitest.e2e.config.ts`, `vitest.push.config.ts` add the alias (the three that already aliased `@sagemindai/threadline-core` keep that entry, rewritten to array form).
- `tests/vitest-setup.ts` no longer imports Supertest.
- New `tests/unit/supertest-retry-alias.test.ts`: an imported `supertest` carries the installer's marker, every config that uses the setup file carries the alias, and the setup file does not import Supertest.

Measured (60 unit files that do not use Supertest, A/B twice, Mama PC): vitest's summed setup time 18.9 s / 20.5 s with the import → 3.9 s / 2.6 s without, about 0.27 s per file. Over ~2,000 non-Supertest unit files that is roughly 9–11 CPU-minutes per full unit run (about 70–80 s of wall time at 8 workers). Wall-time A/B on a 60-file sample is within machine noise; the setup counter is the clean signal.

Effort: 1 profiling pass, 0 review rounds before this artifact.

## Decision-point inventory

No decision-point surface. Test harness wiring only.

---

## 1. Over-block

No block/allow surface. Nearest analogue: could a test that used to pass now fail? A test that used Supertest without importing it (reaching it through some other module) would now get an unpatched copy. None exists: every Supertest use in `tests/` is a static `import … from 'supertest'` (all default imports; one file names its import `supertest` instead of `request`), there are no dynamic imports, and no source module under `src/` imports Supertest.

---

## 2. Under-block

Could the retry silently stop applying? Only if a file loaded Supertest by a path the alias does not match (e.g. `supertest/index.js` directly) — none does, and the new test asserts the marker on an ordinary import. Timing: the installer captures the real `setTimeout` when it runs, so fake timers installed later cannot stall a request. It now runs when the test file's imports evaluate rather than in the setup file; imports still evaluate before any test body or `beforeAll`. The one construct that runs earlier, `vi.hoisted`, is not combined with fake timers in any Supertest-using file.

---

## 3. Level-of-abstraction fit

The patch now travels with the import that needs it, instead of being applied globally in case it is needed. The alias lives in one helper imported by every config, so the four lanes cannot diverge.

---

## 4. Signal vs authority compliance

Not applicable (`docs/signal-vs-authority.md` reviewed): no detector or authority involved.

---

## 5. Interactions

- **Local Verify / the Increasing Throughput topic (130715):** the configs are harness files and topic 130715 is changing worker and shard settings in them. This change only touches `resolve.alias`, a different section; the topic was told before the PR. The PR is harness-changing and goes through the independent second pass.
- **Module identity:** with the default isolation each test file gets its own module instances, before and after; the installer is idempotent (`Symbol.for` marker), so a shared instance would also be patched once.
- **Verified:** the new alias test, the retry helper's own tests, the two setup ratchet tests, 25 Supertest-using unit files (309 tests across 29 files), 6 Supertest-using integration files (36 tests) and 4 e2e files (19 tests) pass.

---

## 6. External surfaces

None. Tests only; nothing in `src/` or the published package changes.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: test-run configuration.

---

## 8. Rollback cost

Revert the PR. No state.

## Second-pass review

**Reviewer:** independent subagent
**Verdict:** Concur with the review

- Import routes: every Supertest use under `tests/` is a static default import of the bare specifier `supertest` (472 files, all default imports — the artifact's "2 namespace-style" is really one file binding the name `supertest`, still a default import). No `require`, dynamic import, `supertest/...` subpath (other than the wrapper's own), direct `superagent` use, or `vi.mock('supertest')` in `tests/`, `src/`, `packages/` or `scripts/`. No non-test helper under `tests/` imports Supertest.
- Alias resolution: `supertest@7.2.2` has no `exports` map, so `supertest/index.js` resolves to the real package and the `/^supertest$/` alias cannot match it (no recursion). Confirmed by running a throwaway marker test (since deleted) under the integration and e2e configs, plus the new alias test under the unit and push configs: the prototype carries the installer marker in all four. Negative control: a scratch config without the alias fails the marker assertion (`expected undefined to be true`), so the test does detect a missing alias. `vitest.contract.config.ts` uses neither the setup file nor Supertest.
- Timer capture (`supertest-connect-retry.ts:153`, `globalThis.setTimeout.bind` at install): the 8 Supertest files that use fake timers call `vi.useFakeTimers` only in `beforeEach`/test bodies/a helper, never inside `vi.hoisted`, and none reassigns `globalThis.setTimeout`; ESM imports evaluate before those. Their unit/integration/e2e runs pass.
- `tests/vitest-setup.ts` diff against `origin/main` is exactly the 5 Supertest lines removed; env stripping, CODEX_HOME and git identity are untouched. The setup ratchets (`vitest-setup-git-env-strip`, `test-setup-hermetic-codex-home`), `vitest-lane-callers`, `supertest-connect-retry` and Supertest users `request-timeout`/`rate-limiter` pass (34 tests).
- Saving measured independently: 40 non-Supertest unit files, A/B three times with the old setup vs the new — summed setup 15.0 / 18.2 / 16.7 s vs 3.9 / 2.5 / 3.2 s, about 0.3 s per file. Wall time on this sample is noise-dominated, as the artifact says.
- Other: `tests/setup/**`, `tests/vitest-setup.ts` and `vitest*.config.ts` are in Local Verify's harness classifier, so this PR correctly needs this second pass. The push config change touches only `resolve.alias`, not its file filters. Tests are excluded from `tsc`, so the `supertest/index.js` import carries no typecheck risk.
