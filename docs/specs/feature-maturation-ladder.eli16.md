# Feature maturation ladder, in plain words

## What this is

Instar ships new features switched off until they are proven. That is safe, but too many stay off forever. Justin's rule on 2026-11-03: every switched-off feature must have tracking good enough to judge it, clear numbers that say when it can move up, and a last step of being on by default, unless someone records a decision that it should stay off because it's a matter of user preference.

## What already exists

- A review job runs Monday, Wednesday and Friday. It looks at every feature and reports to one Telegram topic.
- A board page shows where each feature stands.
- A scorer checks features against numbers every six hours, but only 8 features have numbers to check.
- A check refuses new specs with no maturation plan, but it only checks that the words are there.

## What is missing today

Of 224 features on the board, 4 are really on by default. 147 say "Nothing planned." 9 have a numeric target. The stage shown is a model's written opinion. And when a feature does meet its bar, nothing moves it: the review drops fixes into a queue of 424 items, where they sit.

## What this adds

1. **One file of ladders.** Every switched-off feature gets an entry: the numbers it must hit for each step, and how long it must hold them. A new switched-off feature without an entry fails the build.
2. **Real stage.** The stage now comes from what the code actually ships, not from someone's description.
3. **Better records.** Any feature can write a short record of each decision it made, with the reason and context. Features that already keep good logs just point to them. A feature with no records reads as "no data", never as fine.
4. **Something that acts.** When a feature holds its numbers long enough, it gets raised to the review automatically. The review's model then decides:
   - A setting that's easy to reverse on our development agent gets changed through one guarded route, which refuses if the feature is sensitive, or the setting changed since it was read. Every move is recorded and can be undone.
   - A move to everyone stays a reviewed code change. Two independent readings look at the evidence. If they agree, a build session opens to make that change, rather than a ticket joining the queue.
   - A switched-off feature can't earn numbers, so the first move is to start it safely in practice mode.
5. **A preference exit.** A feature can stay off for good only with a named decider, a reason, a date and a reference. All of these show on the board.

## The safeguards

- No number ever flips anything by itself. The numbers raise; the model decides.
- It never touches money, credentials, PINs, or anything that kills processes without a reviewed code change.
- Nothing reaches all agents without a reviewed code change.
- A feature that goes silent or does harm after a move gets raised at once.
- The review keeps grading what features did, so a bad threshold gets caught.
- A feature with a met bar and no move for 7 days, or with no data for 30, gets named in the review report.

## What Justin decides

One thing only: the wording added to the Maturation Path article in the constitution. That change goes out separately with a rendered link, and only merges after his sign-off. Everything else works without it.
