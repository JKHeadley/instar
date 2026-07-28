# Convergence Report — Cross-Machine Ownership-Reconciler Convergence

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass (codex CLI) AND a Gemini-tier pass (gemini CLI) ran on EVERY round through
the agent's own first-party CLI logins. Final-round external verdicts: codex `MINOR ISSUES` (its one
finding folded), gemini `CLEAN`. This is the clean RAN state — the spec received genuine outside-model
review across all three rounds.

## ELI10 Overview

When you run your agent on two machines (Laptop + Mac Mini), you can move a conversation from one to the
other — but sometimes the move just never lands and the conversation stays stuck on the old machine. This
spec fixes that. The machines keep separate notebooks about who's handling which conversation and sync by
mailing each other notes; the bug was that two of those notes — "please move this to the Laptop" and
"okay, it's your turn to take it" — were never being mailed across, so the move never completed. The fix
mails both notes over the rails the machines already use, so the receiving machine knows to take over.

It matters because moving a conversation between your machines is a core multi-machine feature, and right
now it silently fails. After this ships (switched-off by default, turned on deliberately), a move actually
completes — and if it ever can't, you see a clear "still moving / couldn't move" status instead of silence.

The main tradeoff: cross-machine state is eventually consistent (a move takes ~45–90 seconds, not instant),
and the design leans on the existing replication log. We made that dependency explicit and bounded every
time-based decision so a stale or corrupt note from a temporarily-offline machine can't cause a wrong or
permanently-stuck move.

## Original vs Converged

The original spec was directionally right (replicate the pin + the handoff signal over the existing
journal) but had real holes that three review rounds closed:

- **It trusted clocks.** The first design resolved competing move-instructions by wall-clock timestamp —
  the EXACT clock-skew class that caused the incident. Converged: ordering uses the journal's existing
  Hybrid Logical Clocks (HLC), never wall-clock, and every time-based recovery is bounded by
  receiver-observed time, not a peer-supplied stamp.
- **A mailed instruction could become silently authoritative.** Converged: replicated pins land in a
  SEPARATE advisory store (never the authoritative one), are validated (known + online target, fresh),
  and can only trigger the owner's own cooperative hand-off — never a seat-steal — under an explicitly
  declared single-agent threat model.
- **It could trade one stuck-state for another.** A half-finished hand-off (target dies mid-move) could
  freeze a conversation a new way. Converged: a convergence deadline + two concrete recovery cases
  (abort-transfer if the target is unreachable; force-claim past an age backstop if the source is
  provably dead) guarantee no new permanent-stall class.
- **A code-level field error.** Review caught that the field the hand-off timing actually keys on is the
  record's `timestamp`, not a field name the draft invented. Converged: the correct field is carried
  (and clamped), and the receiving machine sources its output-exclusion timing from it.
- **The blind-spot harness.** The deepest finding: the reconciler's tests shared ONE in-memory store
  across both simulated machines, which is exactly why the bug hid for months. Converged: the test
  harness is REBUILT so each machine owns a separate store joined only by a simulated journal — every
  reconciler test now runs the real two-machine topology, the root cause is fixed, not papered over.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes | Standards-Conformance Gate |
|-----------|-----------------------|-------------------|--------------|----------------------------|
| 1 | conformance, codex, gemini, security, adversarial, scalability, decision-completeness, lessons-aware | ~20 (HLC ordering, provenance, transferTo validation, drainInFlight loss, stuck-transferring, shared-store harness, journal-kind discipline, epoch fence, …) | Full v2 rewrite | ran (2 flags) |
| 2 | security (SE8), adversarial (N1, N3), conformance (Tier-0, loop-brakes) | 3 (N1 field-model, N3 pin-precedence, SE8 timestamp clamp) | v3 fold | ran (2 flags) |
| 3 | codex (local-pin HLC, MINOR), conformance (Tier-0 heuristic) | 0 material | local-pin-HLC clause + status line | ran (1 flag — Tier-0 heuristic, signal-only, addressed) |

## Full Findings Catalog

Round 1 (~20): pin ordering HLC-not-wall-clock (codex/SE3/AD1/DC2/INT5/LA3); replicated-pin provenance /
forged-pin (codex C1/AD4/INT4/LA1) → advisory store + declared single-agent model; validate transferTo
(SE1/AD3/INT6); thread status+transferTo at all CAS sites + journal validate (INT2); carry
drainInFlight+timestamp, no re-stamp (AD2); stuck-transferring deadline/abort (DC3/SE4/AD7/G2/LA5/INT7);
rebuild makeSim separate-stores (LA2); journal-kind discipline + quarantine (S2/SE5/INT6/LA4); epoch fence
(SE2); applier high-water cursor + rotateKeep (S1/S3/AD8); pin TTL + tombstone (AD5/LA6); thrash cooldown
(AD6); equal-epoch owner-anchored tie-break (SE6); pin-store blind-overwrite (SE7); /pool/reconciler ctx
wiring + migrateClaudeMd (INT3); version-skew both-new (INT1); metrics + real E2E (conformance); log/quarantine
drops not silent (DC7/LA4); supervision Tier-0 (LA7); pendingReplacement honest-pending (LA6).
Round 2 material: N1 (timestamp field model, HIGH, code-verified); N3 (local-pin masks replicated intent,
MED); SE8 (clamp carried timestamp, MATERIAL). All folded into v3.
Round 3: codex local-pin-HLC writer model (MINOR — folded: local pin gains HLC/version + atomic write);
Tier-0 heuristic (signal-only, addressed with sound justification — an LLM in an ownership-CAS hot loop is
the anti-pattern; aggregate-health watch is the supervisor). adversarial+security: all round-2 resolved,
none new at HIGH/MED, "ship." lessons+decision: CONVERGED. gemini: CLEAN.

## Convergence verdict

Converged at iteration 3. Zero material findings in the final round (the one MINOR external finding folded;
the persistent Tier-0 conformance flag is a signal-only heuristic, soundly addressed). Open questions = none;
5 frontloaded decisions; the shared-store testing-integrity root cause is fixed at the root. Spec is ready
for user review and approval.
