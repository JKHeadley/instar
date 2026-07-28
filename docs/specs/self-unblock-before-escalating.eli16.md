# Self-Unblock Before Escalating — Plain-English Overview

## What problem is this solving?

When an Instar agent hits a wall — "I need a credential / a permission / a DNS record I don't have" — the lazy move is to stop and ping a human: "I'm blocked." That's a bad habit for two reasons. First, a lot of the time the agent *isn't actually blocked* — the credential it needs is already sitting in a vault it can reach, or there's another resource it already controls that gets the job done. Second, every time the agent kicks a problem to a person, it's spending the most expensive thing in the system: human attention.

This actually happened in the session that motivated this standard. The agent decided it needed a human to set up a DNS record on `feedback.instar.sh`, and idled waiting. But the real goal was already reachable another way (a different domain, using a Cloudflare token that was *already in the vault*). The agent only had the right to call it a genuine "I need a human" blocker *after* it had checked everywhere it could reach — and it hadn't.

## What does the standard say?

One line: **A blocker is the agent's problem to solve first.** Before asking a human for anything, the agent must exhaust every path it can reach on its own — its own secrets, the shared org vault, the cloud accounts it's logged into, its tools, its browser sessions, and any resource it already owns. Only when it has genuinely run out of self-serve options does it turn to a human — and even then, it asks for the *smallest possible thing*, named exactly.

There's a three-rung ladder for "what do I need from a human":
- **Rung 0 — Nothing.** Solve it yourself. This is the goal every time.
- **Rung 1 — Just a yes/no.** A tap-to-approve, no credential, no manual work.
- **Rung 2 — A credential only an authorized person can produce.** The last resort. Collected securely, then *stored* so the agent never has to ask twice.

If the agent escalates above rung 0, it has to say *why* the lower rungs were genuinely impossible, and name exactly what it checked.

## What actually ships?

This is the *mechanical* version of that discipline — not a paragraph in a doc the agent has to remember, but code:
- A **checklist module** that walks every credential surface the agent can reach, in order, and produces the list of what it actually checked.
- That list gets attached to the blocker record (`selfUnblockAttempts`), so "did you really try?" is answerable from data.
- A **warning gate**: if the agent files a blocker as "needs a human" with an *empty* checked-list, it gets flagged. (For now it only warns — it never blocks the escalation — so we can measure how often it happens before adding teeth.)
- An **escalation-message rule**: when a human really is needed, the message names the exact credential/permission and the minimal rung — never just the bare word "blocked."
- An **audit log** of every escalation and what was checked.

## What's the catch / what does it NOT do?

It does **not** let the agent exceed its permissions, touch accounts it wasn't granted, or treat "I could probably find a way" as license for risky, irreversible, or money-spending actions — all the normal safety gates still apply on top. Operator-only credentials stay operator-only; the standard just makes collecting them a one-time event instead of a recurring nag.

It ships **dark** (off by default everywhere except the developing agent's own machine, where it runs in observe-only warn mode). Turning the flag off makes every part of it inert: the read-only status route returns "not enabled," the gate becomes a no-op, and the checklist never runs. Nothing about it is risky to ship, because in its shipped state it only *watches and records* — it never blocks the agent or the human.
