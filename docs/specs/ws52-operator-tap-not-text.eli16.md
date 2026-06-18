# Plain-English overview — Making account-sharing a single tap (and making sure no feature ever asks you to paste code again)

## What this is

The "account follow-me" feature lets one of your machines borrow another's login the safe way (each machine does its own fresh login; no password or token is ever copied). The plumbing for it shipped — but when you went to actually use it, two things were broken:

1. There was no simple button. The only way to approve it was to expand an "Advanced" section and paste a blob of JSON and some long fingerprint codes into a form. That's a developer chore, not something an operator should ever face.
2. Even if you'd done that, nothing would have happened next. The approval would travel to the other machine and just sit there — nothing told that machine to actually start the login. So it would have stalled silently.

The reason both slipped through: I checked that the wiring "existed" but never actually walked through *your* experience of it. There's already a rule that says a feature isn't done until it's used end-to-end through the real screen a person touches — and I skipped it.

## What this change does

**One tap.** On the dashboard's Subscriptions tab, you'll see a plain card: "Let *the Mac Mini* use your *adriana* subscription — Approve," with a single PIN box. Tap Approve, type your PIN, done. No JSON, no fingerprints, no Advanced section. The screen builds all the technical details behind the scenes from a tap.

**It actually runs.** When you approve, the other machine receives it and immediately starts its own login, then sends *you* one tappable link (on Telegram). You tap the link, log in on your phone, and that machine now has the account. No copying anything, ever.

**It can't happen again.** You asked for this to be enforced, not just promised. So:
- A build-time check blocks any new operator screen that would require pasting raw/technical text.
- A live guard stops me mid-message if I ever try to ask you to paste JSON or run a multi-step technical process.
- A written rule in the constitution — "Operators act in taps, not text" — that both checks point at.

## What already exists vs. what's new

The scan that finds machines-without-an-account and the cross-machine delivery already exist. New: the tap-card UI, the connector that makes the other machine actually start the login and send you the link, the two enforcement checks, and the written standard.

## What you need to decide

Mainly: are you happy with the enforcement approach (the build-time check + the live message guard + the written rule), and the exact wording of the "Operators act in taps, not text" standard? Everything else is mechanical. And before I bring the proof back to you, I drive the whole thing myself first — you'll only ever tap the final real login link.

## Safety / rollback

No token ever leaves a machine (only a login link + public code). Every step fails safe if a check doesn't pass. Each piece is behind a flag and can be turned off to revert, with no data migration.
