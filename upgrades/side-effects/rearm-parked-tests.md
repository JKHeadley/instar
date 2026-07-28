# Side-effects review — re-arm two parked tests

**Change:** remove `tests/unit/agent-registry.test.ts` and `tests/unit/builtin-manifest.test.ts` from
`FLAKY_TESTS` in `vitest.push.config.ts`, and replace the surrounding comment with the measurements
and the falsified hypothesis.

**Decision point touched?** No new decision point. This *restores* an existing one: two guards that
were excluded from the CI gate now participate in it again. No runtime code changes; the diff is
config + comment only.

---

## 1. Over-block

Re-arming can only make the gate stricter, and that is the intent. The over-block risk is that a test
fails in CI for an environmental reason that does not exist locally — in which case CI turns red on
work unrelated to the failure, and the author is blocked by something they did not cause.

Mitigated by measurement rather than hope: both were run three consecutive times on current `main`
(42/42/42 and 9/9/9), and the one specific environmental hypothesis available —
`builtin-manifest.test.ts` depending on the generated, gitignored `src/data/builtin-manifest.json` —
was tested by deleting the file. The test still passed 9/9 because its `beforeAll` regenerates it.

Residual risk is real but bounded: local determinism is not proof of CI determinism. If either fails
in CI, the correct response is to diagnose it, not to re-park it. Re-parking without a diagnosis is
the exact move that created this situation.

## 2. Under-block

This change does not attempt to audit the rest of `FLAKY_TESTS` (92 entries remain). Several — the
supertest/port-collision group in particular — are plausibly genuinely environment-bound, and
emptying the list wholesale would be the same bulk move that caused the problem, run in reverse. So
the class is knowingly only partly addressed here: two members verified and fixed, the remainder
untouched and unexamined. Stated rather than implied.

## 3. Level-of-abstraction fit

Correct layer. The mislabel lives in the exclusion list, so the fix belongs in the exclusion list.
A deeper fix — something that would *prevent* a bulk exclusion from being read later as a per-test
finding — would need a mechanism requiring evidence at the point of exclusion (e.g. a required
measurement note per entry). That is a larger design change and is deliberately not attempted here.

## 4. Signal vs authority compliance

Unchanged. The tests are signals that CI (the authority) consumes. Nothing here gives any check new
blocking power it did not already have by design; it restores participation that was removed.

## 5. Interactions

The two files now execute inside the push/CI unit run, adding their runtime to that job and their
failures to its verdict. Both are fast unit tests. `builtin-manifest.test.ts` shells out to
`scripts/generate-builtin-manifest.cjs` in `beforeAll` if the generated file is missing, which writes
`src/data/builtin-manifest.json` — a gitignored artifact that `npm run build` writes anyway. It is
the only test that reads that file, so no cross-test read/write race is introduced. Worth naming
explicitly because a test that writes into the repo during a sharded run is the shape that *would*
cause genuine flakiness if another test ever read the same file.

## 6. External surfaces

None. No endpoint, no config key, no agent-visible behaviour, no user-visible behaviour. The only
observer of this change is CI.

## 7. Multi-machine posture

Not applicable — this is repo-level CI configuration, identical on every checkout, with no runtime
state, no per-machine data, and nothing to replicate or proxy.

## 8. Rollback cost

Trivial and immediate: re-add the two strings to `FLAKY_TESTS`. No data migration, no release
coupling, no agent state to repair. If a rollback happens, the comment block should record *why* the
test actually failed — otherwise the rollback recreates the original defect, which was an exclusion
carrying no evidence.
