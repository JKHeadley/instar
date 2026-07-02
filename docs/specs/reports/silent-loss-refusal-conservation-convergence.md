# Convergence Report — Silent-Loss Eradication (Refusal Conservation + Wiring-Time Registry Gate)

Spec: `docs/specs/silent-loss-refusal-conservation.md`
Author: echo · Ceremony: `/spec-converge` · Project: `self-healing-mesh` (topic 29836)

## Cross-model review: RAN — codex-cli:gpt-5.5 (+ gemini-cli:gemini-2.5-pro)

Both non-Claude families available and exercised every round (codex GPT-5.5 +
Gemini 2.5 Pro). Round-by-round external verdicts: R1 MINOR/MINOR · R2 MINOR/MINOR ·
R3 MINOR/MINOR · R4 codex MINOR. No round degraded; the spec received genuine
outside-Claude review on every content change. Aggregate flag: `codex-cli:gpt-5.5`.

## Reviewer panel (per round)

Six internal Claude reviewers (security, scalability, adversarial,
integration/deployment, decision-completeness, lessons-aware) + the code-backed
Standards-Conformance Gate + the cross-model external pass (codex + gemini).

## Iteration summary

- **Standards-Conformance Gate:** ran every round (51 standards). R2 flagged
  Constitutional-Traceability (the parent/sibling standards were unmerged at the
  time — resolved by merging PR #1316 and repointing the parent to the ratified
  "A Refusal Stays a Refusal"), LLM-Supervised-Execution (resolved via the
  tier0-on-path + tier1-supervisor framing), and No-Deferrals (resolved via
  active-follow-through tracked deferrals). R4: traceability resolves on-disk once
  the branch rebases onto post-#1316 main (build-time dependency, documented §7).

- **Round 1** — full panel. ~40 findings across all reviewers. Headline material:
  adding `rejected` to the union does NOT force compile errors at boolean/if-chain
  consumers (integration #1); rejection-trace must be metadata-only (security #1);
  never-populated vs emptied-by-deletion (security #2); wiring gate must re-arm
  per-call (security #3); per-message UserManager construction does sync writes
  (scalability #1); missing `## Frontloaded Decisions` + `## Open questions`
  (decision-completeness). → Phase 2: full synthesis.

- **Round 2** — full panel. ~13 material, almost all second-order consequences of
  the round-1 fixes: `forceReplace` boolean re-collapse of `rejected` (adversarial
  #M1); override-vs-load dead-end/data-bypass (security #2 + adversarial #M2);
  the empty-registry taxonomy was UNBUILDABLE — never-populated and
  emptied-by-deletion are byte-identical `[]` on disk with no ever-populated signal
  (lessons material #1); rotation allowlist is a no-op for `logs/` files
  (integration #M1); g3 spawn-forward carries no envelope (integration #M2);
  decay defeated by a flapping peer (adversarial #M3); per-call read unbounded
  under replay storm (adversarial #M4 / scalability). → Phase 2b: full synthesis —
  durable high-water marker; signed override marker + dashboard-PIN; mtime-gated
  read; distinct forceReplace verdict + drain-escape mapping; cross-topic ceiling
  + flapping-proof decay; maybeRotateJsonl append-path bounding; parent repointed.

- **Round 3** — full panel. lessons-aware CONVERGED; scalability CONVERGED;
  codex + gemini MINOR. Localized material (no architectural changes): signed
  allow-marker signing-key custody undecided (decision-completeness + security);
  high-water never back-filled for the installed base (integration #1 +
  adversarial minor); `0600` doesn't survive rotation (integration #2);
  parse-failure fails open too broadly (codex); ledger-settle-as-abandoned would
  double-notify via stuckMessageRecovery (adversarial material). → Phase 2c/2d:
  HMAC-on-server-vault-secret with an honest out-of-scope threat model; high-water
  set-point broadened to all real-user-introduction paths + §4 migration backfill;
  0600 re-chmod on rotation; parse-failure → UNKNOWN_UNSAFE fail-closed (conserved
  through the notice path); distinct `markRejected` ledger terminal; all-mutators
  operator-resolution invariant + UserPropagator-stays-unwired guard; suppression
  cache bound; stat-gate on (mtime,size); notice wording de-topology'd.

- **Round 4** — convergence confirmation. Decision-completeness CONVERGED (all 25
  Frontloaded Decisions genuine, Open questions genuinely empty). Security CONVERGED
  (the HMAC-on-server-vault-secret reframe verified coherent against `checkMandatePin`
  + the honest out-of-scope threat model). Lessons-aware CONVERGED (all Phase-2c
  late edits consistent; one non-blocking coherence nit — WS2.6-replication-in as a
  high-water setter — polished out). Codex external MINOR (both findings folded:
  UNKNOWN_UNSAFE conserved through the notice path; notice topology leak removed).
  Adversarial found ONE material — the distinct `markRejected` widened `LedgerState`
  without enumerating it into the three ledger consumers (`decideIngress`,
  `beginProcessing`, `isActedOn`), so a redelivered `update_id` would resurrect the
  terminal row and re-open the double-notify; it also corrected the round-3
  rationale (a directly-settled terminal is never re-surfaced by `reclaimStuck`).
  → Phase 2d: kept the distinct `markRejected` (parent principle: a refusal stays
  distinguishable) AND enumerated `'rejected'` into all three consumers + two named
  redelivery/ledger tests, applying §A's "enumerate every consumer of a widened
  union" discipline to `LedgerState`.

- **Round 5** — targeted confirmation of the round-4 ledger-enumeration fix
  (adversarial, the raising reviewer, + codex external on the changed body).
  **Adversarial: CONVERGED** — verified all three ledger line-cites
  (`ingressDedup.ts:78`, `beginProcessing` ~L190, `isActedOn` ~L179) against the
  real code, confirmed the corrected rationale (`reclaimStuck` selects `WHERE
  state='processing'`, so a directly-settled terminal is never re-surfaced), swept
  for a missed `LedgerState` consumer (none material — `commitReply` /
  `applyRemoteReplyMarker` are unreachable-or-benign on the rejected path), and
  confirmed the two named tests map onto the closed paths. **Codex external:
  MINOR** — one readability suggestion (add an implementation summary), folded as
  the §2 Implementation Summary. **No material new issue → converged.**

## Iterations: 5 · Converged: true

## Convergence rationale

The spec converged after the round-4 ledger-enumeration fix — the last material
finding, resolved with the raising reviewer's own prescription and mirroring the
`RouteOutcome` enumeration discipline §A had already validated — produced no new
material issue in the round-5 confirmation. Across the ceremony: three reviewers
returned CONVERGED by round 3-4; every material finding was a genuine defect (many
second-order consequences of prior-round fixes) addressed with the reviewer's
prescribed resolution; and the cross-model external pass ran genuinely every round
(codex GPT-5.5 + Gemini 2.5 Pro, R1-R5, never degraded). `## Open questions` is
empty (operator pre-approval, topic 29836); every reviewer-contested choice is
resolved in the 25 Frontloaded Decisions.

## Build dependencies (documented)

1. Rebase the branch onto post-#1316 canonical main (`git fetch JKHeadley && git
   rebase JKHeadley/main`) so the ratified standards resolve on-disk for the
   conformance gate. #1316 merged 2026-07-02 (commit 18ee21cb).
2. The postmortem doc is already upstream via #1316 — commit only the spec + eli16.
