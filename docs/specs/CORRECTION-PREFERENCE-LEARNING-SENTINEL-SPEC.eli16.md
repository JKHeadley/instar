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

## Why this is the natural next step

We just built the version of this for *code that breaks* (the failure-watcher). This is the exact same idea pointed at *conversations* instead of code — learn from the moment something went wrong, figure out whether it's a tool problem or a you-and-me problem, and make sure the lesson actually sticks instead of evaporating. The force-push nag you flagged today is literally the first thing it should catch.
