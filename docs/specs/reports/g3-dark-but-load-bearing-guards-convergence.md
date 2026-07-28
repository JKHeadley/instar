# Convergence Report — G3: Dark-but-Load-Bearing Guard Classification

## Cross-model review: RAN (codex-cli:gpt-5.5)

Every round received a real external opinion from codex GPT-5.5 (outside the Claude family).
R1 surfaced a parse-format wrinkle (tolerated); R2–R6 returned MINOR. One genuine outside
opinion per round — the spec did not converge blind.

## Summary

G3 gives the ratified standard **"A Dark Feature Guards Nothing"** a structural arm at the
guard-posture layer: a guard declared `loadBearing` in the manifest, sitting in a
silently-unguarded posture, is classified into `loadBearingGap` (loud), `loadBearingSoaking`
(graduate arm, lapses to Gap), or `loadBearingAccepted` (owned operator acceptance). The
converged design is pure/observe-only, PIN-gated on acceptance, and lands its alert on a
separate EPISODE TRACK so a long-lived gap can never mask an acute load-shed.

**CONVERGED after 6 rounds.** Each round surfaced genuine material design holes — the
reviewers (internal six + codex external + the Standards-Conformance Gate) did high-value,
code-grounded work; no round was a rubber stamp.

## Iteration summary

| Round | Standards-Conformance Gate | Material findings | Outcome |
|-------|----------------------------|-------------------|---------|
| 1 | ran | 2 (accepted-fallback mechanism missing; "Open questions: None" inaccurate) | folded → v2 |
| 2 | ran | 5 (soak mis-filed as accept w/ no expiry; deriveGuardRow purity; on-dry-run trigger ambiguity; seed storage + DELETE; pending-Gap masks a later load-shed) | folded → v3 (three-state model) |
| 3 | ran | 3 (masking re-emit INERT vs the create-if-absent funnel; allowlist six-not-five; §2.6 relocated I/O into the also-pure buildGuardInventory) + owner-provenance + date-lint | folded → v4 |
| 4 | ran | 2 (masking fix's stated MECHANISM wrong — it's a separate EPISODE TRACK, not a health key, inert for these non-lane items; §2.6 named 2 of 3 inventory-build sites) + BNS "one-hub" correction | folded → v5 |
| 5 | ran | adversarial CONVERGED, lessons-aware CONVERGED, codex MINOR; decision-completeness [1 material: stale §6/§3 summary text still named the superseded health-key mechanism — pure doc-coherence, no design change] | folded → v6 |
| 6 | ran | decision-completeness CONVERGED (v6 summaries now match the episode-track design body) | **CONVERGED** |

## Findings resolved, by round

**Round 1** — implemented BOTH standard arms: added the durable per-machine operator
accepted-fallback store (`state/guard-accepted-fallbacks.json`) + the PIN-gated
`POST/DELETE /guards/:key/accept-fallback` route; wired the `load-bearing-gap` anomaly into
both probe paths; attached `criticalPath` to all anomalies; added the Agent-Awareness
template update.

**Round 2** — replaced the round-1 "soak = seeded accept" with a genuine three-state model:
`loadBearingGap` / `loadBearingSoaking` (graduate arm, bounded manifest window, lapses to Gap)
/ `loadBearingAccepted`. Kept `deriveGuardRow` pure by threading the accept map via
`DeriveInput`. Bounded soak = manifest constant; DELETE scoped to operator records.

**Round 3** (adversarial deep-grounding) — three material: the round-2 episode "re-emit under
the same healthKey" was mechanically inert against the create-if-absent funnel; the allowlist
six-not-five miscount would strip `acceptedFallbackReason`; §2.6 relocated the file read into
`buildGuardInventory`, which is also contracted pure. Plus `owner` made a required accept-route
field and a `declaredLoadBearingAt` manifest lint. Folded → v4.

**Round 4** — codex MINOR; all three internal reviewers converged on two material corrections
(adversarial + lessons-aware independently found the first, decision-completeness the second):
- The round-3 masking fix had the right END STATE ("separate from the generic episode" + a
  real-funnel regression test) but the WRONG MECHANISM. Code-grounding showed guard-posture
  items carry no `lane:'agent-health'`, so `healthKey` is INERT for them (read only inside
  `routeToAgentHealthLane`); the actual masking is the probe's SINGLE shared episode state
  (`openEpisodeId`/`episodeEmitted`). **Fixed:** re-anchored §2.3/§2.5/Decision 10 on a separate
  EPISODE TRACK (own episode id + `guard-posture-loadbearing:ep-N` item-id namespace); dropped
  the inert health-key/lane claim; renamed the test + added an inert-lever guard test. Also
  corrected the "one-hub / no new topic" claim — guard-posture items are HIGH→per-episode forum
  topics, so it is two bounded class-level topics (BNS-consistent, not per-guard), deliberately
  not the calm agent-health hub (which would downgrade a load-shed's visibility).
- §2.6 named only 2 of the 3 `buildGuardInventory` call sites; the omitted heartbeat
  `selfGuardPosture` compute produces the peer-facing key-lists, so missing it would ship a
  locally-accepted guard to peers as a false pool-level Gap. **Fixed:** §2.6 + Decision 9
  enumerate all three sites by the objective criterion; a heartbeat-classification test added.

**Round 5** — adversarial + lessons-aware both CONVERGED, verifying every round-4 correction
mechanically against the real code (the single-episode masking gate; `healthKey` genuinely
inert for these non-lane items; the two-track close-condition coupling `currentAcute.length===0`
locked by the named tests; the three inventory-build call sites exact; the BNS two-topic framing
accurate and standard-consistent). Codex MINOR. Decision-completeness found one material — a
DOC-COHERENCE artifact: §6 and §3 still described the notification mechanism as the superseded
"separate health key" while the design body had been re-anchored on the episode track, so a
builder reading the summaries could build the exact health-key-only version the inert-lever
regression test is written to fail. **Fixed (v6):** §3, §6, and Decision 8 re-worded to name the
separate EPISODE TRACK; "health key" now appears only as the explicitly-inert non-mechanism
(grep-verified: the old `GUARD_POSTURE_LOADBEARING_HEALTH_KEY` constant reference is gone).

**Round 6** — targeted decision-completeness confirmation: §3/§6/Decision 8 now describe the
same episode-track mechanism as the design body, no residual contradiction, no new mid-build
stop-point, "Open questions: None" honest. **CONVERGED — no material issues.**

## Convergence verdict

**CONVERGED at round 6.** Both criteria satisfied: (1) the confirming round (6) produced no
material new issues — all three internal reviewers and the codex external are clean, and the
sole round-5 material (a stale-summary doc-coherence artifact, no design change) was folded and
confirmed aligned; (2) zero unresolved `## Open questions` (the spec states "None", enforced
structurally by `write-convergence-tag.mjs`). Operator preapproval for this project's spec
approvals is on record (topic 29836), so `approved: true` is written with the convergence tag.
