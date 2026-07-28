# Convergence Report — Autonomous registration backstop

## Cross-model review: UNAVAILABLE (in-context)

The external cross-model pass (codex/gemini) was **not run**: the worktree has no
built `dist/core/crossModelReviewer.js` (`pnpm build` not run in the isolated
worktree), so the reviewer harness is unassemblable in-context. Recorded honestly
— this matches the same condition on this run's P1/P2/P4 specs. No
activation-history dependency forces it. The internal six-perspective panel +
the code-backed Standards-Conformance Gate ran in full both rounds.

## Iterations: 2 (converged)

### Round 1 — full panel (6 internal perspectives + conformance gate)

Conformance gate: ran, 0 flags both rounds.

Material findings (≈18 across reviewers, heavily convergent):

- **Reap KEEP/eligibility AGREEMENT (lessons-aware, the killer finding).** The
  draft injected revival evidence gated only on a 6h window, NOT on the
  `recentUserMessage` predicate `ReapGuard`'s KEEP-probe uses — re-creating the
  2026-06-13 13-session age-kill→revive loop. → Added D8: injection requires the
  SAME `recentUserMessage(topic, staleCommitmentWindowMs)` corroboration so the
  KEEP and eligibility decisions agree.
- **`createdAt`-only freshness (security/adversarial/decision/scalability — unanimous).**
  `updatedAt` does not exist on `Commitment`; any bookkeeping/beacon timestamp
  would defeat the window. → D1: freshness keyed on `createdAt` only; beacon
  bumps explicitly excluded.
- **No drain-time re-check on the commitment path (security/adversarial).** The
  existing `autonomousRunFinished` re-check keys on the age-limit reason + reads
  the state file (absent here). → D9: distinct `COMMITMENT_ACTIVE_RUN_REASON` +
  `commitmentStillActiveForTopic` drain predicate.
- **Qualifying set too broad (adversarial/security/decision).** `getActive()`
  includes `violated` + user-blocked commitments. → D2: `pending`-only,
  agent-driven, exclude user-blocked / beacon-paused / replicated-origin.
- **`evidenceSource` is a new reap-log field, not an existing stamp (integration/decision).**
  → D3: additive optional field + back-compat default + PII constraint (never
  copy `userRequest`/`agentResponse`).
- **Part C understated (integration ×2, lessons).** Legacy fallback target was
  doubly-stale (`.claude/`→`.instar/`); per-topic needs `HotPathInputs` plumbing.
  → Descoped Part C to the legacy-path correction; per-topic tracked as follow-up.
- **No testing section (integration/lessons/decision).** → Added 3-tier Testing
  section (both sides of the freshness boundary, fail-open, wiring-integrity,
  P19 anti-loop regression).
- **Title/root overstatement (lessons F2).** → Re-scoped to a BACKSTOP
  (committed runs only); the root registration fix is a tracked owned follow-up.
- Plus: fail-open contract (D7), pin-to-age-limit-branch + inject-once
  (scalability), Part A flood routing through the aggregated chokepoint (P17, D4),
  supervision Tier 0 (D10), multi-machine local-origin filter.

### Round 2 — convergence verification (all 6 perspectives, 2 verifiers)

Both verifiers returned **CONVERGED: yes** — every round-1 material finding
verified resolved at a cited section/decision, **no new material issues**,
`## Open questions` is exactly `*(none)*`, and the spec confirmed
single-run-completable (the two larger pieces carved out as tracked follow-ups).
One non-blocking observation noted: D9's drain re-check can invalidate a
genuinely-working unregistered run if user activity lapsed during a calm period —
accepted as the conservative/safe direction, consistent with the BACKSTOP scope
and the 2026-06-13 anti-loop invariant.

## Decision-completeness

Frontloaded decisions: D1–D10. Cheap-tags contested: the dark/dryRun tag (D5)
upheld for Part B injection; Part A's observe-only-regardless upheld **conditional
on** the dedup being routed through the P17 chokepoint (now done). No decision is
parked on the operator (correct for a pre-approved, dark/dryRun build).

## Verdict

CONVERGED in 2 rounds. Approved under the operator's standing full pre-approval
for this autonomous run (decisions are the agent's; reversible, dark, dryRun-first).
