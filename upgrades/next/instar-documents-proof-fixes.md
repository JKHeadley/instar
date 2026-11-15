## What Changed
Fixes for Instar Documents found by driving the real document page as a user on two machines (still switched off for the fleet; development agents only). A member's linked computer can now press Send. Comments show where they came from ("from Mia's computer"). When a document's conversation is deleted, Send is turned off and says why. Comments a computer wrote before it was forgotten, or before its person was removed, now stay on every machine instead of disappearing from some. A test-only switch (`documents.loopbackOrigin`) lets a development agent with no tunnel hand out links the iOS simulator can open.

## What to Tell Your User
Nothing changes yet unless you run a development agent: commentable documents are still switched off for everyone else.

## Summary of New Capabilities
- Development agents: a live user-role proof runner for documents (`scripts/documents-live-proof.ts`) and a seeded loopback development agent for the iOS simulator (`scripts/documents-dev-agent.ts`).

## Evidence
- `tests/e2e/documents-link-boundaries.test.ts` (a member computer can Send; a removed primary disables and refuses Send; a forgotten computer's earlier rows still verify, a later row does not).
- `tests/unit/documents-origin.test.ts`, `documents-service.test.ts`, `documents-page-model.test.ts`, `tests/e2e/documents-alive.test.ts` (loopback link origin).
- Live proof: PASS 29, FAIL 0, BLOCKED 5 at 390×844 and 1280×728.
