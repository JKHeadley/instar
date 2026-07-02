# Convergence Report — G3: Dark-but-Load-Bearing Guard Classification

## Cross-model review: RAN (codex-cli:gpt-5.5)

Every round received a real external opinion from codex GPT-5.5 (outside the Claude family).
R1 surfaced a parse-format wrinkle (tolerated); R2–R4 returned MINOR. One genuine outside
opinion per round — the spec did not converge blind.

## Summary

G3 gives the ratified standard **"A Dark Feature Guards Nothing"** a structural arm at the
guard-posture layer: a guard declared `loadBearing` in the manifest, sitting in a
silently-unguarded posture, is classified into `loadBearingGap` (loud), `loadBearingSoaking`
(graduate arm, lapses to Gap), or `loadBearingAccepted` (owned operator acceptance). The
converged design is pure/observe-only, PIN-gated on acceptance, and lands its alert on a
dedicated health key so it can never mask an acute load-shed.

Converged after **4 rounds**. Each round surfaced genuine material design holes; the
reviewers (internal six + codex external + the Standards-Conformance Gate) did high-value
work — no round was a rubber stamp.

## Iteration summary

| Round | Standards-Conformance Gate | Material findings | Outcome |
|-------|----------------------------|-------------------|---------|
| 1 | ran | 2 (accepted-fallback mechanism missing; "Open questions: None" inaccurate) | folded → v2 |
| 2 | ran | 5 (soak mis-filed as accept w/ no expiry; deriveGuardRow purity; on-dry-run trigger ambiguity; seed storage + DELETE; pending-Gap masks a later load-shed) | folded → v3 (three-state model) |
| 3 | ran | 3 (masking re-emit INERT vs the create-if-absent funnel; allowlist six-not-five; §2.6 relocated I/O into the also-pure buildGuardInventory) + owner-provenance + date-lint | folded → v4 |
| 4 | ran | 2 (masking fix's stated MECHANISM wrong — it's a separate EPISODE TRACK, not a health key, which is inert for these non-lane items; + §2.6 named 2 of 3 inventory-build sites) + BNS "one-hub" correction | folded → v5 |
| 5 | ran | adversarial CONVERGED, lessons-aware CONVERGED, codex MINOR; decision-completeness [1 material: stale §6/§3 summary text still named the superseded health-key mechanism — pure doc-coherence, no design change] | folded → v6 |
| 6 | ran | decision-completeness confirmation of the v6 summary alignment | — |

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

**Round 3** (adversarial deep-grounding against the real funnel) — three material:
- The round-2 episode "re-emit under the same healthKey" was **mechanically inert**:
  `createAttentionItem` is create-if-absent by id and the agent-health lane suppresses a
  same-key re-escalation for ~30 min, so a long-lived Gap episode would still MASK a fresh
  acute load-shed. **Fixed:** `load-bearing-gap` rides its OWN
  `GUARD_POSTURE_LOADBEARING_HEALTH_KEY`, separate from the generic guard-posture episode;
  soaking pushes no attention item; the §5 masking test drives the REAL funnel.
- Allowlist **six-not-five** miscount would strip `acceptedFallbackReason`, hollowing the
  accepted-risk row. **Fixed:** all six fields enumerated; test asserts six.
- §2.6 relocated the file read into `buildGuardInventory`, which is **also** contracted pure.
  **Fixed:** the caller (`getLocalPosture`) reads the accept file once and threads the map +
  `now` via `opts`/`DeriveInput`; both functions stay pure.
- Plus: `owner` made a REQUIRED accept-route body field (the PIN proves a holder, not a named
  operator); `declaredLoadBearingAt` manifest lint with absent/invalid → Gap (safe/loud).

**Round 5** — adversarial + lessons-aware both CONVERGED, verifying every round-4 correction
mechanically against the real code (the single-episode masking gate; `healthKey` genuinely
inert for these non-lane items; the two-track close-condition coupling locked by the named
tests; the three inventory-build call sites exact; the BNS two-topic framing accurate and
standard-consistent). Codex external MINOR. Decision-completeness found one material — a
DOC-COHERENCE artifact: §6 and §3 still described the notification mechanism as the
superseded "separate health key" while the design body (§2.3/§2.5/Decision 10) had been
re-anchored on the episode track, so a builder reading the summaries could build the exact
health-key-only version the inert-lever regression test is written to fail. **Fixed (v6):**
§3, §6, and Decision 8 re-worded to name the separate EPISODE TRACK (two bounded per-episode
topics); "health key" now appears only as the explicitly-inert non-mechanism. No design
change (grep-verified: the old `GUARD_POSTURE_LOADBEARING_HEALTH_KEY` constant reference is
gone; all remaining health-key mentions are "inert/superseded").

**Round 6** — targeted decision-completeness confirmation that the v6 summary sections now
match the episode-track design body. _(finalized at round-6 close.)_

**Round 4** — codex external MINOR. All three internal reviewers converged on two genuine
material corrections (adversarial + lessons-aware independently found the first; decision-
completeness found the second):
- The round-3 masking fix had the right END STATE ("separate from the generic episode" + a
  real-funnel regression test) but described the WRONG MECHANISM. Code-grounding showed
  guard-posture items carry no `lane:'agent-health'`, so `healthKey` is INERT for them (it is
  only read inside `routeToAgentHealthLane`); the actual masking is the probe's SINGLE shared
  episode state (`openEpisodeId`/`episodeEmitted`). **Fixed:** re-anchored §2.3/§2.5/Decision 10
  on a separate EPISODE TRACK (own episode id + `guard-posture-loadbearing:ep-N` item-id
  namespace); dropped the inert health-key/lane claim; renamed the test and added an
  inert-lever guard test. Also corrected the "one-hub / no new topic" claim — guard-posture
  items are HIGH→per-episode forum topics, so it is two bounded class-level topics
  (BNS-consistent, not per-guard), deliberately not the calm agent-health hub (which would
  downgrade a load-shed's visibility).
- §2.6 named only 2 of the 3 `buildGuardInventory` call sites; the omitted heartbeat
  `selfGuardPosture` compute produces the peer-facing key-lists, so missing it would ship a
  locally-accepted guard to peers as a false pool-level Gap. **Fixed:** §2.6 + Decision 9 now
  enumerate all three sites by the objective criterion; a heartbeat-classification test added.

Everything else verified converged against the code: allowlist six fields, both classifier
functions genuinely pure, `owner`-required PIN-gated accept, soaking lapses to the loud Gap
(Close the Loop preserved), "Open questions: None" honest.

## Convergence verdict

_(finalized at round-5 close.)_ Round 4 surfaced material corrections (all folded into v5);
a round-5 confirmation is required. Both criteria to satisfy: (1) no material new issues in
the confirming round; (2) zero unresolved `## Open questions` (the spec states "None", and
`write-convergence-tag.mjs` enforces this structurally).
