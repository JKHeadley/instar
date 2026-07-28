# Plain-English overview: fixing the "agents hand out a dead address" bug

## The one-sentence version

When one AI agent looks up another agent's "address" to send it a message, it gets
the wrong address — so the message goes nowhere. This fixes the lookup so the
advertised address is the one the agent actually answers to.

## What's going on, with an analogy

Think of each agent as a person with two things:
- A **mailbox address** the post office (the "relay") uses to deliver mail.
- A **business card** they hand out so other people know where to write.

The bug: the agent's business card has an **old, wrong address** printed on it (or is
blank), while the post office is delivering to a **different, correct address**. So when
someone copies the address off the business card and mails a letter, it never arrives —
even though the mailbox is working fine.

That's exactly what happened: Dawn tried to message Echo, copied Echo's "address" from
the business card (a file called `agent-info.json`), and her message vanished. Echo's
real mailbox address was different from what the card said.

## Why it happened

Each agent ended up with **two identities** that drifted apart:
- The real one the message-relay uses (in `identity.json`).
- An older one the "business card" was printed from (in `identity-keys.json`).

Nobody noticed because the relay side worked, and the business-card side is only read by
*other* agents trying to reach you — so you never see your own bad card.

## What already exists

- The relay (post office) and its correct address: working.
- The business card mechanism: exists, but prints the wrong/old address.
- A migration system (`PostUpdateMigrator`) that fixes already-installed agents on update.

## What this change does

1. Make the business card print the **same address the relay actually uses** — and add
   the address as a proper labelled field (a "fingerprint"), not a confusingly-named key.
2. Make the agent's health check report that same correct address instead of a blank.
3. Use the migration system to **reprint the business cards of every already-running
   agent**, because they all have the wrong card on disk right now — not just fix new ones.

## What we deliberately are NOT doing

We are NOT merging the two identities into one. They might be used for different security
layers (one for the relay, one for direct encrypted handshakes), and merging them could
break the encryption path. We only fix the *advertising* so the right address gets handed
out. Merging the keys, if ever wanted, is a separate decision for another day.

## What you'd need to decide

The approach is additive and low-risk: publish the correct address, leave the encryption
keys alone, migrate existing agents. The main judgment call is "publish the address vs. also
merge the two keys" — and this spec recommends the safer publish-only path. If a reviewer
thinks the two keys should be merged, that's the one thing worth a second look before
shipping.
