# Side-Effects Review — FrameworkIssueLedger (Mentor System §19.1 foundation)

**Spec:** `docs/specs/FRAMEWORK-ONBOARDING-MENTOR-SPEC.md` (converged 5 iters, approved by Justin)
**Change:** New SQLite two-table issue ledger (`framework_issues` + `framework_observations`),
two read-only HTTP routes (`/framework-issues`, `/framework-issues/playbook`), AgentServer
startup instantiation, RouteContext wiring, CLAUDE.md template row + migrator section, NEXT.md.
**Files:** `src/monitoring/FrameworkIssueLedger.ts` (new), `src/server/routes.ts`,
`src/server/AgentServer.ts`, `src/scaffold/templates.ts`, `src/core/PostUpdateMigrator.ts`,
`tests/unit/FrameworkIssueLedger.test.ts` (new), `tests/integration/framework-issues-routes.test.ts` (new),
`tests/e2e/framework-issue-ledger-lifecycle.test.ts` (new), `tests/unit/feature-delivery-completeness.test.ts`,
`upgrades/NEXT.md`.

## Principle check (Phase 1)

Does this involve a decision point that gates info flow / blocks actions / filters messages /
constrains agent behavior? **No.** The ledger is a data store + read-only routes — it records
observations (signal) and serves queries. It holds zero blocking authority. The decision-bearing
parts of the mentor system (two-hats enforcement, assignment admission, graduation authority)
are §19.3–5 and ship later. This PR is a data-model + observability change → **signal-only**,
the correct posture per `docs/signal-vs-authority.md`.

## The seven questions

1. **Over-block — what legitimate inputs does this reject that it shouldn't?**
   The routes reject unknown `framework` values (returns empty list, not an error) and invalid
   `bucket`/`status` enums (400). An unknown framework returning empty is intentional (allowlist,
   §17); it could surprise a caller who mistypes, but the response includes `knownFrameworks` so
   the caller can self-correct. No legitimate data is rejected on write — `recordObservation`
   accepts any framework string and creates the issue.

2. **Under-block — what failure modes does this still miss?**
   The ledger does not yet have a *writer* (Stage B auto-capture is §19.2), so today it only
   accepts observations from in-process callers (the e2e test writes directly). There is no public
   write route, so there is no untrusted-write surface to under-block. Secret-scanning of evidence
   is pattern-based (api-key/JWT/Slack/GitHub/PEM shapes) — a novel secret format could slip
   through; mitigated by the hard rule that evidence is an opaque reference, not log content, and
   the length cap. The probable-loop flag is a heuristic (12 obs/hr) — a slow loop under that rate
   won't trip it, but episode-collapsing already bounds recurrence inflation structurally.

3. **Level-of-abstraction fit — right layer? smarter gate exists?**
   Yes. It mirrors the established `TokenLedger` (read-only SQLite observability in
   `src/monitoring/`) and reuses `CommitmentTracker`'s transactional-mutate discipline. It does
   NOT duplicate FrameworkParitySentinel (renderings) — it records *behavior*, and §10 has the
   sentinel feed it as an upstream signal in a later PR. No smarter gate exists for this data.

4. **Signal vs authority compliance.**
   Compliant. The ledger produces/serves signal; it never gates. `recordObservation` writes a
   row; `listIssues`/`playbook` read. No method blocks, throttles, kills, or constrains. All
   authority over what to do with an entry (ship a fix, promote to playbook `extracted`, advance
   graduation) is reserved for the human per spec §6/§8 and lands in later PRs.

5. **Interactions — shadow / double-fire / race with cleanup?**
   - DB isolation: a dedicated `framework-issue-ledger.db` under `server-data/`, separate from
     `token-ledger.db` — no shadowing of TokenLedger or its BurnDetector reads.
   - Concurrency: WAL + `busy_timeout=5000` + a single SQLite transaction per write, with a
     `UNIQUE(issue_id, episode_key)` index as the race guard (a concurrent duplicate episode insert
     loses cleanly and is counted as already-recorded). Retention pruning runs inside the same txn.
   - Startup: instantiated in the same `stateDir` guard block as TokenLedger; its own try/catch
     means a ledger failure can't take down TokenLedger or server start.

6. **External surfaces — visible to other agents/users/systems? timing/runtime deps?**
   Two new read-only HTTP routes behind the standard Bearer middleware (verified by e2e: a
   bearer-less request gets 401). New agents get one Registry-First row in CLAUDE.md; existing
   agents get a migrator section (content-sniffed, idempotent). No Codex/Gemini shadow-marker
   (developer-layer observability, not an end-user capability — tracked as a legacyMigratorSection
   so the parity test stays green). No timing/conversation-state dependence.

7. **Rollback cost — if wrong in production, what's the back-out?**
   Low. The feature is dormant (no writer wired yet) and signal-only. Back-out = revert the PR;
   the `framework-issue-ledger.db` file is harmless read-only observability data that can be left
   on disk or deleted (nothing reads it except these routes). No data migration, no agent-state
   repair. The routes fail-soft to 503 if the ledger is unavailable, so even a construction
   failure degrades cleanly rather than breaking server start.

## Phase 5 — second-pass

**Not required.** The Phase-5 trigger list is block/allow decisions, session lifecycle,
compaction, coherence/idempotency/trust gates, and anything named sentinel/guard/gate/watchdog.
This change is none of those — it is a read-only observability ledger with no blocking authority.
The decision-bearing components of the mentor system (which WILL trigger Phase 5) ship in §19.3–5.
The spec itself already passed a 5-iteration adversarial/security/scalability/integration/lessons
convergence before this build.

## Testing

All three tiers, shipped in this PR (no "routes now, migration later"):
- Tier 1 (unit): 22 tests — CRUD, dedup false-merge resistance, episode collapsing, materialized
  recurrence, impactScore + decay, regression auto-suggest, enum + SQL-injection-literal guard,
  secret-scan redaction, retention pruning, playbook cross-framework semantics, clampLimit.
- Tier 2 (integration): 9 tests — routes over the HTTP pipeline (503, 200, limit clamp, framework
  allowlist, invalid-enum 400, playbook).
- Tier 3 (e2e "feature is alive"): 5 tests — real AgentServer boot, DB auto-creates on production
  init path, routes 200-not-503, written observation surfaces end-to-end, 401 without auth.
- Full push-config suite (vs JKHeadley/main): 3362 tests green, no regressions.

## Post-push CI fix

CI shard 1/4 caught `capabilities-discoverability.test.ts`: every registered route prefix must be
classified in `src/server/CapabilityIndex.ts` (the test reads routes.ts via regex, not import, so
vitest's `--changed` graph didn't link it locally). Classified `/framework-issues` as a read-only
observability capability (mirrors the `tokens` entry, `enabled: !!ctx.frameworkIssueLedger`). No
behavioral change — surfaces the read-only routes in `/capabilities`. 322 capability tests green.
