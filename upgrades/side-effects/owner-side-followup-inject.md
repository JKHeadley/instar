# Side-Effects Review — owner-side follow-up injects, not re-spawns (bug #13)

**Version / slug:** `owner-side-followup-inject`
**Date:** `2026-05-31`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

On the owner machine, the forwarded-message handler (`server.ts` `onAccepted`) now
injects a follow-up into the already-running moved session instead of unconditionally
re-spawning. If a live session exists for the topic it calls `injectTelegramMessage` +
`trackMessageInjection` and returns; otherwise it spawns under a clean
`topic-${topicId}` name (never the prefixed `getSessionForTopic` value). Closes audit
#13 (every follow-up spawned a double-prefixed duplicate session, so the moved
conversation never advanced).

## Decision-point inventory

- **live session for topic?** `existing && sessionManager.isSessionAlive(existing)` →
  inject + return; else → spawn. Both sides covered by the wiring test (the inject
  decision must precede the spawn IIFE).
- **spawn name** — always `topic-${topicId}` (clean). The prefixed `getSessionForTopic`
  value is never reused as a spawn name (that was the double-prefix defect).

## 1. Over-block

**What legitimate inputs does this reject?** None. The single-machine inbound path is
untouched (this is the `onAccepted` forwarded path, gated past `'dark'`). The first
forwarded message for a topic still spawns exactly as before (no live session →
spawn). The only behavior change is that the 2nd+ follow-up now reaches the running
session instead of spawning a duplicate.

## 2. Under-block

**What does this still miss?** The injected follow-up carries the topic name but not
the originating sender's first-name/user-id (the forwarded payload is text-only), so a
multi-user topic's moved session sees a generic sender on follow-ups. Acceptable for
continuity; a richer forwarded payload is a separate, smaller gap. Still NOT
live-verified — the moved session can't run until the mini's Claude is logged in (bug
#12, pending the user).

## 3. Level-of-abstraction fit

**Right layer?** Yes. It mirrors the normal inbound dispatch's alive-session branch
(`injectTelegramMessage`) in the one owner-side place a forwarded message is handled.
No new method; reuses `isSessionAlive` / `injectTelegramMessage` / `trackMessageInjection`.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No blocking authority. It routes a message to a running session or spawns one; it
gates nothing and blocks nothing. The spawn IIFE remains best-effort/fail-safe.

## 5. Interactions

Pairs with bug #2 (the spawn branch still fetches the router's relayed history) and
bug #7/#8/#11 (forward + ownership). The inject branch short-circuits before the bug-#2
fetch (a running session already has its context). Idempotent: each follow-up either
injects into the live session or spawns when there is none.

## 6. External surfaces

None new. Same cross-machine GET (bug #2) only on the spawn branch. No new route,
config, or notification. Visible effect: a moved conversation advances on follow-ups
instead of spawning duplicates.

## 7. Rollback cost

Low. Revert the `onAccepted` branch to the prior unconditional `spawnSessionForTopic`
call. No schema, state, or migration.

## Conclusion

Targeted owner-side dispatch fix; mirrors the proven single-machine alive-session
inject; removes the double-prefix duplicate-spawn; gated past `'dark'` + fail-safe;
single-machine path untouched; cheap revert. Honestly scoped: unit-verified, live
follow-up confirmation pending the mini's Claude login.

## Second-pass review (if required)

Not required — additive owner-side branch mirroring an already-proven pattern,
gated + fail-safe, single-machine path unchanged, reversible, no authority. The live
move-then-follow-up check is the Tier-3 gate after the user's mini login.

## Evidence pointers

- `tests/unit/session-pool-activation-wiring.test.ts` — inject precedes spawn;
  `injectTelegramMessage` + `trackMessageInjection`; spawn name `topic-${topicId}`;
  no prefixed `getSessionForTopic` spawn name.
- 52 session-pool + adapter tests green; `tsc --noEmit` clean.
- Confirmed in code: `registerTopicSession` stores the prefixed tmux name →
  `getSessionForTopic` returns it → `spawnInteractiveSession` re-prefixes →
  `tmuxSessionExists` misses → duplicate spawn per follow-up.
- Spec: `docs/specs/owner-side-followup-inject.md` (+ `.eli16.md`).
