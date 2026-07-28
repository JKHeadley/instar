# Side-effects review — preflight lint package-manager resolution

**Change.** `dev:preflight` ran `runner.run('pnpm', ['lint'], 'lint')`. CI installs with
`npm ci` and never installs pnpm, so the step failed to START there (`spawn pnpm ENOENT`)
and the summary reported it as a lint FAILURE. Resolve the manager instead (pnpm
preferred, `npm run lint` fallback) via an injectable probe; when neither is usable the
run fails and says `check DID NOT RUN`.

**Tier declared: 1.** Signal was 2 (`size=2, riskFloor=1`, 48 LOC / 1 file). The risk
floor is 1 — no safety-invariant, irreversibility, migration, or new-capability signal.
Size alone crossed the 40-LOC bar, and 8 of those lines are the doc comment recording
why. Trimming the comment to slip under the bar would be gaming the gate, so the tier is
declared openly instead. A converged spec for a package-manager lookup in a contributor
CLI is disproportionate. Recorded as `belowFloor`.

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?

None identified. The change strictly widens what succeeds: previously only a host with
pnpm could run the lint step, now pnpm **or** npm works. No input that passed before
fails now. The one new failure path (neither manager present) previously produced the
same nonzero exit — it is now merely *explained*.

## 2. Under-block — what failure modes does this still miss?

- **A manager that exists but is broken.** The probe runs `--version` and checks exit 0.
  A pnpm that answers `--version` but cannot run scripts still selects pnpm and fails at
  the lint step. Accepted: that failure is loud and correctly attributed to lint.
- **Manager-specific lint behaviour.** `pnpm lint` and `npm run lint` both execute the
  same `scripts.lint` string, so the executed command is identical. If a future lint
  script relied on pnpm-specific resolution the two would diverge silently. Not the case
  today (verified: the script is a plain `tsc --noEmit && node scripts/...` chain).
- **Manager choice is not reported in the summary line.** The spawn banner prints
  `$ npm run lint`, so it is visible in output, but the PASS/FAIL summary does not name
  the manager. Acceptable for a developer tool.

## 3. Level-of-abstraction fit

Correct layer. The knowledge "which package manager can run a script here" belongs to
the process that spawns it. The neighbouring call one line down already resolved this
correctly by spawning `npx`; only the lint step hardcoded a manager. This makes the two
adjacent calls consistent rather than introducing a new concept.

## 4. Signal vs authority compliance

Compliant, and it moves toward the principle rather than away.

`dev:preflight` is an authority — its exit code gates a contributor's push. The defect
was an authority drawing a **verdict about the code** from an **environment gap**:
"pnpm is not installed" was rendered as "lint failed." That is precisely a brittle
input granted authority it had not earned.

The fix keeps authority where it is and repairs its input. It adds no new blocking
logic. The neither-manager branch deliberately does NOT fail open — it fails closed and
says `check DID NOT RUN`, because a check that could not run must not be
indistinguishable from one that ran and passed. That distinction is asserted by test.

## 5. Interactions

- **Shadowing:** none. No other check resolves a package manager.
- **Double-fire:** none. The lint step runs exactly once, as before.
- **Races:** none. The probe is a synchronous `spawnSync('--version')` before any work.
- **Test coupling:** `tests/integration/dev-preflight-command.test.ts` asserted the exact
  spawned command list including `['pnpm','lint']`. Left probing, that assertion would
  become host-dependent (passing on a dev laptop, failing in CI). The resolver is now
  injected in both call sites so the test stays deterministic and its assertion is
  unchanged — the environment dependency is made explicit rather than removed.

## 6. External surfaces

No agent-visible, user-visible, or cross-agent surface. `dev:preflight` is a contributor
command; it is not invoked by runtime agent behaviour, jobs, hooks, or routes. No route,
config key, message, or persisted state changes. Not timing-dependent.

## 7. Multi-machine posture

**Machine-local BY DESIGN**, and correctly so: the question answered is "which package
manager exists on *this* disk." Replicating or proxying that answer would be actively
wrong — the whole defect was one machine's assumption being applied where it did not
hold. No durable state, no generated URL, no user-facing notice; nothing to strand on a
topic transfer.

## 8. Rollback cost

Trivial. Revert the commit; the resolver is a pure function with an injectable probe and
no persisted state, no migration, and no config. Nothing to repair. A partial rollback
(keeping the tests, reverting the resolver) would re-red the CI check.

## How this surfaced — worth recording

The e2e test `tests/e2e/dev-preflight-cli.test.ts` opens:

```ts
const cli = path.join(process.cwd(), 'dist', 'cli.js');
if (!fs.existsSync(cli)) { return; }
```

CI runs vitest on TS source with no preceding build, so `dist/cli.js` never existed and
this test has been **green by never executing**. PR #1709 adds a globalSetup that builds
dist — whose own docstring says it exists so a dist-backed test cannot "skip silently" —
which woke the test and immediately exposed this. #1709 did not break it; it revealed it.

The residual defect (a test that passes by returning early) is **not** fixed here: it is
a test-integrity change with its own blast radius across the e2e suite, and bundling it
would violate the one-fix-per-artifact rule above. Tracked separately.
<!-- tracked: ACT-1514 -->

## Verification

- Built `dist/` and ran the real CLI under `env -i PATH=<no pnpm, npm present>` — the
  exact CI condition. It selects `npm run lint` and exits **0**.
- Known-fail control is the production CI log itself (`lint failed to start: spawn pnpm
  ENOENT`), i.e. the pre-fix behaviour observed in the environment being fixed.
- Unit tests cover pnpm-present, pnpm-absent, both-present, and neither; the neither case
  asserts the run does not report a pass and never spawns a lint step.
- `tsc --noEmit` clean; 7/7 on the changed surface.
