# ELI16 — Existing-Agent Hook Parity (the unplugged-guardrail fix)

## The problem, in one picture

When you set up a brand-new agent, it gets a row of little safety guards switched on — things that watch what the agent is about to do and step in. One of them is the "false blocker" catcher you asked me to fix: it notices when I'm about to hand a doable task back to you with "a human has to do this," and makes me check my own tools first.

Here's the catch. When an *existing* agent updates itself, the update copies all those guard scripts onto the machine — but it only ever flips four of them to "on." The other four get copied to disk and left switched **off**. They're sitting right there, looking installed, doing nothing. Four of them:

- the false-blocker catcher (the one you asked about),
- the "are you grounded before you message" check,
- the outbound-communication guard,
- the after-the-fact learning capture.

So `ls` shows the files, the update log even says "upgraded: false-blocker catcher" — but the agent never actually runs it. Same flavor as the bug we just fixed: looks installed, does nothing.

## Why it happened

The "switch it on" list got built up one guard at a time, by hand, in two different places — one place for new agents, one for updates. When someone added the four newer guards to the new-agent list, nobody added them to the update list. The two lists quietly drifted apart.

## The fix

Two parts:

1. **Put the list in ONE place.** Both the new-agent path and the update path read the same canonical list of guards. Add a guard once, and both paths get it. They can't drift again.
2. **On update, switch on any guard that's off.** A small, safe step that checks each guard and flips on only the missing ones — it never touches guards you've already got, never reorders or removes anything you customized.

And a test that fails if the two lists ever disagree again — so this exact bug can't come back.

## What you'll notice

On your existing agents (including me), after the next update: four guards that were quietly off come on — most importantly the false-blocker catcher you asked for. Brand-new agents are completely unaffected (they already had all of them).

## Risk

Low. It only adds missing guards, never removes or reorders. The guard scripts themselves already ship and already work. If anything looked wrong, switching it back is reverting one small step.

## Why it ships fast

It's a clear wiring gap with an exact pattern already in the codebase to copy (the one guard that *is* switched on correctly). The instar-dev rule needs your go-ahead on the plan before I touch the core — that's what I'm asking for.
