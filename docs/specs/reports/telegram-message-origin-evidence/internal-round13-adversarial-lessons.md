# Round 13 — adversarial and lessons-aware review

Reviewed body `0cf9f5ebddf6917de2e748ea4a78081958572c3f96c518275fb0f2b9a1643c4a`, including the new restart-during-outage acceptance contract and operator-decision scope. Both perspectives are from this same reviewer; this is a fresh targeted pass, not a second independent reviewer.

## ADVERSARIAL

**DESIGN: 0. PRECISION: 0.**

Targeted restart sequence: healthy reservation, possible outage consumption, owner death, production restart while origin worker remains unavailable. Acceptance 18 now explicitly forbids rehydrating a prior permit, sending through ordinary preparation/IPC/egress escapes, replaying uncertain acceptance, or reporting a fabricated successful notification. Recovery requires a newly recorded generation. This aligns with the existing no-reclaim special claim and single named incarnation; it does not invent transferable in-memory authority.

Rechecked the unchanged sealed-child/variant boundary and independently refreshed policy projection against that sequence. Neither an existing record nor an old policy snapshot authorizes a restarted process. Unresolved policy still suppresses, and uncertainty still cannot mint a replacement message/random ID. No additional defect found.

## LESSONS-AWARE

**DESIGN: 0. PRECISION: 0.**

The restart test now carries the actual-state lesson through the production factory: unavailable recording and notification remain visible even when held-work history cannot be read; unavailable counts must not become zero. P22 recovery-before-escalation, P19 durable latch/brakes and P23 coalesced hub routing remain intact. Expanded lessons frontmatter now reflects those substantive contracts. The scoped Open questions heading does not claim activation proof is complete.

Conformance round 13 checked 90 standards, zero findings, not degraded. No runtime/source edits or external sends. Combined findings: **0 DESIGN, 0 PRECISION**. Independent external findings keep their original classifications; this internal pass alone does not establish aggregate convergence.
