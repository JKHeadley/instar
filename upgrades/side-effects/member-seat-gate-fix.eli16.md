# ELI16 — Member-seat permission-gate false-positive fix (fb-e5b8b021-b74)

## What was broken

The Slack bot has a safety gate that decides whether a person is allowed to make
a given request. Every request gets a "sensitivity tier" from 0 (just chatting)
up to 4 (dangerous: money, production deploys, deleting data). Every person gets
a "role ceiling": a regular **member** can do tier-1 things (reads, summaries,
drafts) but not tier-2 and above without more authority.

The bug: when a regular member typed a totally harmless message like
**"post a check-in note here in 5 minutes"**, the gate labeled it a tier-2
"low-write" — because the word "post"/"note" tripped the write-verb detector.
Tier 2 is above a member's ceiling, so the gate **refused** the member with an
authority challenge: *"That's above what a member can authorize on their own."*

Because almost anything a member might ask the bot to say/post/schedule tripped
this, ordinary members effectively **could not talk to the bot at all** while
enforcement was on. Admins were fine; members were locked out. That was
demonstrated live from the member seat during today's Slack drive.

## Why it happened

Two places conspired:

1. The **heuristic classifier** treated ANY message containing a write verb
   (`post`, `note`, `schedule`, …) as a tier-2 low-write — including the bot
   simply posting a conversational note into the CURRENT channel, which isn't an
   organizational action at all.
2. The **LLM classifier** (used in production) couldn't rescue it: its reconcile
   step only ever RAISES the tier (`Math.max`), never lowers it. So even when the
   LLM correctly read the message as conversational, the tier was clamped back up
   to the heuristic's wrong tier-2.

## The fix

We taught the classifier to recognize a **harmless conversational self-post** — a
note / check-in / reminder / status update the bot would post into the current
conversation — and classify it at **tier 1** (the same level as a draft), which a
member IS allowed to direct. The recognition is deterministic and conservative:

- It fires only when BOTH a post-style verb AND a conversational-content noun are
  present (so plain chatter like "just checking in" stays tier 0).
- It is disqualified by ANY organizational-write, external, or operational marker
  — a ticket, a record, another named channel (`#…`), a calendar hold, an email,
  or a "run/deploy/job". Those keep their higher tier.
- Floor detection (money, prod-deploy, credentials, destructive, external-send,
  grant-authority) runs FIRST and always wins, so a privileged action hidden
  inside a "post a note" phrasing is still caught and refused.

To make it stick on the production LLM path, a recognized conversational self-post
short-circuits the LLM entirely (just like a floor action does), so the judgment
band can't re-escalate it back to tier 2.

## What did NOT change

This is a precision fix, not a floor removal. A member asking for a genuine
low-write (file a ticket), an operational action (run a job), or any privileged
floor action is STILL refused exactly as before. The "someone said it's fine"
name-in-content trap still fires on floor actions. Guests still cannot direct
actions. Only the harmless conversational note/check-in case moved from
wrongly-refused to correctly-allowed.
