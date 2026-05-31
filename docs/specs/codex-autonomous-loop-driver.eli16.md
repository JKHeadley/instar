# Codex autonomous-loop driver — explained simply

## The robot that stops after one step

Picture an AI worker you've told: "keep going until the whole to-do list is done."
For the Claude-powered worker, there's a clever trick already in place: every time it
tries to stop, a little doorman (a "Stop hook") checks the to-do list. If there's work
left, the doorman says "nope, here's what's next — keep going," and hands it the next
task. That's what lets Claude grind through a long job on its own.

The codex-powered worker (Codey) has **no doorman**. It does one step, then walks out
the door. So any long task just... stops after the first step. That's the whole reason
"Codey can't carry a long task."

Here's the surprising part we confirmed: codex **supports the exact same doorman idea**.
Codex fires the same kind of Stop hook, and it obeys the same "nope, keep going + here's
the next task" reply (we verified this is even baked into the codex program itself). The
ONLY thing missing was that nobody had hired a doorman for codex. The setup that hires
the doorman only ever did it for Claude's door, never codex's.

## The fix

We hire the same doorman for codex's door too. Literally the same script — we just whisper
`--codex` to it so it knows which door it's standing at. Claude's door is completely
untouched (the doorman there gets no `--codex` whisper, so nothing about Claude changes).

## Two safety belts (because this is important machinery)

1. **It starts switched OFF.** There's an on/off switch (a config flag) that ships in the
   OFF position. While it's off, the codex doorman just waves everyone through — exactly
   like today. Nothing changes for any codex worker until someone deliberately flips the
   switch on. And flipping it back off is instant — no reinstall, no restart.

2. **It can't touch Claude.** The Claude path doesn't even look at the new switch. So
   even if the switch misbehaved, Claude's "keep going" loop is provably unaffected. The
   worst case is a clean undo of the whole change.

## How we'll turn it on

Build it → ship it OFF (dark) → flip it on for ONE real codex run and watch it actually
keep going across several steps → only then leave it on. If the doorman doesn't fire on
codex's second door (a quirk of how codex runs hook groups), the fallback is to move it
into the main group — caught before anyone relies on it.

## Why it matters

This is the single biggest thing standing between "Codey does one step" and "Codey
finishes the whole job by itself." It's the headline piece of making codex a true equal
to Claude inside instar — and it turned out the hard parts were already built; we just
had to connect the last wire, carefully.
