# Convergence Report — Locked-Mac proof fixes: helper store root, named password readiness, a PIN without Telegram

**Spec:** [docs/specs/desktop-locked-proof-fixes.md](../desktop-locked-proof-fixes.md)
**Slug:** `desktop-locked-proof-fixes`
**Converged at:** 2026-11-04
**Iterations:** 2
**Final-round design findings:** 0

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier external pass ran through the agent's codex CLI in both rounds (round 2 on the changed body). Gemini was not authed on this machine (`gemini-not-authed`); the Anthropic clean-door reader was not run.

---

## ELI10 Overview

The locked-Mac proof on the Mac Mini found three problems in the still-switched-off locked-screen feature. The Mac helper gave up when a folder above its record folder was missing, and said nothing about why. The status page said "ready" while the password box could not work (the secure tunnel was down, and that build had no kept helper). And an agent with no Telegram could be left with no dashboard PIN at all. The spec makes the helper create the missing folders and name its failure with one fixed word, adds a per-client "could a password be typed once locked, and if not why" answer to status and to the viewer, and gives every agent a PIN, stored in its vault when it has one. Reviewers mostly pushed on cost and side effects: the first draft made every status read run the full grant probe, which could end a grant, and wrote a new PIN in plain text on vault-backed agents. Both changed.

## Original vs Converged

- Status readiness: first draft ran `DirectDesktopAccess.probe()` (spawns the helper, applies modes, can end grants when disabled) on every status read and per peer in a pool read. Converged: a 30-second cached host probe, one shared fresh probe at most, no side effects.
- Viewer updates: first draft re-sent state only on lock change, attach and tunnel transitions, so a helper permission change under an unchanged lock state was never sent. Converged: recompute after every grant probe and tunnel transition, send when changed.
- State-op word: first draft accepted any word matching a pattern. Converged: explicit allowlist of the nine words the helper writes.
- PIN storage: first draft wrote a new PIN to config.json even on vault-backed agents. Converged: vault when present, `{secret:true}` in config, plain-text fallback only if the vault write fails; the migrator uses the same rule and stops logging the PIN; the two file readers resolve the vault reference.
- Problem statement corrected: the migrator and the install wizard already mint PINs; the gap is an `init`-made agent that has not updated.

## Iteration Summary

Standards-Conformance Gate: round 1 ran (1 flag: Mobile-Complete Operator Actions, resolved by naming how a no-Telegram owner gets the PIN); round 2 not re-run (unavailable: not re-invoked after the body change, its single flag was resolved in text).
Internal reviewers ran on the authoring session's model (Opus 5.5): round 1 security+adversarial, integration+scalability+decision-completeness+multi-machine, lessons-aware; round 2 one combined reviewer across all lenses.

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | security, integration, lessons, codex | 5 | 14 | Problem 3, Design 1-3, Decision points, Posture, Frontloaded, Maturation |
| 2 | none | 0 | 6 | Design 2-3 wording, Left behind |

## Full Findings Catalog

Round 1, DESIGN: status probe side effects and cost (security, integration); readiness changes not sent when the lock state is unchanged (codex); plain-text PIN on vault agents (integration); migrator PIN rule and log differ (lessons); sibling stripped test opt-ins `INSTAR_LIVE_HUB_INTENT`, `INSTAR_REAL_WEDGE_CANARY_TESTS` (lessons; a one-line allowlist addition, fixed).
Round 1, PRECISION: allowlist vs pattern; maturation proof preconditions; symlinked parents note; listener removal; older peers lack fields; posture marker wording; PIN policy noted for release notes; problem statement breadth; placeholder string; 256-byte boundary test; thin-build note.
Round 2, PRECISION: vault reference printed by `fix dashboard` and the tunnel credential provider (fixed with `pickDashboardPin`); cached probe after disable (fixed); migrator write ordering (left behind); flicker wording and PIN read path (spec text fixed).

## Proportion

Tier 2 (security-sensitive: the helper that types a password, and the dashboard PIN). About 20 source and test files, roughly 600 lines. 2 review rounds of a cap of 6.

## Left behind

- Status can lag a helper grant change by up to 30 s (the grant path re-checks at `secretType`).
- Migrator vault-then-config write ordering (harmless re-mint).
- Install wizard's `ensureViewingPin` keeps its own string-only rule.
- `fix dashboard` still writes a newly generated PIN in plain text (pre-existing).

## Post-convergence addition

Section 4 (the secure-input owner registry path, the viewer's refusal sentences and server-side refusal logging) was added after round 2 at the coordinator's request, from a live finding on the Mac Mini. It is a one-line native path correction plus logging and copy; it was reviewed by an independent second-pass reviewer rather than a new convergence round.

## Convergence Verdict

Converged at round 2. The final round found nothing that changes what gets built; four items left behind. Spec is ready for approval.
