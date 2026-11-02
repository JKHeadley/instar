# Remote Desktop guided setup, in plain English

## What this is

Today, getting a Mac ready for Remote Desktop takes an agent editing settings and
restarting that machine, then a person at the Mac guessing their way through
permission pop-ups and the System Settings list. On 2026-11-01 Justin hit nearly every
way that can go wrong: Macs that were switched off for this feature, pop-ups that do
nothing on a locked Mac, a list that stayed empty even though the permission was
actually on, a pop-up naming the wrong program, and a machine shown under the wrong
name.

This change adds one "Set up" button per machine, on the dashboard's Desktop page and
in the app. You only need your PIN. It switches the feature on for that machine,
restarts it, then shows the one next thing to do, and rechecks the machine by itself.

## What already exists

Each machine can already report what it sees: signed in, locked, screen permission,
input permission. It can show macOS's own permission pop-ups. The designated "front"
machine is the one your dashboard talks to, and it can already reach the others with
signed requests.

## What is new

A step guide that reads that live report and picks the next step: wake or unlock it,
allow a pop-up, open the exact System Settings page on that Mac, or the written path
if that fails. Both the dashboard and the app show the same words, because the server
writes them.

Success is decided only by the live check. The wording says so, because the System
Settings list is known to be misleading: it can look empty, or show several entries,
while the real answer is different.

The wrong name is fixed too. Each machine kept its own idea of its nickname, and the
M5's still said Mac Lan. The front now uses the pool's name.

## The safeguards

- Your PIN session is required; an agent's ordinary token is not enough.
- A machine only accepts this from its own front. A machine already tied to a front
  refuses a different one.
- A machine with no front yet can be claimed by any machine paired with you, without
  that machine seeing your PIN. That is new. A Mac with no permissions shows nothing,
  because only a person at the Mac can grant them. A Mac that already has them could be
  reached this way, so it raises a high-priority notice and a Turn off button undoes it.
- Pop-ups are held back on a locked Mac, and limited to one a minute.
- Every change is logged on the machine it happened to.

## What it does not do

It cannot press Allow, unlock a Mac, or wake one that is asleep or off. It does not
change how the helper is signed, which the locked-screen work covers. It does not
explain the M5's five entries: the measurements are recorded in the spec, but the cause
is not proven, because macOS will not let us read that list remotely.

## What you need to decide

Whether a paired machine may claim an unclaimed one as described above. It trades a
hand-made settings change on each machine for a PIN at the front. Detection and undo
are the safeguards, not prevention. If that is not acceptable, the alternative is a
tap at each Mac the first time.
