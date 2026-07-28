# Convergence Report — Operator Authorization Request

## ⚠ Cross-model review: UNAVAILABLE

No supported external (non-Claude) reviewer ran for this convergence. The `cross-model-review.mjs` script is not present in this install (only `write-convergence-tag.mjs` ships in `.claude/skills/spec-converge/scripts/`), and `codex` is not invokable on this machine (`codex not found` on PATH; no `dist/core/crossModelReviewer.js`), despite the 7-day activation history showing codex-cli/gemini-cli flagged active. Reason: `codex-not-on-path / cross-model-script-absent`. Remediation: install `@openai/codex` + `codex login`, or restore the cross-model script. Convergence ran on the six internal Claude reviewers + the (degraded) constitutional gate. The operator reads this before applying `approved: true`: this spec received rigorous internal multi-angle review but no independent non-Claude opinion.

## ELI10 Overview

We're replacing an awful operator screen. Today, to let a person do something privileged (e.g. "let Mia deploy to prod for an hour"), the operator has to hand-build a "mandate" in a raw-JSON form full of jargon. This spec adds a dead-simple alternative: the agent pre-fills the whole request, and the operator just sees one plain sentence with an Approve button and a PIN field. The agent can only *propose*; only the operator's PIN turns a proposal into a real grant — so it's easier for the human without being easier for the agent to gain power. The single load-bearing safety property: the sentence the operator approves is authored by the server from structured facts (action + the person looked up in the real user directory + duration), never from agent free-text, so what you read is exactly what executes.

## Original vs Converged

The original spec had the right shape but three dangerous gaps the review closed:

1. **Deceptive display (CRITICAL).** Originally the operator's card showed agent-authored `title`/`summary` free-text while the server executed a separate structured `proposal` — so an agent could show "let Mia view dashboards" while actually requesting prod-deploy. Converged: the card headline is authored entirely server-side from the structured proposal + the real registry name; the agent's only free-text (`reason`) is quarantined as an escaped, visually-distinct secondary line that can never read as the authority.
2. **`bounds` reopened the same hole.** A later round noticed the agent-supplied `bounds` object could carry an authority-shaping value the server headline omitted. Converged: `bounds` is **removed from v1** entirely — the three structured fields (action, person, duration) fully describe a grant and are each server-rendered.
3. **Carrier-mandate entanglement.** Originally grants could share an auto-created "carrier" mandate, so revoking one grant could silently drop unrelated ones, and durations could be silently clamped. Converged: **one carrier per grant**, carrier expiry == grant expiry == the operator-approved duration, hourly prune to bound the gate's hot-path scan.

Also added in convergence: exclude the meta-action `grant-authority` from what an agent may propose; validate the grantee against the real principal registry (kills phantom/sybil ids and sources the trusted display name) with a fresh re-resolve at approve; re-check the allowlist at approve; per-agent flood caps + dedup + a single aggregated Attention item; honest multi-machine holder labeling (no silently un-approvable cards); concrete numbers for every duration/cap/cooldown; a Foundation Audit honestly recording the inherited (un-worsened) SlackPermissionGate enum-as-authority concern; and full Migration-Parity + Agent-Awareness obligations.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, adversarial, integration, decision-completeness, lessons-aware, scalability | ~17 (1 CRITICAL deceptive-display; HIGH carrier reuse, duration clamp, self-grant, migration, multi-machine; MEDIUM flooding, idempotency, retention; + 7 unresolved decisions) | Full rewrite (v2): server-authored display, one-carrier-per-grant, floor-action allowlist excluding grant-authority, registry validation, multi-machine holder labeling, FD-1..FD-14, Foundation Audit, constitutional standard sharpened as the third operator-surface question |
| 2 | security, adversarial, decision-completeness | 4 material (HIGH bounds-display leakage; MEDIUM allowlist-not-rechecked-at-approve, registry stale/spoof, NEW-4/NEW-5 concrete bindings) | v3: drop `bounds` (FD-15), re-check allowlist at approve, fresh registry re-resolve, concrete principal-registry binding (FD-12) + concrete authorizedBy (FD-9), documented trust assumption, multi-agent flood note |
| 3 | adversarial, decision-completeness | 0 material | none — CONVERGED |

Standards-Conformance Gate: ran (degraded: error; 22 standards checked, 0 findings) each round — recorded honestly; advisory only.

## Full Findings Catalog

Round 1 (material): deceptive-summary [CRITICAL, security+adversarial] → server-authored display. Carrier-mandate reuse cross-grant revocation [HIGH, adversarial] → one-per-grant. Duration silent clamp [HIGH] → expiry==duration. Agent self-grant / non-human grantee [HIGH] → registry resolution + allowlist. Migration Parity + Agent Awareness missing [CRITICAL, lessons+integration] → FD-14. Multi-machine cross-machine hole [CRITICAL, integration] → FD-6 holder labeling. Carrier accumulation on activeGrant hot path [MEDIUM, scalability] → hourly prune. Floor-action subset incl. grant-authority [MATERIAL, decision-completeness] → FD-8 allowlist exclusion. Flooding/dedup/rate-limit [HIGH, adversarial] → FD-13. Idempotency/withdraw race [MEDIUM] → FD-11. Store retention [MEDIUM] → FD-11. Seven unresolved numeric/enum decisions → FD-7..FD-12. Constitutional standard redundancy [MEDIUM, lessons] → reframed as the distinct third operator-surface question. Foundation enum-as-authority [CRITICAL surface, lessons] → Foundation Audit section (inherited, not worsened, separate spec).

Round 2 (material): bounds-display leakage [HIGH] → FD-15 (bounds removed). Allowlist not re-checked at approve [MEDIUM] → approve step 3. Registry display-name spoof/staleness [MEDIUM] → FD-12 trust assumption + fresh re-resolve. NEW-4 concrete registry binding + NEW-5 concrete authorizedBy [MEDIUM, decision-completeness] → FD-12 / FD-9 concretized. Multi-agent flood [MEDIUM] → FD-13 >20 note.

Round 3: zero material findings from both blocking reviewers (adversarial, decision-completeness) → CONVERGED.

## Convergence verdict

Converged at iteration 3. No material findings in the final round; both previously-blocking reviewers returned CONVERGED. All 15 Frontloaded Decisions carry concrete values; `## Open questions` is empty. The single authority-conferring chokepoint is the PIN-gated approve route, routing through the existing signed MandateStore path — no new authority primitive. Safe for the dark-on-dev posture (FD-5). Ready for operator review and approval.
