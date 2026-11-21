# Held and startup-parked Telegram sends — Plain-English Overview

> The one-line version: a reply that was set aside because the server was starting gets sent once the server is ready; a reply that has been waiting longer than 30 minutes is never sent blindly but goes back to the session that wrote it; and there is now one supported way to cancel a single waiting reply, with a record of who did it.

## The problem in one breath

When an agent session writes a reply to the person on Telegram, the reply goes through the agent's local server. Twice in the Mac Studio outage of 20–21 November 2026, that went wrong silently. Replies written while the server was restarting were put in a waiting queue, the session was told "queued, it will be sent", and then the server never sent them. Separately, replies written while the Studio was not the machine in charge of sending ("not holding the lease") were held, and nothing checked how old they were before letting them out — so a reply could arrive hours late and out of context, or (as happened) sit there with nobody deciding anything.

## What already exists

- **The waiting queue.** If the server cannot take a reply, the reply script writes it to a small database on the machine so it is not lost.
- **The delivery outbox.** On every recovery pass (every 30 seconds) the server imports that queue and sends anything it can prove was never sent. Anything it cannot prove is marked "may have arrived" and never sent again, so the person never gets two copies.
- **The boot beacon.** While the server is starting, a tiny stand-in answers every request with "starting, retry in a few seconds". It answers before the real server exists, so a request it answered definitely did not reach Telegram.
- **Held replies.** A reply refused because this machine is not in charge is recorded as "held" and retried: forwarded to the machine in charge, or sent locally once this machine is in charge again. Each one expires after 6 hours, and expiry tells the writing session.
- **Hand-back lines.** The server can type a one-line note into the session that wrote a reply ("your reply was not delivered, its text is here, send again if still needed"), and can raise an item in the operator's attention list.

## What this adds

The biggest fix is one line of recognition. The boot beacon's answer changed shape on 16 November, and the outbox still only recognised the old shape. So every reply written during a restart looked like "may have arrived" and was never sent. Now the outbox recognises the current answer exactly (and only exactly), proves the reply never left, and sends it as soon as the server is ready.

Secondary changes:

- **A 30-minute freshness rule.** Before a held or set-aside reply is released automatically, its age is measured from when it was first written. Up to 30 minutes old, it goes out as before (with the existing "late reply" first line past 5 minutes). Older than 30 minutes, it is not sent. It is handed back to the session that wrote it, which knows the conversation and decides whether to send it again. If that session is gone, one plain note per conversation lands in the attention list (no message text in it), ending "if it should still go out, tell me and I will send it".
- **A cancel button for one reply.** A new route lets the agent, acting for the operator, retire one held reply by its id. It refuses if the reply might be in the middle of being sent, or if another machine might already have delivered it. Every retirement — automatic or manual — leaves a permanent record row: when, why, by whom, and what state the reply was in.
- **Honest answers.** When a session asks "did my reply arrive?", a handed-back reply answers "not sent, safe to send again if still right", an operator-retired one answers "not sent, do not resend unless asked", and the old set-aside rows that were wrongly marked stop claiming "the server will retry it".

## The safeguards

**No duplicates.** The new recognition accepts only the beacon's exact answer, with exactly its fields; anything else, including the same answer relayed from another machine, stays "may have arrived". A reply that may already be with the person is never retired as "not sent" and never sent again.

**Nothing is thrown away.** A handed-back or retired reply keeps its full text, readable by the session that wrote it. The decision moves to someone with context; it is never deleted.

**The four stuck Studio replies stay unsent.** They are all far older than 30 minutes. When this ships, any still waiting either gets its "may have arrived" question answered by the machine it was forwarded to, or reaches the freshness rule and is handed back — or its 6-hour expiry fires first. None can go out blindly.

**Machines stay in their lane.** A held reply lives on the machine that wrote it; only that machine can retire or release it.

## What ships when

One pull request: the recognition fix, the freshness rule at the three release points, the retirement record and route, the hand-back notes, and tests at all three levels (logic, the real server routes, and the full production start-up path).

## What you actually need to decide

Nothing beyond approving the approach, which the repair brief already asked for. In plain terms: replies written during a restart now reach you once the server is ready. Replies that have waited more than 30 minutes will **not** reach you automatically. The session that wrote them gets them back and decides whether to resend; if that session has ended, you see one note per conversation in your attention list saying a reply was held back, and you can tell me to send it. And the agent can stop one waiting reply by its id, with a recorded reason. Yes or no?
