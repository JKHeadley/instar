# Agent improvement capture and capacity repair

<!-- bump: patch -->

## What Changed

User corrections encountered while immediate class-review work is load-shed now enter a bounded, scrubbed capture backlog. A periodic prune removes expired entries even when the LLM circuit is open. Class review counts distinct open linked Actions and Initiatives against the work cap, admits work into remaining slots, and sends a coalesced Attention item when the cap is full. The production server now wires that attention route to Telegram.

## What to Tell Your User

Instar is less likely to lose a correction just because review is busy. It keeps a bounded, scrubbed record for later review and alerts the agent when the review queue is full. This repairs the existing capture path; the broader automatic local and shared improvement pipeline is still being designed separately.

## Summary of New Capabilities

- Bounded correction capture during review load shedding, with expiry pruning.
- Review capacity based on actual open work and a coalesced full-cap alert.

## Evidence

The exact repair commit passed the full suite on the M5: 52,476 unit, 4,911 integration, and 3,583 end-to-end tests with zero failures. The production-path correction backlog lifecycle test passed all three cases. TypeScript build, lint, and focused route and wiring tests passed. An independent review identified alert and expiry edge cases, which were fixed before this final run.
