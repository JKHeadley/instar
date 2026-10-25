# Round 5 — Adversarial and lessons-aware review

Inputs: current agent-home `docs/specs/telegram-message-origin.md`, `conformance-round-5.json`, prior adversarial/lessons reports, prior full lessons-catalog and relevant-memory reading, and fresh-main browser/profile/queue/ASP source inspection. The current conformance artifact reports 90 standards checked, zero findings, not degraded, with a passing registry canary. No implementation or runtime change was made.

## ADVERSARIAL perspective

**DESIGN: 0. PRECISION: 0.**

The notice reservation now explicitly has one named process/boot owner and authenticated IPC requesters. Other processes cannot take over on IPC timeout, copy a callable permit, reclaim the special claim, or retry it through an ordinary delivery loop. The owner consumes its permit before asynchronous work and performs one sealed request. Restart invalidation and the inability to guarantee every notice are explicit. Those changes close the potential misimplementation of a supposedly shared in-memory permit without inventing cross-process memory sharing.

Narrow derivation still seals and persists a concrete child before claiming; arbitrary body/destination/display changes remain forbidden. ASP renewal leaves replay/freshness policy unchanged. Operator-account messages require same-message authorship proof, and unsupported forms fail before dispatch. Unknown observations remain truthful and visible in health; positive model controls prevent an unwired resolver passing as healthy. Mirror evidence sinks have no execution authority.

Browser receipt correlation is a required feasibility spike and activation canary, not a claimed existing capability. The real new broker must pass the stated bypass tests before activation. A missing current broker implementation is not a newly discovered defect in a specification explicitly requiring it. Same-UID hostile access remains outside the claim; the review does not interpret profile permissions or a browser lease as proof of such containment.

## LESSONS-AWARE perspective

**DESIGN: 0. PRECISION: 0.**

The carried-forward availability-summary wording is corrected: evidence-sink failure and execution-outbox admission/claim failure are now separately stated. Justin's explicit hold-and-notify choice remains the governing failure policy. The new notification reserve has independent bounded capacity, so it cannot consume ordinary admission slots; incomplete notification coverage is disclosed in health. No unrecorded emergency bypass or recursive Telegram failure notification is introduced.

P19 is engaged by persistent child attempt ceilings, original deadlines, bounded diagnostic supervision and independently bounded notice reservations. P21 is engaged by federation and explicit credential locality. P24 and the prior observation lessons are engaged by complete-population coverage disclosure, bounded reads and positive controls. B22/B24 remain respected by one execution lifecycle and post-dispatch timeout uncertainty. The explicit upstream feasibility spike and version-drift canary address L5's requirement to verify changing external-state adapters. These are specified implementation obligations, not tests claimed already run.

## Result

Total: **0 DESIGN, 0 PRECISION**. This is a second consecutive design-quiet round for these two perspectives after round 4. It does not independently establish overall convergence or completed implementation.
