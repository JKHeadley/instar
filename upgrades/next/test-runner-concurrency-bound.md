# Test-runner concurrency bound — host-wide vitest semaphore, ships watch-only

<!-- bump: minor -->

## What Changed

The structural fix for the 29-concurrent-test-suites meltdown class (2026-06-19,
2026-07-02): every vitest run on a machine now passes a host-wide two-lane
semaphore before its worker pool fans out. Full suites take a **suite-lane**
slot (cap 1 — the operator-ratified "never run builders' full suites at once"
rule); small inner-loop runs (≤5 matched test files, pool ≤4 workers, no
pool-shaping flags) take a roomier **targeted-lane** slot (cap 6), so
day-to-day iteration never queues behind a big suite. Per
`docs/specs/test-runner-concurrency-bound.md` (converged round 10, approved):

- **Ships watch-only (dry-run).** Full bookkeeping, ZERO enforcement: a run
  that would block logs `would-block` to a durable ledger and admits. Real
  blocking exists only behind a deliberate host tuning-file flip
  (`~/.instar/host-test-runner-tuning.json`) gated on a 14-day soak review.
  Nothing changes about test execution at ship.
- **Fail-open everywhere it matters** (the deliberate inversion of the spawn
  cap's fail-closed default): corrupt state, unknown df, wedged lock — the
  run ADMITS, loudly, with a witness record. A false BLOCK would wedge every
  push and build on the machine; a false admit is one extra suite for a few
  minutes. The single exception: a provable fail-open STORM (8 live O_EXCL
  witness slots) refuses further admits — at that point over-admission IS the
  meltdown.
- **Capacity-reclaim only by default.** A hung suite past its TTL loses its
  SLOT (capacity restored, `stale-holder-reclaimed` ledgered) — no process is
  ever signaled. Process-killing is a separate opt-in arm
  (`ttlSignal`, tuning-file-armable ONLY — env can only disarm), off through
  the whole soak, quadruple-gated (pid sanity, identity corroboration via
  process start-time, group-leadership, durable tombstone escalation) plus a
  sleep-wake re-arm so a laptop resume is never mistaken for a hang.
- **The chokepoint rides the vitest configs** (globalSetup + config-eval seam
  in all five configs), so every invocation path — package scripts, husky
  pre-push, editor integrations, ad-hoc `npx vitest` — is bounded with zero
  script rewiring. Nested test runs never deadlock (lane-scoped
  ancestry+holders skip) and are unconditionally clamped ≤4 workers,
  CLI-proof (pool-shaping argv neutralized at config-eval).
- **Observability**: `GET /test-runner-limiter` (pure read — per-lane
  saturation, live holders, recent ledger events, skip histogram) +
  `POST /test-runner-limiter/prune` (the recovery lever that replaces
  hand-editing JSON — single-flight, rate-limited, enumerates what it
  reclaimed). CapabilityIndex entry, `/guards` grading (a sustained
  self-disable pattern grades `diverged`), CLAUDE.md awareness for new AND
  existing agents (templates + PostUpdateMigrator). Serverless builder hosts
  get loud stderr WARNs at the chokepoint plus WARN-only ledger-pattern
  checks in `dev:preflight` and pre-push (structurally incapable of blocking
  a push).
- **Kill switch**: env-only `INSTAR_HOST_TEST_SEMAPHORE=off` — immediate,
  ledger-visible, never silent. Config `intelligence.testRunnerCap` tunes the
  route report only; it is deliberately NOT a chokepoint lever.

## Evidence

- Spec convergence: 10 review rounds, 6 internal reviewers + two external
  model families (codex GPT-tier, gemini) every round; final round zero
  must-fix findings (`docs/specs/reports/test-runner-concurrency-bound-convergence.md`).
- All three test tiers plus meta-verification ship in this PR: unit
  (semaphore matrix, classifier, core-extraction golden tests pinning the
  spawn lane byte-identical), integration (route through the real pipeline),
  e2e (route alive through real AgentServer plumbing), and meta-verification
  with REAL spawned vitest roots — K=3 simultaneous roots at cap 1 admit
  at-most-one concurrently; acquire-before-fanout proven on the pinned vitest
  version; a nested child with `--maxWorkers=32` measured at ≤4 actual
  workers; the wait-line frame signature validated against the live
  silence/load-stall sentinel predicates so a waiting run never reads as a
  hang.
- Side-effects review + independent second-pass:
  `upgrades/side-effects/test-runner-concurrency-bound.md`.

## What to Tell Your User

🧪 Preview (watch-only): your machine now has a "deli counter" for test runs —
full test suites take a ticket and run one at a time per machine, while small
quick test runs get their own express lane. This is the fix for the meltdowns
where dozens of test suites piled up at once and starved everything else. For
the first two weeks it only WATCHES and keeps a log of what it would have
done — it blocks nothing and kills nothing until the log proves it's safe and
the operator deliberately flips it on. If a test run ever seems to wait, ask
me "why is my test run waiting?" and I'll read the limiter's live state.

## Summary of New Capabilities

- Ask "why is my test run waiting?" / "is the test lane saturated?" →
  `GET /test-runner-limiter` (per-lane availability, live holders with ages,
  recent decisions).
- Ask "clear the stuck test slot" → `POST /test-runner-limiter/prune` — the
  safe recovery lever (frees dead/expired holders; never kills processes by
  default).
- A rejected `git push` on a busy machine may be lane contention, not red
  tests — the failure message names the holders and the levers, and I check
  the limiter before assuming test failures.
