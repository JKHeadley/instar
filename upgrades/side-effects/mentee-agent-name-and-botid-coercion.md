# Side-Effects Review — menteeAgentName + botId coercion + senderBotId fix

**Spec:** `docs/specs/MENTOR-LIVE-READINESS-SPEC.md` §Recipient side. Final
fixes closing the live round-trip (the reply leg landed in #469; these are the
three remaining wiring bugs found by running it end-to-end).

**Change:** `src/scheduler/MentorOnboardingRunner.ts` (+1 optional config
field) + `src/server/AgentServer.ts` (menteeAgentName usage at 3 derivation
sites, botId String-coercion at 3 allowlist sites, senderBotId=sender's-own
via new `ownPrimaryBotId()` helper) + extended E2E test.

## What changed
1. `MentorConfig.menteeAgentName?: string` — the mentee's real registry name.
   Used in `deliverToMentee`, `installMentorMessageHook` (mentor side), and
   `installMentorReceiverHook`, each falling back to `instar-${menteeFramework}`.
2. botId `String()`-coercion at every knownAgents construction (mentor side,
   mentee side, receiver hook) — config may store a JSON number; the marker
   senderBotId is always a string; the allowlist uses `===`.
3. `deliverA2aMessage` now takes `fromBotId` (sender's own bot id) and sends
   it as the inbox `senderBotId`. `ownPrimaryBotId()` derives this agent's bot
   id from its messaging config token. Replies pass `ownPrimaryBotId()`; sends
   pass the mentor bot id.

## The seven questions
1. **Over-block.** N/A — these LOOSEN an over-strict (buggy) comparison that
   was dropping legitimate replies. Coercion only makes a number match its
   string form; it does not widen the allowlist to new agents.
2. **Under-block.** The allowlist still requires an exact (coerced) botId
   match + known agent name. Spoof defense intact — a wrong botId still drops.
3. **Level-of-abstraction fit.** Small, local fixes at the exact sites; one
   tiny helper (`ownPrimaryBotId`). No new infrastructure.
4. **Signal vs authority.** Unchanged — allowlist still decides route/drop.
5. **Interactions.** `menteeAgentName` defaults preserve back-compat for any
   agent whose registry name already equals `instar-<framework>`. Coercion is
   idempotent on already-string values.
6. **External surfaces.** One new optional config key (`mentor.menteeAgentName`).
   No new routes.
7. **Rollback cost.** Trivial — revert restores framework-derived names + the
   number/string comparison (re-introducing the silent reply drop).

## Testing
Extended `mentor-reply-via-inbox` E2E (now 2 cases): the original
(framework-derived name, string botId) + the new regression (menteeAgentName
override, numeric-configured botId, string senderBotId) — both route + persist.
All prior mentor/mentee/inbox tests green. tsc clean.

**Live verification (test-as-self):** the worktree build was shadow-deployed to
the live Echo + Codey pair; a real mentor prompt round-tripped — Codey spawned
a mentee session, replied via /a2a/inbox, and Echo persisted the reply to
mentor-replies.jsonl (corr=FULL-…, from=instar-codey, transport=a2a-inbox-local).

## Migration parity
`mentor.menteeAgentName` is optional with a back-compat default — no migration
needed. The botId coercion + senderBotId fix are pure code (no config/state
change). No PostUpdateMigrator change.
