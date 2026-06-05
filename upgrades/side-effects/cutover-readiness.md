# Side-effects review — Cutover-readiness checker (coordination-mandate spec §7, G2.4)

Spec: `docs/specs/coordination-mandate.md` (approved by Justin, A/A/B, 2026-06-05) — §7
names G2.4 and decision 1A scopes it: everything UP TO the door, never the door. Change:
new `src/feedback-factory/cutoverReadiness.ts` + two `/cutover-readiness*` routes + the
REAL condition resolvers replacing the deny-safe stubs in `AgentServer`'s coordination
block.

## 1. Blast radius

Additive, with ONE deliberate behavior change inside the coordination block: the
`integrity-gate-pass` and `parity-zero-divergence` conditions were `() => false` stubs;
they now resolve from REAL durable state (the persisted import IntegrityReport and the
durable parity window). Until that state genuinely clears, both still evaluate false —
identical behavior to the stubs. The first mandate (per decision 3B) has no conditioned
authority, so nothing live consumes them yet; the change makes the future
execute-cutover authority REAL instead of permanently-denied. No other route, gate, or
store is modified.

## 2. State / data

Two new files under the `.instar/state/` convention, created on first use:
`feedback-parity-passes.jsonl` (append-only durable parity window, torn-line tolerant —
the merged #781 persistence) and `feedback-integrity-report.json` (the import tooling's
persisted IntegrityReport envelope). Absent files mean blocked/not-ready (deny-safe).

## 3. Security model (T7 — the assertion-proof boundary)

- **No "set the condition" input exists.** The ONLY writes: (a)
  `POST /cutover-readiness/parity-pass` TRIGGERS a server-side live fetch+compare
  (HttpParitySource → runDryRunCompare); the request body contributes NOTHING to the
  result (integration-tested with a hostile body asserting cleanliness). (b)
  `recordIntegrityReport()` is called by server-side import tooling — no HTTP route
  writes it by design.
- **A failed live check records NOTHING** — a fetch error is absence of evidence, not
  evidence of divergence, and it cannot extend the clean window either (unit-tested
  both ways).
- **Freshness bound (readiness-layer addition):** the merged gate has no max-staleness —
  a cleared streak stays cleared forever without new passes. The readiness layer marks
  the window STALE when the last pass is older than 6h (default) and `ready` requires
  fresh. Stated honestly: the gate's own policy is unchanged; staleness lives here.
- **The door is structural:** there is NO fire-cutover route (integration-tested), the
  status carries `door: 'manual-operator-click'` machine-readably, and the agent
  template explicitly forbids presenting `ready` as permission to flip.
- **Token handling:** the parity source token is read lazily from the encrypted
  SecretStore (`portal.instarReadToken` by default) at check time — never persisted in
  config, never logged, never in a response.

## 4. Failure modes

- No `feedbackMigration.paritySource` config → `runParityCheck` is null → the trigger
  route 409s with a plain reason; the readiness read surface still works.
- SecretStore miss → the check throws → 409, nothing recorded.
- Engine init failure → coordination block's existing try/catch → routes 503, boot
  unaffected.

## 5. Test coverage

9 unit + 5 integration + 3 e2e (17 total). The load-bearing e2e: a conditioned
execute-cutover authority DENIES on a fresh boot and flips to ALLOW only after the
durable state genuinely clears (pre-seeded parity window + integrity report written to
the production state path, no restart) — then re-blocks on a failed report. Conditions
provably resolve from REAL state on the production init path.
