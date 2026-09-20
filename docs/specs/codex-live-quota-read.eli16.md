# Live Codex quota readings at zero cost — Plain-English Overview

> The one-line version: instead of reading yesterday's usage number out of a log file, we now ask Codex directly for today's — using a built-in call that costs no tokens and no quota at all.

## The problem in one breath

Codex usage numbers on the Subscriptions dashboard were only ever as fresh as the last time something actually ran on an account. An idle account sat on a days-old number. Worse, an account that had hit its weekly wall produced NO number at all — nothing runs on a walled account, so nothing gets written to the log we read. The operator asked for a minimum-quota-spending way to keep readings current. This is a zero-spending way.

## What already exists

- **The rollout reader** — reads the usage records the Codex tool writes into its local session log after each turn. Just fixed (the session-close record bug), but structurally limited: no turns, no records.
- **The quota poller** — every 15 minutes, reads each enrolled account's usage and stores it for the dashboard and for the logic that decides which account new work lands on.
- **The usage endpoint** — the HTTP route that answers "where does Codex usage sit?" for the agent, reading the same log.

## What this adds

The Codex tool has a built-in service mode, and that service exposes the exact call its own status screen uses: ask it for the account's rate limits, and it fetches them live from OpenAI. It is a metadata request — no model runs, no tokens are spent, no quota is consumed. Measured on all five real accounts: about half a second to a second each, every one answering with a current, authoritative number — including the walled account that the log-reading path could never see.

The poller and the usage endpoint now try this live call FIRST and fall back to the log only when the live call cannot answer (tool missing, timeout, any error). So the worst case is exactly the behaviour we had yesterday, and the normal case is a fresh, true number on every poll.

## The new pieces

- **The live reader** — starts the Codex service for the account being asked about, asks the one question, and shuts it down. It can only ever report what OpenAI answered; it cannot invent, estimate, or adjust a number, and it ignores an answer that belongs to a different product's allowance.
- **The provenance tag** — every stored reading now says which path produced it (live or log), so a stale log reading can never masquerade as a live one.
- **One wiring rule** — the real live reader is plugged in at exactly one place in the server's setup. Everywhere else — every test, every component built on its own — gets nothing unless it is handed something explicitly, so no test can ever accidentally start the real Codex tool or touch the network.

## The safeguards

**Failure can only make things older, never wrong.** Every failure shape of the live call — the tool missing, a hang, a protocol change, garbage output — produces "no answer", which sends the caller to the log exactly as before. There is no failure that produces a wrong number.

**No new authority.** The parts of Instar that decide where work lands, when to shed load, and when to swap accounts are untouched. They read the same fields as before; the fields are just fresher and more often present. Fresher truth makes them steer work AWAY from full accounts earlier, which is the safe direction.

**A rollback lever, not a rollback release.** One config switch forces the old log-only behaviour, per agent, no code change.

**Existing agents learn about it.** The awareness text agents read at session start is updated for new installs and appended for already-deployed agents through the normal update path — an append-only note, nothing overwritten.

## What ships when

All of it in one change, on top of the session-close record fix: the live reader, the poller and endpoint wiring, the provenance tag, the config lever, and the awareness note. Nothing is dark — the fallback IS the safety, so shipping it off would just be shipping the bug we're fixing.

## What you actually need to decide

Nothing — the operator asked for exactly this ("a minimum quota spending solution for keeping the readings up to date"), and zero is the minimum. The only judgment call embedded here is live-first-with-log-fallback rather than a dark flag, on the grounds that every failure path lands on yesterday's exact behaviour.
