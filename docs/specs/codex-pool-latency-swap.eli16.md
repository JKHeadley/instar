# Giving Codex a second lane — Plain-English Overview

> The one-line version: the agent's background thinking runs on a second account
> so it doesn't spend the main subscription — that account has become slow and
> unreliable, and there is a spare sitting unused because nothing could enrol it.

## The problem in one breath

Most of the agent's small background judgements — classifying intent, checking
whether a claim is finished, reviewing tone — deliberately run on a **second**
provider so they don't consume the main subscription the operator pays for.

That second provider has degraded badly. Measured, not guessed: the very simplest
request takes about **thirteen seconds**, and several of those background checks
now sit at **sixty seconds**, which is the cut-off — meaning they aren't failing,
they're running out of time. The failure rate went from roughly a quarter over
three days to **most requests in the last hour**.

Two things make that worse than slow background work:

- **Every failure falls through to the main subscription** — the exact thing the
  second provider exists to protect.
- **Each stalled request occupies one of eight shared slots** until it times out.
  When they crowd it, the agent's own replies to the operator can't get a slot and
  are held back. That is not theoretical; it delayed a live demo.

And there is a **second account for that provider already signed in on this
machine, completely unused** — because nothing could enrol it.

## Why the spare account could not be enrolled

The pool that holds these accounts refuses to add one whose identity it cannot
verify — a sensible guard, since two entries silently pointing at the *same*
login would make "switch to the other account" a switch to itself.

But the only identity check available asks **Anthropic's servers** who is signed
in. Handed a Codex account, it cannot answer, so enrolment fails. The pool held
six Anthropic accounts and zero Codex ones, not by policy but because the door
was the wrong shape.

## What this adds

**A Codex account can now identify itself.** Its credential file already contains
a signed identity card listing the account's email, a unique account id, and the
plan — no network call needed. Reading it closes the enrolment gap.

**And the existing check learns to ask the right question.** The identity check is
handed a folder path and nothing else — it isn't told which kind of account lives
there — so the folder has to answer for itself. It can: a Codex folder holds that
identity card, an Anthropic one doesn't. The check now looks for the card first
(a quick local file read that comes back instantly when there isn't one) and only
falls back to asking Anthropic's servers otherwise.

Two details worth stating, because both are deliberate:

- **The Anthropic path is untouched.** For any folder that isn't a Codex one, the
  identical original check runs, with the identical result. A test exists purely
  to prove that, so "Codex now works" can't quietly mean "Anthropic now doesn't."
- **A broken Codex folder says so.** If the identity card is present but damaged,
  that is reported as a Codex problem rather than passed along to Anthropic — who
  cannot speak for it either — to be mislabelled as an Anthropic failure.

**A slowness trigger, not just a fullness trigger.** The machinery that moves work
to a healthier account today only reacts to an account being *used up*. Quota is
not the problem here — the account is at seventeen percent. The trigger is being
taught to react to an account being *slow or erroring* as well.

**Prefer the sibling before the expensive one.** When a Codex request fails today,
the next thing tried is the main subscription. It should try the *other Codex
account* first, and only fall back to the expensive one if both are unwell.

## What checking the plan first turned up

The plan read as though only the trigger needed building — the machinery is there,
it just watches the wrong thing. Checking that against the actual code before
building on it, three pieces were missing, and the trigger is the last of them.

**Nothing was choosing an account.** When the agent asks its second provider a
question, it never said which account to use — so every one of those requests went
to the default one. The ability to say which account already existed in the code
and worked; this path simply never used it. So "move a struggling account's work to
the other account" had nothing to move: there was only ever one account involved.

**Nothing was recording which account was slow.** Timing and failure counts are
recorded against the piece of the agent that asked, never against the account that
answered. So even with two accounts in play, there was no per-account measurement
for a trigger to read.

**The fallback list names providers, not accounts.** "Try the other Codex account
before the expensive one" has nothing to name today, because that list only knows
about providers.

So the test the plan proposed — make one account artificially slow and watch the
system offer to move off it — could not have passed. Not because the trigger was
missing, but because nothing measured or selected the thing the trigger would act
on. Building the trigger alone would have produced a dial wired to a dead gauge.

**This adds the first of those three: a request can now name its account.** The
other two are reported rather than quietly built, because they change the size of
the job and that is not mine to decide alone.

## The safeguards

**Adding the ability changes nothing on its own.** A request that does not name an
account behaves exactly as before — same account, same result. Nothing in the
running system names one yet, so this is a capability sitting unused until someone
deliberately switches it on. If the part that names the account is ever broken, the
request quietly falls back to the old behaviour instead of failing: losing the
choice is a small loss, losing every background request is not.

**Nothing moves on its own yet.** The new trigger ships switched off, and when
switched on it starts in a rehearsal mode that only writes down what it *would*
have done. A live session is not moved until someone reads those notes and decides.

**It cannot mix up the two kinds of account.** A Codex session can only ever be
moved to another Codex account, never to the main subscription's account — that
restriction already existed and was verified before relying on it.

**Reading a credential cannot leak it.** The identity reader returns an email and
an account id and nothing else. A test plants a fake secret in the file and proves
it appears nowhere in the result — with a control confirming the fake secret really
was in the bytes being read, so a clean result means something.

**Identity is a label, never a permission.** Knowing which account is signed in
names a row in a list. It grants nothing.

## What ships when

The identity reader and the enrolment path are useful immediately — they make the
spare account visible and usable. The slowness trigger ships dark and rehearses
first. Nothing about the main subscription changes.
