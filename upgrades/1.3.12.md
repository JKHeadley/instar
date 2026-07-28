# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Third increment of the **Feedback Factory Migration** (Dawn → Echo; spec `docs/specs/feedback-factory-migration.md`, approved). Ports the **lifecycle state machine** — `can_transition` + `detect_cycling` and their state/transition/gate constants — from the reference Python (`the-portal/.claude/scripts/feedback-processor.py`) to TypeScript at `src/feedback-factory/processor/transitions.ts`.

This is the heart of the evidence gate: the rules for how a bug cluster legally moves between lifecycle states (new → investigating → research_complete → fix_applied → dispatched → verified → closed, plus chronic/escalated/deferred/wontfix/duplicate), the requirement that any terminal transition (wontfix/closed/chronic_escalated) carry a ≥20-character justification, the atomic dispatch hard-gate, and the chronic circuit-breaker that blocks `chronic` once a bug has recurred 3+ times (forcing human escalation instead). Plus the cycling detector. Pure functions; **not wired into any route or job yet** — no behavioral change.

## What to Tell Your User

- More of the feedback "brain" moved in-house — this is the part that enforces "you can't quietly mark a bug closed without writing down why," and the circuit-breaker that escalates a bug to a human once it keeps coming back.
- Same discipline: I proved my rewrite makes the exact same allow/deny decisions as Dawn's original — and even produces the exact same explanation text — across 33 cases.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Lifecycle state machine (TS port) | Internal module `src/feedback-factory/processor/transitions.ts` — not yet wired |
| Transitions parity harness | `node scripts/feedback-factory/transitions-parity.mjs` (local; set `PORTAL_PROCESSOR`) |

## Evidence

- **Parity vs the real reference Python:** ran `can_transition` + `detect_cycling` from the reference processor and the TS port over 33 cases (legal/illegal transitions, terminal states, the evidence gate on both sides of 20 chars, the dispatch hard-gate, the chronic circuit-breaker at recurrence 2 vs 3, cycling). Result: **33/33 match** — both the allow/deny decision AND the exact reason text (the reasons interpolate Python's sorted-list formatting, which the port reproduces byte-for-byte), plus all cycling results.
- **CI anchors:** unit tests assert the evidence gate, the circuit-breaker, terminal-state handling, and that every transition target is a known state — so a state-machine regression fails in CI even without the reference checkout.
