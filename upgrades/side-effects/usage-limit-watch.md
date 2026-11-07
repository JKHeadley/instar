# Side-Effects Review — running out of Claude usage is told and recovers

**Version / slug:** `usage-limit-watch`
**Date:** `2026-11-06`
**Author:** `echo`
**Second-pass reviewer:** independent general-purpose reviewer agent (three rounds, concurred)

## Summary of the change

Tier 1: a revert undoes it, and a leftover state file is inert. About 1,000 lines, most of it the new module and tests. Three independent review rounds found 6 issues, then 3 plus wording, then none. More than the usual one round on Tier 1 because each found a real false claim or silence.

## Decision-point inventory

- Is usage out — add — transcript proof or probe. The banner and a failed call are only signals.
- Is a whole-agent claim true — add — not while any usable account isn't known to be full. Ends on a probe's clean answer or a fresh reading of an account with room, not on a memory expiring.
- Restart a conversation — add — only with held messages, 3 per day per session.
- Standby wording — modify — while proven limited, Tier 1 says so and skips the model call.

## 1. Over-block

A proven limit ends the standby's tiers for that message, as the existing quota branch does. Each new message in a Claude conversation hears the limit line again; it is one line per message, chosen over the risk of recording "told" for a send that was skipped. Conversations on another framework are unaffected.

## 2. Under-block

Jobs still spawn into the limit; the ledger marking them successful is fb-0de855f5-2ac. A session that ended during the limit has its held text unread, so its conversation is asked to resend. A person who never messaged is not told. With the watchdog off, only refused internal calls open an episode. On an agent with 2+ accounts where moves keep failing but some account has room, the operator is not told; the person hears the existing notice and a failed-move report is logged. The probe uses the fast model, so a limit on one model alone (say Opus) reads as back after the first probe: the session restarts and hits it again, the daily cap stops restarts, a one-hour cooldown and a 6-hour notice gap stop the flapping, and the standby's banner path still tells the person. A wording change in Claude's limit text would stop the probe seeing it (it reads as no verdict): the watch would never open from a call, though a session's transcript row still opens it.

## 3. Level-of-abstraction fit

Separate from `ClaudeKeyHealth` because it must also work with no key and has a different state machine, sharing its conversation reads, prompt builder and operator routes. Separate from `UsageWallRescue`, which it defers to.

## 4. Signal vs authority compliance

The banner and a failed call are signals. The provider's transcript row or probe is the authority, and a fresh account reading can end the episode. Nothing here blocks anything; it tells people and restarts through the existing session refresh and its work gate.

## 5. Interactions

The standby stays the one voice to a person. `ClaudeKeyHealth` stays quiet on a limit (pinned by test). The rescue's own "no room" notice is Telegram-only and may precede this. A session that moved on by itself at the reset no longer shows the limit, so it isn't restarted. A refused restart stays listed and retries, capped. A dead key and a limit can't both be proven at once, since a 401 comes first.

## 6. External surfaces

New `claudeUsage` on authenticated `GET /health`. New operator and person messages. One small probe call while limited, at most every 30 minutes at steady state, and one that costs little when it succeeds. New state file `state/usage-limit-watch.json`, names and times only.

## 7. Multi-machine posture

Machine-local by design: usage and the login are per machine and sessions run where they run. Two machines on one exhausted account would each tell the operator once; acceptable, and each names its own truth. Restarts apply only to this machine's sessions.

## 8. Rollback cost

Revert and release. A leftover state file is ignored. The CLAUDE.md bullet stays on updated agents until removed and would then be stale; a one-line migration would remove it.

## Class-Closure Declaration

`unbounded-self-action` — closure: guard, enforcement: ratchet, citation: `tests/unit/self-action-convergence.test.ts`. Registered as `usage-limit-session-refresh`: 3 restart attempts per session per rolling day, persisted across restarts. Notices are bounded by a 1-hour reopen cooldown and a 6-hour operator notice gap.

## Second-pass review

Round 1: concern raised, 6 issues (false limit claim on multi-account agents, notice loop, recovery killing a working session, standby repeats, rescue failure reading as room, boot gap). Round 2: 3 more (a skipped send recorded as told, an expiring memory reading as usage back, false claim to Codex conversations) plus wording. All fixed. Round 3: concur.
