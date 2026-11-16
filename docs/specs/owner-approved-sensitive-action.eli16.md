# ELI16 — Making the agent ask YOU before it does something only you should (owner-approved sensitive action)

## The one-sentence version

A few of the agent's most sensitive actions — trusting another agent completely,
permanently deleting a conversation thread — are supposed to be **your** decision,
but right now anything running on your computer can do them and have it recorded
as if you said so. This adds one shared way for those actions to require a **real
tap from you on your phone** that a program on the computer cannot fake.

## What already exists

Your agent already has an "owner presence" feature: your phone can unlock Remote
Desktop or reveal the dashboard PIN by **signing a one-time request with a key
that lives in your phone, behind Face-ID**. The computer never has that key, so a
program on the computer cannot produce that signature. This change **reuses that
exact mechanism** for two more actions — it is not a new login system, just two
new things your phone can approve.

## The problem it fixes

Several of the agent's tools check "did this request come from THIS computer?" and
treat "yes" as "the owner approved it." But a message from a **remote** agent can
start a session **on your computer**, and that session is "on this computer" — so
it passes the check. A program on your computer can also read your 6-digit PIN and
your API key straight off the disk, so a PIN or a password is **not** a safe way
to prove it's really you. The only thing it can't fake is a signature from the key
locked inside your phone.

## What's new

When this is turned on, a sensitive action (trusting an agent more, deleting a
thread) pauses and asks for your approval. Your phone shows a card in **plain
words** — "Grant this agent full trust?" / "Delete this thread?" — and you approve
with **one Face-ID tap**. Behind the scenes your phone signs a one-time,
action-specific request; the server checks the signature and does the action only
then. No tap, no action. If you have more than one phone, any of them works, and
your Telegram approval (bound to your account) can work as a backup — so losing one
phone never locks you out.

## The safeguards in plain terms

- **Ships turned OFF.** Nothing changes until it's switched on; flipping it back
  off restores exactly today's behavior.
- **A real owner tap stays one tap.** When you're the one doing it, it's a single
  Face-ID approval — this **restores** how it was always meant to work (your
  decision), it is not a new hoop.
- **The card can't lie.** What your phone shows you is built from the server's own
  record of the exact action, so you always approve the real thing; if the
  situation changes before you tap, the approval is rejected.
- **One tap = one action.** Each approval is single-use, time-limited, and tied to
  that exact action — it can't be reused for a bigger one.
- **Never stuck.** The action waits for your tap but survives a crash cleanly, and
  the mechanism is shared so the same safe path protects trust-grants, deletes, and
  (later) pairing and the relay switch.

## What you'd actually decide

Whether to turn it on (after it's built and tested). When it's on, the only new
thing you'd ever see is a quick Face-ID card the moment the agent is about to do one
of those few sensitive actions — which only you can approve.
