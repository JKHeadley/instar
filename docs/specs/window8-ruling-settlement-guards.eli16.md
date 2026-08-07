# The window-8 settlement guards, explained plainly

## What happened first

Instar's constitution is a single file of ~86 numbered rules. Yesterday four new rules joined it, and
before accepting them we sent the whole family to an outside reviewer — deliberately without telling it
which rules were new, what we expected, or that we wanted a yes. It came back **NOT ACCEPTED** with five
problems. Four of them were about rules that had been sitting there for months.

Those four went to the operator, because an agent that picks the winner between two already-ratified
rules is legislating rather than engineering. He ruled on all five. This change executes two of those
rulings and builds the checks that keep them true.

## Problem one: two rules disagreed about who can stop the agent

If you type "stop", something has to decide that you meant it.

One rule said: **a machine decides that, using intelligence — never a keyword list.** Another rule said:
**a decision that swallows your message needs an exact literal match, never a machine's guess.** For a
stop command, those are opposite instructions, and both were ratified.

The ruling settles it as a **two-layer union**:

- The **literal floor** — a bare "stop" — *always* stops, and the intelligence layer can never overrule
  it. In the code, a literal match returns before the model is even asked.
- The **intelligence layer** can only ever *add* stops. If you write "belay that, unwind what you just
  started", the model recognises it and that stops too.

Stop happens if **either** layer says so. Never only if both do.

The interesting part: **the code already worked this way.** The conflict was never a bug in behaviour —
it was a bug in what two rules *told a reader*. Which is exactly why it was worth fixing. Nothing was
broken today, but someone resolving that contradiction the other way would have deleted the un-vetoable
floor and rebuilt the conditions for a real incident from June, when a misfiring gate locked the operator
out of their own channel — and they'd have had a ratified rule to justify it.

**The check that keeps it true** drives the real classifier and asserts both halves: a literal stop kills
*and the model receives zero calls* (that's what "can't be overruled" actually means — not that we ignore
its answer, but that we never ask), and a non-literal stop the model recognises kills on its own. There's
a third test that deliberately does *not* stop, so we know the first two aren't passing because the
harness kills everything.

## Problem two: one rule written down three times

Three separate rules all said "before you tell a human you're blocked, go check what you can already do
yourself." The reviewer's complaint wasn't that this is wrong — it's that with three copies, **nothing
said which one governs.** If you're an agent about to escalate, which do you follow?

The ruling: pick one owner and **delete the duplication — don't reconcile it.** Reconciling means writing
a paragraph explaining how three rules coexist. That's adding words. Deleting means there's nothing left
to reconcile.

So one rule now owns the obligation and the escalation ladder. The other two keep only the thing each
uniquely detects — one spots "there's no way to do this", the other spots "a person has to do this" — and
each explicitly says *I do not own this duty, it lives over there.*

**A judgement call worth naming.** "Fold three into one" could mean *delete two rules entirely*. It
doesn't, here — and the reason is evidence, not preference. Those two rule names are referenced across
about twenty files, including their own specs, two live safety checks named after them, and four test
files that assert them by name. Deleting the headings would either strand twenty stale references or drag
a rename of two working safety checks into what is supposed to be a documentation ruling. The defect the
reviewer actually named was *the missing boundary*, and that is what's fixed. If the operator meant the
larger change, it's a separate one, and this is written down rather than quietly decided.

## The check that keeps *that* true

Prose saying "there is one owner" is exactly the kind of claim that rots. The next person to improve one
of those sibling rules will restate the ladder there in good faith, and nothing would notice.

So there's now a check that fails if: the owner stops declaring that it owns the duty, a sibling stops
saying it *doesn't*, or the ladder's exact wording shows up in more than one rule.

**What it deliberately cannot do:** catch a *paraphrase*. If someone restates the duty in different
words, it passes. That's not laziness — deciding whether new prose *means* the same thing is a judgement
about meaning, and another ratified rule forbids using pattern-matching to make judgements about meaning.
So the check does the part that's structural, and human review does the part that isn't. That limit is
written into the rule itself, where someone relying on the check will actually read it.

## How we know the checks work

Not by running them and seeing green. A check that passes on a healthy codebase has only proved it
doesn't fire at random.

Each one was proved by **breaking the thing on purpose** and confirming the check catches it *and names
the right reason*. Four separate breakages, each restored afterwards.

That "names the right reason" part earned itself: **the very first attempt didn't compile.** The test
suite never ran at all, while still reporting failure. Judged by pass/fail alone it would have gone in
the books as a proven check that had proved nothing — which is a trap written into our own notes
yesterday, walked into within a day.

## What this doesn't touch

No behaviour changes for anyone using the agent. No new setting, no new endpoint, no new message. Both
checks run in development and continuous integration only; neither can refuse a user's message or affect
a running session. Removing either is a one-line revert.

## Problem three: "we haven't built that yet" quietly becoming permanent

Two rules in the constitution promised more than they delivered. One says an agent must be able to
*structurally* tell whether an instruction really came from its operator — but the actual mechanism is a
convention people follow, not something the code enforces. The other says *every* loop the agent opens
gets tracked until it closes, while the machinery that exists covers several kinds of loop, not all of
them.

The honest fix is to label both as **documented-only**: the rule stands, the enforcement doesn't exist
yet, and the registry says so out loud instead of implying protection that isn't there.

**But the operator attached a condition, and it's the sharp part of this whole batch:**

> "the documented-only MUST force a change in the near future. It can't remain documented only."

He's right, and it's worth spelling out why. An honest gap label is better than a false claim of
enforcement — but *only if it expires*. A permanent "documented-only" is a false claim with better
manners: the registry stops lying about the guard, and starts quietly accepting its absence forever.
Nothing changes; everyone just feels better about it.

So each relabelled rule now carries a **deadline and a tracked id**, and a check turns that deadline
into teeth. When the date passes, the build goes red — and stays red until someone either builds the
missing guard or the operator deliberately picks a new date. Deliberately re-dating is allowed, on
purpose: a check that forced you to choose between a rushed guard and deleting a real standard would be
buying honesty with worse engineering. What it makes impossible is the *silent* version, where a gap
nobody looks at again just sits there for a year.

**One design decision worth flagging.** The new field is registered as *narrative*, not *enforcement*.
A countdown says a guard is **owed**, not that one **exists**. Had it been filed as enforcement, a
promise-to-build would have flipped these rules to "enforced" — which is precisely the over-claiming
this ruling exists to stop. Getting that classification backwards would have quietly undone the ruling
while appearing to implement it.

**A substitution, named rather than slipped in.** The instruction said to register these on the
maturation track. That tracker writes to a file on one machine — invisible to continuous integration,
and invisible to whoever picks this up on a different computer. Putting the countdown in the registry
instead means it's reviewed when it's created, it travels with the code, and it can actually fail a
build. Stronger on every axis that matters, but it *is* a substitution, so it's written down.

**Proved the same way as the others** — by breaking it three ways: a deadline set in the past (the arm
that matters), a relabelled rule with no countdown at all, and a rule that quietly gained a guard but
kept its countdown anyway. Each was caught, each named the right reason, each restored afterwards.
