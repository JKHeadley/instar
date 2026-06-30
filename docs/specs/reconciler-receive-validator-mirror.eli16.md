# ELI16 — Mirror the cross-machine transfer record into the receive-side validator

## What this is, in plain English

When you run one agent across two machines, a conversation can be "owned" by one
machine, and sometimes it needs to be handed to the other (you pinned it there, or
the balancer wants it moved). The machine that currently owns it writes a little note
into a shared log — *"I'm handing conversation 28730 to the other machine"* — and the
other machine reads that log, sees the note, and takes ownership. That hand-off note is
the core of the cross-machine "stuck move" fix (root cause #3).

There are **two copies of the rule** that decides whether a log note is well-formed:
one on the **sending** side (when a machine writes a note) and one on the **receiving**
side (when the other machine reads it). The code literally carries a *"KEEP IN SYNC"*
comment between them, because a log stream is validated on receipt and any note that
fails validation makes the receiver declare the whole stream "suspect" and **stop
reading it**.

The earlier fix taught the **sending** side about the new hand-off note shape (a new
`reason` value, `reconcile`, plus a few optional fields like `status: transferring`
and `transferTo`). It **missed** teaching the **receiving** side. So in real life: the
owner writes a perfectly valid hand-off note, the receiving machine reads it, doesn't
recognize the new shape, marks the stream suspect, and stops — the transfer never
arrives, and the target never claims the conversation. The move stays stuck.

## What already exists

- The cross-machine ownership reconciler (the loop that decides a move is needed and
  writes the hand-off note). Proven working in a live two-machine run — it correctly
  wrote the hand-off note for the real stuck conversation.
- The send-side validator (`CoherenceJournal.validate`) which already accepts the new
  hand-off note shape.
- The receive-side validator (`JournalSyncApplier.validateData`), a hand-mirrored copy
  of the send-side one, which did **not** accept it. That's the bug.

## What's new

One change: the receive-side validator's `topic-placement` branch is updated to mirror
the send-side one **exactly** — it now accepts the `reconcile` reason and the optional
hand-off fields (`status` must be `active` or `transferring`; `transferTo` a string;
`timestamp` a finite number; `drainInFlight` a boolean), and it rejects a malformed
one (so a garbage value is still refused, never silently half-accepted).

## The safeguards, in plain terms

- **Back-compatible:** an old-style note with no hand-off fields still validates exactly
  as before (an absent `status` means "active", today's behavior).
- **Strict on malformed:** a present-but-wrong field (e.g. `status: "bogus"`, or an
  unknown extra key) is still rejected — the change only accepts the *correct* new
  shape, it does not loosen the allowlist.
- **No behavior flag needed:** this is a pure correctness fix to validation that should
  always have matched the send side. It does not introduce a new capability or a new
  decision; it makes an existing one correct.

## Why the tests missed it (and how it's covered now)

The earlier tests checked the send side and the "apply the materialized transfer" side
**in one process**. The receive-side validation step only runs when a note actually
travels **between two machines**, so a single-process test never exercised it. The new
tests drive the receive-side validator directly with a real transferring note and assert
the stream stays healthy (before the fix they fail — the stream goes suspect), plus
guards that a malformed hand-off field is still rejected.

## What you need to decide

Nothing risky. This completes an already-approved fix (#3) so that it actually works
across machines. Ship it, and the real stuck conversation finishes its move on its own —
no manual intervention.
