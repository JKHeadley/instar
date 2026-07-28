# Convergence Report — Placement must see which platforms/workspaces a machine can actually serve

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass (codex CLI, gpt-5.5) ran in every round (5 rounds). gemini-cli was available but its call degraded on round 1 (timeout/error); per the aggregate rule a successful external pass in ≥1 round yields the clean `codex-cli:gpt-5.5` flag. The internal lessons-aware + decision-completeness reviewers also ran. (Standards-Conformance Gate: unavailable — the spec lives in a worktree path that escapes the server's specsDir; the markdown form returned 0 standards. Non-authoritative, noted; it never blocks.)

## ELI10 Overview

When one agent runs on two computers, the system decides which computer handles each conversation ("placement"). This change teaches placement something it was blind to: whether the computer it picks can actually REACH the channel. The bug, caught by the gold-standard live-test driving a real Slack channel: a Slack channel was assigned to the Mac Mini, but the Mini's Slack is connected to a *different* workspace — so the Mini "owned" a channel it couldn't see, and messages black-holed.

The fix adds, to each computer's regular heartbeat, a list of which channels it can actually reach (which Telegram chat it polls, which Slack workspaces its adapter is connected to), and makes placement prefer a computer that can reach the channel. Telegram is shared across both computers (so this is a no-op there); Slack workspaces are per-computer (so it matters there).

The main tradeoff surfaced by review: the signal is *positive* self-report ("I CAN serve this"), which — unlike the earlier quota fix's *self-incriminating* "I'm busy" — could in principle be abused by a compromised computer to grab another workspace's messages. The spec closes most of that by deriving the signal from the live adapter connection (not config) and names the remaining residual honestly, deferring the cryptographic hardening (a signed capability lease) to a tracked follow-up.

## Original vs Converged

The original spec was a near-copy of the earlier quota-aware-placement fix (CMT-1570): a boolean "can serve?" filter that fell through to least-loaded when nobody could serve. Review changed it substantially:

- **It would have RECREATED the black-hole.** The original "fall through to least-loaded if nobody serves" picks a computer that *structurally* cannot serve — the exact bug. Converged: a THREE-valued signal (`yes`/`no`/`unknown`) that distinguishes "structurally can't" (never place there) from "don't know yet" (fail-open during a rolling deploy), and surfaces an honest "no computer serves this" notice instead of a black-hole pick.
- **A missing signal could outrank a known-good computer.** Review caught that an old (`unknown`) computer could beat a known-reachable one by load. Converged: known-reachable computers always rank above unknown ones.
- **The security story was too rosy.** Two rounds pushed on it: the signal is positive self-report (abuse risk), a false claim exposes message *payloads* (not just availability), and "same blast radius" was an overclaim. Converged: the signal is adapter-derived (not a bare claim), the exposure increase is named honestly, and the cryptographic hardening (a corroborated/leased capability) is a tracked follow-up.
- **New user-visible surface + caller contract were under-specified.** Converged: the "unservable" case keeps `decide()`'s return type unchanged (returns a machine + a flag) and surfaces ONE deduped Attention item (never per-message), with the fallback machine defined per caller; freshness is handled by recomputing the signal each beat and clearing it immediately on adapter disconnect.

## Iteration Summary

| Round | External verdict | Reviewers who flagged | Material findings | Spec changes |
|-------|------------------|------------------------|-------------------|--------------|
| 1 | codex MINOR; gemini degraded | codex, lessons-aware, decision-completeness | 13 (codex 5, lessons-aware 5, decision-completeness 3) | three-valued eligibility; security section; pin-path fix; reachability-not-authority; freshness; deduped Attention surface; Frontloaded #2 platform-scoped; migration-debt |
| 2 | codex SERIOUS | codex | 3 new material (security self-correction precision, DATA-EXPOSURE, workspaceId sourcing) + contradictions from in-flight edits | security refined; data-exposure named; workspaceId sourcing; testing updated; considered-alternatives |
| 3 | codex MINOR | codex | 2 material (channelId schema, ingress-model) + precision | channelId added; ingress model clarified; hard-pin return shape; unifying failed-post follow-up |
| 4 | codex MINOR | codex | 2 material (unknown-outranks-yes, data-exposure overclaim) + precision | yes-over-unknown ranking; exposure-increase corrected; ingress cases split; terminology |
| 5 | codex MINOR | codex | security-scoping push + 2 precision (fallback-per-caller, freshness-on-disconnect) | adapter-derived grounding in-scope; clear-on-disconnect; fallback machine per caller; glossary; capability-lease alternative |
| 6 | (converged) | — | 0 material design findings (verdict stable MINOR for 3 rounds; remaining items are refinement/phrasing) | none |

## Full Findings Catalog

**Round 1 — codex (gpt-5.5):** (1) all-excluded fallback recreates the black-hole → three-valued eligibility; (2) stale heartbeat → freshness semantics; (3) workspace≠channel access → reachability-not-authority framing; (4) terminology overclaim → documented as reachability hint; (5) legacy fail-open under-specified → migration-debt note.
**Round 1 — lessons-aware:** (1, MATERIAL) positive self-report is a worse trust posture than CMT-1570's self-incriminating quota → Security section; (2) request must thread channel context (the bulk of the work) → enumerated callers + failover wiring test; (3, MATERIAL) hard-pin-to-`no` mirroring quota-blocked recreates the black-hole → `hard-pin-unsatisfiable`; (4) `unservable` is a structural validator → anchored to signal-vs-authority carve-out; (5) freshness via upstream liveness → reconciled.
**Round 1 — decision-completeness:** (G1, MATERIAL) the unservable user surface is a published interface → deduped Attention item frontloaded (wording/egress/dedupe); (G2, MATERIAL) `decide()` return-type unchanged (machine + flag, no new refusal variant); (G3, MATERIAL) Frontloaded #2 contradicted the Slack decision → made platform-specific. `## Open questions` confirmed `*(none)*`.
**Round 2 — codex:** (1) Frontloaded #2 / Testing contradictions (in-flight) → reconciled; (2) `now` arg inconsistency → removed; (3) self-correction too optimistic → reframed as observable-failed-session (DoS loop named); (4, MATERIAL) DATA-EXPOSURE not just denial → named; (5) workspaceId sourcing → from inbound `team_id`; (6) alternatives → central-registry comparison.
**Round 3 — codex:** (1) channelId missing from schema → added; (2) ingress-model contradiction → clarified (all-`no` is the transfer/pin edge); (3) hard-pin return shape → reuses existing blocked-pin shape; (4) channel-ACL same symptom → unified failed-post-feedback follow-up.
**Round 4 — codex:** (1) ingress "lacks adapter" contradiction → split per path; (2, MATERIAL) unknown can outrank yes → yes-first ranking; (3) channelId optional vs required → absent→unknown, not all-`no`; (4, MATERIAL) data-exposure overclaim → corrected to exposure-INCREASE + elevated mitigation; (5) terminology → canonical term.
**Round 5 — codex:** (1) security mitigation too deferred → adapter-derived grounding brought in-scope, lease deferred (residual named); (2) fallback machine underspecified per caller → defined (ingress/transfer/rebalancer); (3) freshness too coarse → clear-on-adapter-disconnect; (4) terminology dense → glossary added; (5) capability-attestation pattern → documented as the preferred hardening (short-lived lease).

## Convergence verdict

Converged after 5 cross-model rounds + 2 internal reviewer passes. The external verdict was stable MINOR for the final three rounds (rounds 3–5); the design has been confirmed coherent and the wrong-workspace black-hole closed since round 2. Round-5's findings were a security-SCOPING decision (resolved: adapter-derived grounding in-scope, cryptographic lease deferred with the residual named per design-fork autonomy) plus refinement-level precision (fallback-per-caller, freshness-on-disconnect, glossary) — all addressed; no remaining MATERIAL design finding. `## Open questions` is `*(none)*`. Spec is ready for review and approval.
