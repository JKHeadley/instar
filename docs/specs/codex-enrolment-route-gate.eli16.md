# Enrolling a Codex account — the second door

## What this is

A one-line fix to a gate that was refusing something it should have allowed, and the test
that stops it happening again.

## The story

The previous change taught the system to recognise which account is signed in to a Codex
credential slot. That was the thing standing between you and holding two Codex logins, and
it worked.

Except enrolling a Codex account still failed.

There were two doors, not one. The first door asks "can we identify who is signed in here?"
— that is the one that got fixed. The second door sits in front of it and asks a cruder
question: "is this even a kind of account we know how to identify?" That second door had
the answer written into it directly: Anthropic only. It was correct when it was written,
because Anthropic was the only kind we could identify. Nobody updated it when Codex became
identifiable, so it kept turning Codex away without ever asking the first door.

## The fix

The second door now asks the identity layer what it can handle instead of carrying its own
copy of the answer. The list of what can be identified lives next to the code that does the
identifying, so adding a new kind of account and declaring that we can identify it are the
same edit. Writing the answer in two places is what caused this; writing it in two places
again would cause it on the next one.

To be clear about what this door does and does not do: it only decides whether the question
is worth asking. It grants nothing. A Codex slot that cannot prove who is signed in is still
refused, exactly as before — this only stops us refusing without asking.

## How it was found, and why that matters

Not by reading the code. By trying to actually enrol the account on a running system and
watching it fail.

The previous change came with a test that enrolled a Codex account successfully. That test
was real and it passed — but it started one step past the second door, so it never touched
the thing that was broken. Every test was green while the operation those tests existed to
enable did not work.

That is the useful lesson here, more than the fix itself: a test that stops just short of
the real entry point can be perfectly green over a broken feature. The new test covers the
door that was missed, and it was checked by putting the bug back and confirming the test
fails.

## What could still go wrong

The risk now runs the other way. If someone adds an account type to that list without
anything behind it that can actually identify it, the door would wave through an enrolment
we cannot verify — a false yes, which is worse than the false no we just fixed. So there is
a test that walks every entry on the list and proves something can genuinely answer for it.

## What you would notice

Nothing changes for accounts you already have. If you have a second Codex login, it can now
be enrolled.
