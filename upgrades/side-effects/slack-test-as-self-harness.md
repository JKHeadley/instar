# Side-Effects Review — test-as-self for Slack (permission demonstration harness)

**Version / slug:** `slack-test-as-self-harness`
**Date:** `2026-06-09`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `not required (Tier 1)`

## Summary of the change

Pillar 4 / milestone 4 of the Slack org permission system (`SLACK-ORG-INTEGRATION-SPEC.md` §8).
This is a **test/demonstration harness over the EXISTING `SlackPermissionGate`** — it adds no
new runtime decision logic. It extends the existing `SlackScenarioHarness` (six gate-direct rows,
decision-only) with: (a) two more scenario rows — a granted-member-floor (→ allow/`floor-granted`)
and an unregistered outsider (→ refuse/`unregistered`) — completing the deterministic
credential-free subset; (b) a `StaticGrantStore` (deterministic fixture mirroring
`MandateBackedGrantStore`) and a `CastUserLookup` registry resolver, both plain test doubles that
feed the existing gate; (c) `runAuditedScenarioSuite`, which drives every row through the SAME
`SlackPermissionObserver` the live `SlackAdapter._handleMessage` calls (resolver → gate →
`PermissionDecisionLedger`) and asserts BOTH the verdict AND the matching audit-ledger entry
("verified, not narrated"). It exposes an executable surface: `POST /permissions/scenario-suite/run`
and `instar test-as-self --slack`. Files: `src/permissions/testing/SlackScenarioHarness.ts`,
`src/server/routes.ts`, `src/commands/test-as-self.ts`, `src/cli.ts`, `src/scaffold/templates.ts`,
plus three new test files and two updated test files.

## Decision-point inventory

This change touches NO runtime decision point. Every component invokes the existing gate and
reads the existing ledger; nothing gates, blocks, filters, or constrains agent behavior.

- `SlackPermissionGate.evaluate` — **pass-through** — unchanged; the harness only calls it.
- `buildSliceZeroGate()` (test helper) — **modify** — now constructs the gate with a
  `StaticGrantStore`. Deny-by-default for everyone except the single Grace fixture, so no
  existing row's verdict changes; it solely enables the `floor-granted` path for the new row.
- `StaticGrantStore` / `CastUserLookup` — **add** — test fixtures (a `GrantStore` and a
  `UserLookup` test-double). No authority; they only supply inputs to the existing gate.
- `POST /permissions/scenario-suite/run` / `test-as-self --slack` — **add** — read-only/dev
  executable wrappers that run the suite into a throwaway temp dir and return a report.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The harness asserts the existing gate's
verdicts; it never itself rejects any input. (The gate's own over/under-block behavior is what
the harness *measures*, and is governed by the gate's own spec, unchanged here.)

---

## 2. Under-block

No block/allow surface — under-block not applicable. One harness-level honesty note: if a future
gate change altered a verdict, the suite would catch it as a row mismatch (that is the point — it
is a regression wall). The audit-assertion half also catches the subtler failure where a verdict
is returned but the ledger write silently fails.

---

## 3. Level-of-abstraction fit

Correct layer. This is a **demonstration/test harness** sitting ABOVE the gate, deliberately
driving the production observe path (`SlackPermissionObserver`) rather than re-implementing it.
It reuses the real `SlackPermissionGate`, real `SlackPermissionObserver`, real
`SlackPrincipalResolver`, and real `PermissionDecisionLedger`. The `StaticGrantStore` is the
deterministic, credential-free mirror of `MandateBackedGrantStore` (the live A4 path needs a
PIN-gated signed mandate that cannot run in CI) — it implements the SAME `GrantStore` interface
so the gate's `floor-granted` branch is exercised identically; only the grant's provenance
differs (a fixture vs a signed mandate), which is exactly the deterministic-vs-live seam (§8.3).

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] **No — this change has no block/allow surface.**

The harness/route/CLI hold no authority. They invoke the existing gate and read its ledger. The
`StaticGrantStore` is a test fixture feeding the existing gate, not a new authority. Nothing here
makes a brittle blocking decision.

---

## 5. Interactions

- **Shadowing:** none. The harness runs the gate in isolation; it does not sit in any live
  message path. (The full-pipeline test invokes `_handleMessage` directly in a test process with
  a fake bot token — it never touches a real Slack workspace.)
- **Double-fire:** none. The audit-asserting run uses its OWN ledger in a fresh temp dir, so it
  cannot collide with the live `/permissions/decisions` ledger or any live observer.
- **Races:** none. Each suite run is hermetic (its own temp state dir).
- **Feedback loops:** none. The behavior baseline (`RelationshipBehaviorStore`) is NOT wired into
  the harness observer, so running the suite writes no durable baseline that could feed back into
  the live anomaly scorer.

---

## 6. External surfaces

- **Other agents / users / external systems:** none. No real Slack tokens, no network calls to
  Slack (the fake-token reaction/user-lookup calls inside `_handleMessage` fail closed with
  `invalid_auth` and are swallowed — they are best-effort UI sugar, not assertions).
- **Persistent state:** none in the running agent. The audit-asserting suite writes its ledger
  into `os.tmpdir()`, never `ctx.config.stateDir`; an integration test explicitly asserts the
  returned `ledgerPath` is not under the route's configured state dir.
- **CLAUDE.md template:** the agent template's `## Test-As-Self` section gains a documented
  `--slack` line + the two HTTP endpoints (Agent Awareness Standard). New agents receive it via
  `init`; this is a doc surface, not runtime behavior — see Migration Parity note in the conclusion.
- **Timing/runtime conditions we don't control:** none — the suite is fully deterministic
  (heuristic classifier + static baselines + static grants + injectable nothing-from-network).

---

## 7. Rollback cost

Pure additive code + tests + docs. Rollback = revert the commit and ship a patch. No persistent
state to migrate (the suite's only writes are throwaway temp dirs). No agent-state repair. No
user-visible regression during the rollback window (this is a maintainer/dev demonstration tool,
not a user-facing capability). The one behavior tweak (`buildSliceZeroGate` gains a grant store)
is confined to the test harness and is deny-by-default for all but the Grace fixture.

---

## Conclusion

The review found no decision-point surface and no signal-vs-authority concern: every component
invokes the existing gate and reads the existing ledger. The change's value is precisely that it
makes the gate's governance *watchable and self-verified* — each (principal, request) row produces
its expected verdict AND its matching audit entry, through the same observer the live adapter uses.
The deterministic-vs-live seam is honest (the live-Slack-workspace layer is explicitly out of scope
and remains operator-driven). All three test tiers are green; `tsc` and `lint` are clean. Clear to
commit (Tier 1). **Migration Parity note:** the only agent-installed artifact touched is the
CLAUDE.md template doc line for a dev-only tool — the route + CLI ship as compiled dist that every
agent receives automatically on update; no `PostUpdateMigrator` entry is warranted for a doc line
on a maintainer-only surface (consistent with how the existing `/permissions/scenario-suite` route
is treated).

---

## Second-pass review (if required)

Not required — Tier 1 (a test/demonstration harness with no block/allow surface and no session
lifecycle / gate / sentinel / watchdog runtime change).

---

## Evidence pointers

- `tests/unit/slack-scenario-audit-harness.test.ts` — 16 tests (cast, fixtures, both decision
  boundaries per row, audit-entry assertion, durable-ledger read-back).
- `tests/integration/slack-permission-pipeline.test.ts` — 3 tests (every row through
  `_handleMessage` → observer → ledger; granted-member + unregistered-outsider live-path rows).
- `tests/integration/permissions-routes.test.ts` — updated; `GET /permissions/scenario-suite`
  (8 rows) + `POST /permissions/scenario-suite/run` (verdict AND audit per row).
- `tests/e2e/slack-scenario-suite-route.test.ts` — 2 tests (feature alive: 200 + full green report).
- CLI smoke: `node dist/cli.js test-as-self --slack` → all 8 rows `audit✓`, `VERDICT: PASS`, exit 0.
