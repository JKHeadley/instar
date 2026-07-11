# Ownership-gated spawn, duplicate reconciliation & judgment-within-floors (Increment 1)

## What Changed

The duplicate-session fix (spec: `docs/specs/ownership-gated-spawn-and-judgment-within-floors.md`, operator-approved with three ratified standards). A new `SpawnAdmission` checkpoint makes the routing verdict BINDING at every conversation-bound session-creating callsite (Telegram cold-spawn/respawns, Slack inbound/recovery); a duplicate-session reconciler on the serving-lease holder detects the same conversation live on ≥2 machines, determines the rightful owner from evidence (pin → strongest admissible ownership record → registered live run → escalate), converges the ownership record, and lets the existing gated closeout close the spare; an owner-dark ladder ships the honest rung-3 notice floor; every judgment call is durably logged to a machine-local provenance store (`state/judgment-provenance/`, gitignored, backup-excluded, never HTTP-served raw — a net-new hardcoded `NEVER_SERVED_PREFIXES` deny in the file routes, symlink-evasion-proof); three ratified standards (Judgment Within Floors; Decision Provenance & Outcome Review; Ownership-Gated Side Effects) land in `docs/STANDARDS-REGISTRY.md` with their spec-review + side-effects-review enforcement questions and migrations. **Everything ships dev-gated + dryRun (observe-only): no runtime behavior changes anywhere in this increment.** New read surfaces: `GET /pool/duplicate-reconciler` (the unified watcher status), `GET /pool/ownership-view`, `GET /judgment-provenance` (redacted rows only).

## Evidence

- Unit tiers cover the admission table exhaustively (incl. the TOCTOU router-verdict consumption and the structural invariant that enforcement is impossible while the durable inbound queue is dark), the error-arm windowed breaker with hysteresis, the notice floor's four dedupe layers, the reconciler's evidence ladder with every ambiguity escalating, provenance redaction/clamps/sampling/retention, and the convergence-tag structural refusal.
- Wiring tests pin the five callsite consultations and the 403s on `state/judgment-provenance/*` (read/download/edit/link + a symlink-evasion case) under default config.
- The burst-invariant E2E proves N inbound messages for owned-elsewhere topics create ZERO local sessions and EXACTLY ONE notice per topic-episode in enforce mode.
- Both new background actors registered in the Capacity Safety `selfActionRegistry` and pass the sustained-pressure convergence ratchet.

## What to Tell Your User

Groundwork for ending duplicate conversations across machines: the system now watches every place a conversation session can be created and records what it WOULD have done to prevent a machine answering a conversation it doesn't own — plus a full decision audit trail. Nothing changes in behavior yet; this stage is observation, with enforcement following on the development machines first once the observation data looks right.

## Summary of New Capabilities

- One status read answers "is the duplicate-prevention layer healthy?" (`GET /pool/duplicate-reconciler`).
- Every ownership judgment call is auditable end-to-end (`GET /judgment-provenance`, redacted; full context machine-local, 14-day retention).
- Every future spec must classify its decision points (invariant vs judgment-candidate) before it can converge; every code change must answer the judgment-point question in its side-effects review.
