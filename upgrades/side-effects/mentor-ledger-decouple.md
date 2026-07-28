# Side-Effects Review — Decouple mentor ledger from TokenLedger init (production fix)

**Spec:** `docs/specs/FRAMEWORK-ONBOARDING-MENTOR-SPEC.md` (converged 5 iters, approved by Justin)
**Change:** The `FrameworkIssueLedger` + `MentorOnboardingRunner` construction was sequenced AFTER
`new TokenLedger()` inside the SAME try block in `AgentServer`. If TokenLedger's constructor throws,
the outer catch fires and the mentor ledger/runner never construct → `/framework-issues` + `/mentor/*`
all return 503. Moved them to their OWN independent try/catch, so a TokenLedger failure can't cascade.
**Files:** `src/server/AgentServer.ts`, `tests/e2e/mentor-onboarding-lifecycle.test.ts`, `upgrades/NEXT.md`.

## How it was found

Deployed the merged mentor system to Echo's real server (v1.3.22) and hit the routes — all 503.
Echo's TokenLedger has thrown `SqliteError: no such column: attribution_key` on every boot since
2026-05-25 (a stale token-ledger.db schema). Because my mentor-ledger construction was downstream of
TokenLedger in one try, that pre-existing TokenLedger failure took the mentor surface down with it.
The e2e tests never caught it because they use a fresh stateDir where TokenLedger constructs cleanly.
This is exactly the production-only failure mode that a real deploy surfaces and tests can't.

## Principle check (Phase 1)

Decision point? No — a construction-ordering/resilience fix. Improves fault isolation. Signal-only.

## The seven questions

1. **Over-block.** None. Strictly improves availability (mentor survives TokenLedger failure).
2. **Under-block.** The mentor ledger now has its OWN try/catch; if IT throws, the routes still 503
   (correct — that's the real ledger being unavailable, not a cascade). No new failure masked.
3. **Level-of-abstraction fit.** Each independent subsystem gets its own init try/catch — the right
   pattern (TokenLedger failure ≠ mentor-ledger failure). Mirrors how other optional subsystems init.
4. **Signal vs authority.** Unchanged.
5. **Interactions.** The mentor block now recomputes `serverDataDir` (idempotent `mkdirSync`); no
   shared state with the TokenLedger block beyond the directory. Construction order otherwise
   unchanged. The poller/burn-detection (which depend on TokenLedger) are unaffected.
6. **External surfaces.** Makes `/mentor/*` + `/framework-issues` resilient — they'll be alive on
   agents whose TokenLedger is broken (a real population, e.g. Echo). No new surface.
7. **Rollback cost.** Trivial — revert re-couples them (restoring the bug).

## Phase 5 — second-pass

Not required — a fault-isolation refactor (separate try/catch), no new decision/spawn surface; the
§19.4 loop already carried the dedicated second-pass.

## Related discovery (NOT in this PR — flagged separately)

The deploy ALSO surfaced a fleet-wide, pre-existing bug unrelated to the mentor system: ALL built-in
agentmd jobs fail to load (`jobCount=0`) because `InstallBuiltinJobs` generates per-slug manifests
without a `priority` field while the manifest validator requires it (failing since ~2026-05-20, 1200+
log occurrences). This is a core JobScheduler/InstallBuiltinJobs issue with fleet-wide blast radius —
it needs its own spec'd fix, not a bundle with this mentor change. Flagged to Justin.

## Testing

E2E regression (+1): a pre-planted corrupt `token-ledger.db` makes the real TokenLedger fail, and the
test asserts `/mentor/status` + `/framework-issues` are 200 (NOT 503) — the cascade is broken. 7 mentor
e2e tests total; affected push-config suite green vs canonical main.
