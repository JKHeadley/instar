# External Operation Gate fail-safe — explained simply

## The everyday version

Your agent has a safety gate that sits in front of risky actions on outside
services — deleting emails, posting messages, changing files in another system.
Before any such action runs, the gate looks at three things: what the action does
(read, write, modify, delete), whether it can be undone, and how many items it
touches. From those it computes a risk level (low / medium / high / critical) and
decides whether to just let it through, log it, ask you first, or block it. This
gate exists because of a real incident where an agent deleted 200+ emails on its
own, ignoring "stop."

## The bug

The risk calculator had a blind spot. It carefully handled all the *expected*
values — but if it was handed a value it didn't recognize (a typo, a brand-new
kind of operation, or a deliberately weird input), it quietly fell through to
"low risk" — which means "go ahead, proceed." So an operation the gate *couldn't
classify* was waved straight through. For a safety gate, that's exactly backwards:
the one case it doesn't understand is the one it should be most careful about.

This matters because the gate is fed by untyped sources at runtime (an HTTP
endpoint and a tool-intercepting hook), so unrecognized values genuinely reach it.

## What we changed

We made it fail *closed* instead of *open*. Now, if the operation's *type* is
unrecognized, it's treated as the most dangerous level (critical), which means the
gate asks you to approve it (or blocks it in the strictest mode) — it never just
proceeds. And if the "can it be undone" or "how many items" fields are
unrecognized, they're assumed to be the worst case (irreversible / bulk), so the
risk is computed conservatively. Plain reads stay fast and frictionless, exactly
as before.

## Why it's safe

Every one of the normal, recognized combinations behaves identically to before —
we proved that with a test that spot-checks valid inputs are unchanged, on top of
the existing 12 matrix tests. The only behavior that changes is for inputs the gate
previously couldn't classify, which now get the careful treatment instead of a free
pass. An independent reviewer checked the whole thing and agreed it's sound, and
also pointed out a matching blind spot one layer up: the hook that labels
operations treated every unfamiliar verb as a read. Issue #628 closes that mirror
gap by fast-pathing only explicit reads and sending unfamiliar or compound-mutating
verbs to the gate for its decision. Nothing to configure — the two layers now share
the same conservative treatment of unknown classification input.

## Who found it

The codex mentee agent (Codey) found this while being driven through real Instar
development tasks — a nice proof that the mentorship loop surfaces genuine bugs.
