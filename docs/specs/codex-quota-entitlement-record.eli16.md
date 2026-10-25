# Codex quota readings go blank at session close — Plain-English Overview

> The one-line version: Codex writes a final, empty bookkeeping record when a session ends, we were reading that record instead of the real usage numbers, and so an account's quota card went blank the moment it stopped working.

## The problem in one breath

The Subscriptions dashboard shows a usage bar for each Codex account. Three of five accounts showed "No quota reading yet" instead of a number, and had done for days. It looked like a login problem. It was not — every one of those accounts was logged in and working. We were reading the wrong line out of the account's own session log.

## What already exists

- **Codex's session log** — OpenAI's Codex tool keeps a local log of every session. After each turn it appends a record of how much of the account's weekly allowance has been used. That record is the only place this number is available; there is no usage API to ask.
- **The rollout reader** — the piece of Instar that opens the newest session log and pulls the freshest usage record out of it.
- **The quota poller** — runs on a timer, calls the reader for each enrolled account, and stores the result so the dashboard and the work-placement logic can use it.
- **The Subscriptions dashboard** — draws a coloured bar per account, or the words "No quota reading yet" when there is nothing to draw.

## What this adds

Codex does not write only one kind of usage record. It writes many real ones during a session — and then, once, at the moment the session closes, it writes a record of a *different kind*: an entitlement or credits record. That closing record carries no usage numbers at all. The reader was taking the newest record without checking which kind it was, so the single closing line overwrote a whole session's worth of real numbers. One account's log held 600 real records and one closing record, and the closing one won.

The fix teaches the reader to tell the two kinds apart and keep the newest record that actually carries usage numbers. Two smaller changes come with it:

- When an account genuinely reports no usage window at all — a credits-only account that will never produce a number no matter how often we poll — the card now says so plainly instead of "No quota reading yet", which implies a reading is on its way.
- A usage reading is only as fresh as the last time something actually ran on that account. An idle account can sit on a days-old number. Once a reading is more than six hours old, the card now says how old it is, so a stale bar cannot read as current.

## The new pieces

- **The record-kind check in the reader** — decides which of the account's records is the real usage one. It only ever *chooses between records the account itself wrote*. It cannot invent, adjust, or estimate a number, and a record belonging to some other product's allowance is ignored rather than presented as this account's.
- **The "reports no usage window" flag** — a plain true/false that travels from the reader to the dashboard. It is there so the screen can be honest about an account that has nothing to report. It is display-only: nothing routes work, sheds load, or swaps accounts on it.
- **The reading-age label** — a line under the bar, shown only when the reading is old enough to mislead. It reports the age of a number; it never changes the number.

## The safeguards

**Prevents a wrong number reaching the decisions that spend money.** The reader produces a signal, not a verdict. The parts of Instar that decide which account to run work on already have their own rules, and this change does not touch them. What it changes is that they now get the account's real number instead of nothing — which makes them *more* cautious about exhausted accounts, not less. The separate load-shedding brake, which requires both of Codex's usage windows before it will trust a reading, behaves exactly as it did before.

**Prevents "we have no information" from being dressed up as information.** There are now three distinct states and they stay distinct: we found a usage number; the account answered and reported no usage window; we found nothing at all. Before, the last two looked identical on screen. A missing reading is still reported as missing — the fix never fills a gap with a guess.

**Prevents the new flag from breaking machine-to-machine sync.** When the same agent runs on several machines, each machine shares a small summary of its accounts with the others, and the receiving side is strict: a summary containing a field it doesn't recognise is thrown away whole. The new "reports no usage window" flag has been added to that shared vocabulary as a strict yes/no value, so a summary carrying it still crosses. A machine still running the previous release ignores such a summary until it updates — a brief stale view during a rolling update, never a wrong number.

**Prevents an old number from passing as a current one.** Showing a bar with no age attached is a claim about freshness we cannot actually make. The age label makes the claim honest, and only appears once the age is big enough to matter.

## What ships when

All of it in one change. The reader fix, the honest label, and the age line are three small edits that share one root cause, and splitting them would ship a correct number with a misleading presentation. There is nothing behind a flag and nothing to turn on — the next release carries it to every machine.

## What you actually need to decide

Nothing: this is a straight bug fix with no new behaviour to opt into, so the only question is whether six hours is the right point for a reading to start showing its age.
