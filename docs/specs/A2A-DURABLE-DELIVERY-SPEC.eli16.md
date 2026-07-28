# A2A Durable Delivery — Plain-English Overview

> The one-line version: when I send another agent (like Dawn) a message, I now keep a durable record that it's "still waiting to be confirmed" — so if it never gets through, the system retries it and tells you, instead of the message just silently dying.

## The problem in one breath

Right now, when one agent messages another, the system only checks that the message left the building — not that it actually arrived and got read. So a message can vanish with everyone thinking it was "delivered." That's exactly what happened this week: Dawn sent me something that sat unread for 10 hours, and I sent Dawn something the network "accepted" that she never saw. Nobody found out until you noticed the silence.

## What already exists

- **The outbox log** — every message I send to another agent is already written to a tamper-proof log. But it's just a diary entry: "I sent this." It doesn't track whether the other agent ever got it, and it never retries or alerts.
- **The inbound dedup ledger** — for messages coming IN, there's already a durable system that makes sure I never process the same message twice. This new piece copies that same proven design.
- **The fingerprint fix** — a bug that used to misfile a peer's reply (and lose it) is already fixed in the shipped code. Replies now match by the peer's permanent ID.
- **The file-relay watcher** — earlier tonight I shipped a small watcher for the specific file-channel Dawn and I share: it checks every 5 minutes, sends back a "got it," and flags anything new. This spec turns that one-off idea into a real, general feature.

## What this adds

The core is a **delivery tracker**: every message I send to another agent gets a durable status — "waiting for confirmation," then "confirmed," or (if it goes wrong) "escalated." When the other agent receives my message, it sends back a tiny "got it" acknowledgment, which flips my record to "confirmed." That acknowledgment is the real proof of delivery — not just "the network accepted it."

On top of that:

- **Auto-retry**: if a message stays unconfirmed past a deadline (default 6 hours), the system automatically retries it a few times with growing pauses.
- **One honest escalation**: if it still can't get through after all the retries, you get ONE alert ("N messages to Dawn undelivered for over X hours") — never a flood of one-per-message alerts.
- **A health check you can read**: "is my channel to Dawn actually alive?" becomes a simple lookup — last message I sent, last one she confirmed, last time I heard from her, and how many are stuck. Silence becomes a visible signal instead of a guess.

## The safeguards in plain terms

- It only **records** — it never blocks or changes a message. If the whole thing broke, messages would still send exactly as they do today.
- A peer that hasn't upgraded yet (doesn't send "got it" acknowledgments) still works — their messages just stay "waiting," and the escalation still catches the silence. Nobody is forced to change for me to gain the safety net.
- Acknowledgments never get acknowledged back (no infinite loop) and never spawn a session.
- Alerts are aggregated (one per peer), so this can never become a notification flood.
- Turning off the retry/alert sweep instantly reverts to today's behavior with zero data risk.

## What's NOT changing

- The underlying network and its security model stay exactly the same.
- This doesn't fix the separate question of why Dawn's messages sometimes don't reach me over the agent network — that's a different investigation. In the meantime, the file-channel she and I share (now watched) is the proven, reliable path.

## What you need to decide

Whether to approve building this as specified. You already asked for it ("a long-lived queue so communications never just die out") — this is that, built on the pieces that already exist, recording-only so it can't break sending, and with alerts aggregated so it can't spam you (alerts arrive in the follow-on piece). The full PR1 — the delivery tracker, the wiring into both send/receive paths, the peer-health routes, and 31 tests across all three tiers — is written and passing. A multi-agent review pass caught one real wiring bug (the "got it" detection was keyed on the wrong identifier and would never have fired in production) — it's now fixed and guarded by a real round-trip test.

## PR4a — making a silent block impossible (added 2026-06-07)

The peer-health surface tells you *whether* a channel is alive. PR4a tells you
*why* an inbound died. The inbound gate used to block a message and say nothing —
no log line, just an internal counter that resets on restart. So when Dawn's
messages stopped reaching Echo, there was no trace to follow; the channel was
dark for over a day before anyone noticed. Now the gate writes a plain line to
the log for every inbound it sees: what it decided (let-through or blocked), why,
and what trust level it resolved the sender to. Fingerprints are clipped short and
no message text is ever logged. Nothing about routing changes — it just stops the
gate from failing in silence, so the next test from Dawn will say in plain words
whether the gate rejected her (and exactly why) or her message never arrived at
all. That answer points straight at the real fix.
