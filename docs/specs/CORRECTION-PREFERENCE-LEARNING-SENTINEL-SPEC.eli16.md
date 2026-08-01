# What I'm building, in plain terms — the "learn when you correct me" feature

## The everyday version

You've been correcting me a lot lately — "say it plainer," "that's redundant," "stop asking me the same thing every session." Right now those corrections mostly help *that one conversation* and then disappear. If you correct me about the same thing in three different chats over a week, those look like three unrelated blips. Nobody connects the dots, so the stuff that bugs you most keeps happening.

This feature connects the dots. Think of it like a smart suggestion box that empties itself: every time you correct me, it quietly drops a note in the box. It never keeps your actual words — it reads the moment, writes down the *lesson* in one scrubbed line, and throws the raw text away immediately (so nothing private ever gets stored). Then a reviewer looks at the box and asks: "Is this the same lesson showing up again and again?" A one-off gets ignored. A repeat becomes something worth acting on.

## The important part: two kinds of lesson, two different homes

When you correct me, it's usually one of two things, and they go to different places:

1. **"Instar itself is clumsy here."** Example: I ask you to approve a routine force-push *every single session* because the safety guard can't tell a harmless push from a risky one. That's not about you — it's a tool that should be smarter. Lessons like this get sent upstream as feedback, where they can fix the tool for *every* agent, not just me.

2. **"This is just how Justin likes things."** Example: plain language, no big tables in chat, lead with the one thing you need to do. That's not a bug — it's your preference. Lessons like this get saved into *my* memory so I adapt to you specifically.

Telling those two apart, automatically, is the whole trick. Mixing them up would mean spamming the Instar team with your personal preferences, or quietly rewriting my own rulebook without anyone checking — both bad.

## The safety rules

- **It never stores your actual messages.** Only a short, cleaned-up lesson. The real words live just long enough for one quick read, then they're gone.
- **It never changes my behavior on its own.** It *proposes* — "hey, maybe save this," or "maybe report this tool gap" — and a human says yes or no. It can't quietly edit its own instructions.
- **It waits for a pattern.** One correction isn't a pattern. It needs to see the same lesson a few times before it suggests anything, so we don't overreact to a single off day.
- **It starts switched off.** Like the failure-watcher before it, it ships dark and only turns on when we choose.

## How repeated wording is recognized now

The first version only recognized a repeat when the cleaned-up words were
identical. That is too strict for normal language: “give me the plan link and
walk me through approval” and “show me the plan and explain each approval step”
can express the same preference while producing different stored records.

The analyzer now compares the cleaned-up word sets when it reviews the ledger.
It groups only highly similar records, and it never groups a personal preference
with a tool problem even if their wording overlaps. The stored identity of every
record stays unchanged, so this does not rewrite history or require a risky data
migration.

Similarity alone is not permission to promote. A group still needs enough
support, evidence on more than one day, and evidence from more than one real
session. The session check replaces the old topic check: Justin does most work
in one topic, so “different topics” measured navigation habits rather than
whether a preference survived a fresh conversational context. One intense burst
in one session still cannot become a standing preference.

The similarity floor is 0.65, and every pair inside a group must clear it. That
last part matters: if A resembles B and B resembles C, C cannot sneak into A's
group unless A also resembles C. The live 37-record ledger contains three
compact same-kind groups of sizes three, two, and three inside a larger
human-recognized approval-links family. The algorithm intentionally keeps the
looser variants apart, and it never merges the two records classified as tool
gaps with personal preferences. The family is also all from one day and one
session, so the live replay honestly promotes nothing yet. A test proves a
compact group becomes eligible only after qualifying evidence arrives on a
different day in a different session.

When a group does qualify, the ledger marks every member together before it
writes anything externally. If even one row changed in the meantime, nothing is
written. The rows also keep a shared group id during the check-back period, so a
repeat of any original wording reopens the whole lesson instead of letting one
wording look “fixed” while another keeps recurring.

## Why this is the natural next step

We just built the version of this for *code that breaks* (the failure-watcher). This is the exact same idea pointed at *conversations* instead of code — learn from the moment something went wrong, figure out whether it's a tool problem or a you-and-me problem, and make sure the lesson actually sticks instead of evaporating. The force-push nag you flagged today is literally the first thing it should catch.
