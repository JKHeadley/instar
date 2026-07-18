# ELI16 — Threadline Store-Split Fix (relay-spawn inbox split)

When two of my agents talk to each other, every incoming message is supposed to be written into two record books: a per-conversation logbook (which always gets written) and a separate "inbox" file. A security check added a while back verifies every reply by looking ONLY in the inbox file — but it turns out only one of the three delivery routes ever writes that file. So an agent would try to reply to a message it genuinely received, pointing honestly at that exact message, and the server would refuse with "that message doesn't exist" — even though it's sitting right there in the logbook. In the worst case (observed live, twice, on both agents) a session ends up with ZERO ways to reply at all and has to tear open a brand-new conversation just to get a message out. Two agents (Echo and sagemind) reproduced this against each other for two days and agreed on the diagnosis down to the exact lines of code.

## The fix, in plain words

Four pieces, one PR:

1. **Write the inbox on every route** — all three delivery paths record incoming messages the same way, not just one.
2. **Check both books** — the reply validator accepts a message id found in EITHER the inbox OR the conversation logbook (the logbook is tamper-evident, so this doesn't weaken security — it just stops ignoring half the evidence).
3. **Stop minting ghost conversations** — a name-vs-ID comparison bug makes the server think a known, trusted peer is a stranger and quarantine their message into a fresh empty conversation. Fix the comparison. This piece MUST ship together with piece 2, or fixing it alone would make replies break in a new way.
4. **Stop duplicate re-sends** — the retry system re-sends stuck messages under a brand-new id, so the receiver can't tell it's a duplicate and answers twice. Re-sends keep their original id, and receipts ("got it" acks) are never retried at all.

## What you'll notice

Nothing, ideally — that's the point. Agent-to-agent replies stop failing with bogus "message not found" errors, no more ghost duplicate conversations or double replies, and the awkward workaround conventions the two agents invented to talk around the bug get retired.

## Open questions (your call, restated simply)

1. Where should the "write the inbox everywhere" code live — inside the one existing shared write-funnel (default), or as a separate helper with a test that checks every route?
2. When a message arrives for a conversation that already has a live session working on it, should the system hand the conversation to the newest session, or keep the current one and pass the message in (default)?
3. Does the retry-with-same-id change need extra bookkeeping in the outbox file, or is the existing retry state enough (default: it's enough)?
4. This ships live with no off-switch (it's a bug fix that only widens what's accepted). Want an off-switch anyway for piece 3? (Default: no.)
