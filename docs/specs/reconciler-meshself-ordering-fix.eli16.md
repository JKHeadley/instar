# Reconciler Boot-Ordering Fix — Plain-English Overview

## What was broken

The background "convergence loop" (the OwnershipReconciler) is the thing that's supposed to finish a
cross-machine conversation move — it watches for "this topic is pinned to the other machine" and drives
the hand-off. It turns out it has **never actually been running**.

In the server's startup code, the loop is built inside a check that says "only build this if the machine
already knows its own identity." But that identity value is set up about **950 lines later** in the same
startup sequence. So at the moment the check runs, the identity is still empty, the check fails, and the
loop is silently never built. Confirmed on the live machine: zero loop activity in the logs, and the loop's
status endpoint reports it inactive even with both machines fully online.

This is why the earlier "stuck move" never got fixed by the loop — the loop wasn't there. The earlier soak
blamed "watch-only mode," but the real reason was this ordering bug. It was caught by **driving the feature
through live** (the status endpoint shipped in the prior change is what exposed it).

## What already exists

This **exact** bug was already found and fixed for a sibling component — the part that *claims* a moved seat
(the OwnershipApplier). Its identity lookup was made "late-bound": instead of reading the identity once at
build time (when it's empty), it reads it each time it runs (by which point it's filled in). That fix has a
shipped spec and unit tests.

## What's new

The same proven fix, applied to the convergence loop:
- The loop is now built whenever its pin store exists — it no longer requires the identity to be set first.
- The identity is now read **late** (each tick), not captured once at build time.
- While the identity is still empty (very early boot), a tick is a strict no-op — it never acts without
  knowing which machine it is (every decision is relative to "self", so acting blind would be unsound).
  Once the identity fills in, the same loop instance starts working.

## Safeguards (plain terms)

- The loop still only acts on the operator's own machines, still dark/dev-gated, still no-ops when there's
  only one machine. Nothing about *what* it does changed — only *that it now exists and runs*.
- A new regression test proves both sides: a null identity no-ops the tick, and once the identity resolves
  the same loop acts. Two other construction sites (tests) were updated to the new late-bound shape.

## What you're deciding

Whether to ship this small, proven-pattern ordering fix so the convergence loop actually runs (it follows
the identical, already-approved fix used for its sibling component). Without it, the merged convergence fix
is correct but inert.
