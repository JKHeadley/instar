# Plain-English Overview: Cancel an In-Progress Matrix Cell

## What this is

The account×machine matrix is the dashboard grid where you tap a cell to log one
of your accounts into one of your machines. Today, once you tap "Set up", the cell
goes into a spinning "in-progress" state and there is **no way to stop it**. If you
tapped the wrong account or the wrong machine, you're stuck watching it for up to
15 minutes with a real login window left open on that machine, and nothing to press
to back out.

This change adds the missing **Cancel**. You get a small Cancel button right on the
spinning cell. Tap it, confirm, and two things happen: the leftover login window on
that machine is shut down, and the in-progress record is marked "abandoned" so the
cell goes back to empty and you can tap the right one cleanly. It works whether the
cell is on the machine you're looking at OR on another of your machines — exactly
like the rest of the grid already does.

## What already exists vs. what's new

- **Already there:** the data model already has an "abandoned" state, and the code
  that flips a record to "abandoned" is already written and tested. It was just
  never connected to anything. The pattern for reaching a cell on *another* machine
  also already exists (it's how "paste your code" works across machines today).
- **New:** (1) a worker route the Cancel button ultimately calls; (2) a thin
  "relay" route that sends the cancel to whichever machine owns the cell; (3) the
  button itself on the in-progress cell; (4) two small safety tweaks to the login
  store so cancel can't corrupt anything and so you can re-try cleanly afterwards.

## The safeguards, in plain terms (and what review changed)

The first draft was naive in three ways that an independent review (including two
non-Claude models) caught before any code was written:

- **The original "shut down the pane" call did nothing.** The login window is a raw
  terminal session that the normal "kill a session" helper doesn't know about — so
  the first design would have reported success while leaving the window running.
  Fixed to use the exact shutdown the system already uses elsewhere.
- **Cancel would have broken re-trying.** Marking a record "abandoned" left its slot
  occupied, so re-tapping the same account would have errored out. Fixed so a
  re-tap cleanly replaces a finished/abandoned record.
- **Cancel could have un-done a *successful* login** if you tapped it a split second
  after the login finished. Fixed with a guard that refuses to touch a completed
  record, plus a rule that cancel stands aside ("try again in a moment") while a
  sign-in code is actively being submitted.

Other safeguards: it only ever un-does (no new power); it's reversible (re-tap to
redo); it ships behind the same off-by-default flag the whole matrix already uses;
and it deliberately does NOT delete the account's saved-login folder, because that
folder can hold a previously-valid login for the same account.

## A decision I already made (so you don't have to)

Whether Cancel needs your dashboard PIN. **It does not** — and this isn't a
shortcut, it's forced by how the grid already works: the PIN proves you're present
at the *start* (when a login is created), and the "operate on an existing login"
steps (like submitting your code) are already PIN-free because a PIN can't travel to
another machine (each machine has its own). Cancel is an "operate on an existing
login" step, so it matches them. The trade-off — a background process could cancel
an in-progress setup — is identical to what's already true for the code-submit step,
fully reversible, and behind the dev-only flag. If you'd rather it required the PIN
anyway (accepting that it would then only work for cells on the machine you're on),
tell me and I'll change it.
