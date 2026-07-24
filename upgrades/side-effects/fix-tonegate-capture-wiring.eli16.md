# ELI16 — Making the tone-gate's settings dial actually connected

## What this actually is

Every message the agent sends to a user first passes through a "tone gate" — a checker that blocks
things like raw terminal commands, file paths, and config syntax from leaking into chat. The gate has
four operator settings: two control which direction it fails when the checker itself has trouble
(hold the message vs let it through), one is a rehearsal mode, and one — added just this morning in
PR #1599 — tells the gate to keep a copy of each message it judged, so we can later measure how often
the gate's verdicts are actually right.

Here's the embarrassing part: the wire between the settings file and the gate was never connected.
The code looked for the settings in a place that structurally cannot exist (`messaging.toneGate` —
but `messaging` in the config is a LIST of chat platforms, not a folder you can put settings in), and
even if it had found them, it copied only three of the four settings across, silently dropping the
new "keep a copy" switch. So the operator flipped the switch this morning and nothing happened: zero
copies were ever kept. We found this because a verification agent went looking for the captured
copies and proved there were none — then traced exactly why.

## What already existed vs what's new

Already existed: the gate itself, all four settings' behavior INSIDE the gate, and the capture
machinery from PR #1599 (which was fine — it just never got told to turn on). Nothing about how the
gate judges messages changes here.

New: one small, well-tested "resolver" function that is now the ONLY place where the settings file
is read for this gate. It reads the settings from the top level of the config file (the place that
actually works), passes all four settings through, and the gate's construction now uses it. The
documentation — including the docs already installed on every agent's machine — gets fixed to point
at the working location, with an automatic in-place correction for docs installed before this fix.

## The safeguards, in plain terms

- If you don't set any of these settings, absolutely nothing changes — the gate keeps its built-in
  defaults, and a test proves the resolver passes "unset" through untouched.
- The old broken location stays dead ON PURPOSE (and a test proves that too). Nobody's config ever
  worked from there, so honoring it now would create two competing places to set the same switch.
- The "keep a copy" feature only writes to the machine's own local records — the part of the store
  that is already excluded from anything shared between machines. That was PR #1599's design; this
  fix just lets it actually run.
- Rolling back is cheap: each setting can be turned off live in the config (no restart), and the
  whole change is one commit that can be reverted in one step.

## What you actually need to decide

Nothing operationally — this makes an already-approved, already-merged feature (and three
already-documented settings) work as documented. The one behavior to be aware of: if a config
somewhere already contained top-level tone-gate settings that were sitting there doing nothing,
they now take effect. We checked the operated fleet: only the dev agent has such a block, set this
morning specifically in anticipation of this fix.
