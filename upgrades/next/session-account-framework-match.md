# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

A session is no longer started under an account of the wrong framework. If a caller (an account swap, a sign-in refresh or a stale-login refresh) passes an account or config home that belongs to another framework, the spawn drops it, logs why, and picks an account for the session's own framework. Before, a Codex session could be started tagged with a Claude account and sit at the Codex sign-in menu, as happened to the Windows App topic on 28 November.

POST /subscription-pool/swap now uses the framework of the live session, not of the account it is leaving. It also accepts an optional targetAccountId, to move one session onto one exact account. That target must belong to the session's framework, be active and have fresh room. A target of another framework is refused with 409 target-framework-mismatch, and an unknown one with 404. Unlike a quota swap, this repair works even when the account being left is not at its limit, which is the case for a stale or wrong account.

## What to Tell Your User

If one of your conversations comes back on the wrong kind of account, I can now move it onto the exact account it should use, with no sign-in. And a conversation set to Codex can no longer be started on a Claude login by mistake.

## Summary of New Capabilities

- POST /subscription-pool/swap accepts `targetAccountId`, an exact operator repair onto one account of the session's framework.
- Spawns drop a caller-supplied account of another framework and re-select placement.

## Evidence

Reproduced on Mama on 2026-11-28 at 03:58 PT. Session 424f268f on topic 144319 ran codex-cli tagged justin-gmail (claude-code) with no config home, and showed the Codex sign-in menu while codex-sagemindai was active. New tests: tests/unit/account-framework-match.test.ts covers the pure check in both directions, the unknown cases, and the scheduler repair from that exact stale source, along with its refusals. tests/unit/interactive-session-pin.test.ts drives the real spawn with a Claude account for a Codex session (dropped, and the Codex account used), the reverse, and a matching account (kept). tests/integration/subscription-pool-swap-target.test.ts covers the route moving that session onto codex-sagemindai, the framework-following pick without a target, and the 409, 404 and 400 refusals.
