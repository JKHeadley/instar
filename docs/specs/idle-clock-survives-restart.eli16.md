# Idle Clock Survives Restart — Plain-English Overview

> The one-line version: an agent now remembers how long a conversation has been sitting idle even after its server restarts, so idle conversations actually get closed instead of piling up until the agent can no longer answer anyone.

## The problem in one breath

Every Instar agent closes a conversation that has sat untouched at its prompt for four hours. But the four-hour stopwatch only lived in the server's memory. Each time the server restarted — and it restarts roughly every half hour to pick up updates — the stopwatch went back to zero for every conversation. So the four hours never elapsed, no conversation was ever closed, and they piled up until the agent hit its limit of twenty open conversations. At that point it refused every new conversation outright.

This is not theoretical. On 2026-10-22 the sagemind agent (Luna) on the laptop was at twenty of twenty. Seventeen of those conversations had been idle for between 17 and 64 hours. The server had restarted three times that day. A request to open one more conversation was refused with "Max sessions (20) reached", and the operator experienced it as "Luna is not responding".

## What already exists

- **The idle stopwatch** — the server notices when a conversation is sitting at its prompt with nothing running, starts a stopwatch, and asks for the conversation to be closed once the stopwatch passes the threshold (four hours for a conversation tied to a live chat topic, fifteen minutes otherwise).
- **The closing authority** — the request to close goes through the same single gatekeeper every other close uses. That gatekeeper can refuse (a user just wrote in that topic, an open commitment, a protected session) and backs off instead of nagging every few seconds. None of that changes here.
- **The transcript on disk** — the conversation's own log file, which grows every time the conversation does anything. It is already used as ground truth that a conversation is alive and working.
- **The session record on disk** — every conversation already has a small saved record (when it started, what it is for, which account it runs on).

## What this adds

The moment the server first sees a conversation go idle, it now writes that instant into the conversation's saved record. After a restart, when the server next sees that conversation idle, it reads the saved instant back and continues the stopwatch from there instead of starting at zero.

- The saved instant is cleared the moment the conversation is seen doing anything, so a stale value cannot linger.
- Before trusting a saved instant, the server checks the conversation's log file. If the log was written after the saved instant, the conversation did work in between, the saved value is thrown away, and the stopwatch starts fresh — exactly what happened before this change.
- A missing, unreadable, or future-dated saved instant also means "start fresh".

## The new pieces

- **A small decision function** (`resolveIdleSinceSeed`) — given the saved instant, the log file's last-modified time, and the current time, it answers one question: may the stopwatch resume from the saved instant, or must it start now? It never does anything itself; it only decides. Every doubtful case answers "start now".
- **One new field on the session record** (`idleSince`) — the saved instant. Older servers ignore it; older records simply do not have it.

## The safeguards

**Prevents a conversation from being closed while it is working.** A resumed stopwatch can only ever bring a closing request forward in time; it never bypasses the gatekeeper, and the gatekeeper still checks for live work, recent user messages and open commitments exactly as before. On top of that, the log-file check refuses to resume a stopwatch over any period in which the conversation actually did something.

**Prevents a bad saved value from doing harm.** Garbage, a value in the future, or a value contradicted by the log file all fall back to today's behaviour. The worst case of a wrong saved value is the status quo, never an earlier close.

**Prevents the saved value from going stale.** It is removed every time the conversation is seen active, every time a user message arrives, and every time one of the existing recovery nudges resets the stopwatch.

**Does not add any new way to fire closes.** The number of close requests per conversation is unchanged: at most one per check, backed off after a refusal, one escalation after repeated refusals. Only the stopwatch's starting point changed.

## What ships when

One change, one release: the field, the decision function, the wiring in the session monitor, and the tests. No migration is needed — records without the field behave exactly as they do today, and the first idle observation after the update writes it.

## What you actually need to decide

Nothing. This is a bug fix that restores the behaviour the four-hour threshold was always meant to have; it is reviewed and tested, and it rolls out with the next release.
