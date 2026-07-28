# Plain-English overview — Fixing the stop-hook crash (and stopping it from ever happening again)

## What this is

Every time one of my sessions finishes a turn, Claude Code runs a handful of tiny
"stop hooks" — little scripts that do bookkeeping. One of those scripts shipped
with a typo: an extra `})();` on the last line. That one stray line made the whole
script fail to even load, so Node printed `SyntaxError: Unexpected token '}'` every
single turn. That's the red "Ran 5 stop hooks → Stop hook error" you kept seeing in
the logs.

The important part: the typo isn't in some hand-edited copy on one machine. It's in
the **source code that generates that hook** for every agent. So this has been
crashing once per turn across the whole fleet. The crash was loud but harmless —
that particular hook is a dark, do-nothing-yet feature, so nothing got blocked or
corrupted; it just spammed errors.

## What already exists

There's already a regression test that looks at these generated hooks. But it only
checks for **one specific old mistake** (a different ESM bug from May). It never
actually tries to *load* the hooks. So a brand-new, unrelated typo like this one
walked straight past it.

Built-in hooks like this one are **re-written on every update** — that's a deliberate
design so agents can't get stuck on a broken old copy. That same mechanism is what
makes the fix spread: once the corrected source ships, every agent's hook gets
re-written correctly the next time it updates.

## What's new

Two small things:

1. **The typo is fixed** in the source template — the stray `})();` is removed. The
   hook body was already correct; only that extra line was wrong.
2. **The test is upgraded** so it now *actually generates and parses every hook* (it
   runs `node --check` on each one). This is the gate that was missing. From now on,
   if any hook has a syntax error of any kind, CI fails before it can ship. The test
   already caught this exact bug when I ran it — it failed on the broken hook and
   passed on the other 23, then went green after the fix.

## The safeguards, in plain terms

- The fix can only *help*: the corrected hook is byte-for-byte the same as before
  minus the one invalid line, and the always-overwrite update path heals every
  deployed agent automatically.
- The new test can only *fail the build* — it has no power over a running agent. It's
  a guard at the factory, not a guard in the field.
- Rolling back is a one-commit revert with no data or state to repair.

## What you're deciding

Whether to ship this fix. It stops a fleet-wide per-turn crash and closes the hole
that let it through (a hook typo can never ship again). It's intentionally narrow —
the *runtime* "detect-and-auto-heal a broken hook on an already-running agent without
waiting for an update" layer is a separate, larger change (Fix B) that follows this
one.
