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

## Problem four: "we'll mature it later" with nothing to make later arrive

Instar ships risky features **dark** — built, but switched off — and then graduates them in stages. The
rule says dark is a *starting* state, never a finished one. In practice things shipped dark and stayed
there, because the check that asked for a maturation plan only ever **warned**. You could converge a
spec with no plan at all; you'd just see a note go by.

A warning that never blocks is advice. And advice is exactly what "ship it dark and move on" already
ignores — nobody who was going to skip the plan is stopped by a line of console output.

So it **refuses** now. No complete maturation plan, no convergence stamp. It refuses on *structure* —
the section is missing, duplicated, or missing fields — never on whether the plan is any good, which
stays a human judgement.

Three more clauses came with it. A feature graduates on **its own logged behaviour** — what it actually
did while dark, what it decided, when it fired and when it held back — not on a green test suite. That
distinction is not pedantry: we have a component with eight passing tests that paused nothing across
four hundred and ninety-two consecutive failures, because the tests measured "this class works when
someone builds it" and everyone read them as "this guard works." The decision to arm a feature gets
**recorded when it ships**, not whenever someone next remembers. And such decisions have exactly **one
home** — recorded anywhere else, the thing built to resurface them never will.

**Honest about the teeth:** only the first clause is mechanically enforced. The other three are stated
obligations with no check yet, and that is written into the rule itself, so nobody reads the whole
amendment as guarded.

## A bug this change made, and caught before it shipped

The new refusal message lists the required fields — and the variable holding them **wasn't imported**.
That would have thrown an error instead of printing the message, but *only* on the refusal path. Every
healthy case would have passed. Every check would have been green. It would have exploded the first
time someone genuinely forgot a maturation plan — which is to say, the exact moment it was needed.

It was caught by running the failing case rather than reasoning about it. The error path is the one
nobody exercises, which is why it has to be exercised deliberately.

## And one more, found by a canary rather than by me

The list of recognised section names in the constitution turns out to have **two owners** — one used by
the coverage checker, one used by the code that ships the constitution with the product. I added the new
countdown field to the first, everything passed, and then the second refused to build, saying it would
not ship a constitution the runtime would classify as untrustworthy.

That is the same defect as problem two — one thing with two owners — sitting inside the machinery that
polices the constitution. Both are updated here. Merging them is deliberately **not** done in this
change: it is a refactor across a runtime parser, and it does not belong in a batch that is executing
documentation rulings. It is written down instead of quietly left.

## Problem five: who is allowed to stop the agent without asking

The constitution says the agent's *mind* makes every decision of consequence, and that code is a signal,
never a command. It also says a typed "stop" halts everything immediately, and the mind cannot overrule
that. An outside reviewer noticed those are contradictory as written, and asked for the missing rule.

The operator's answer: code may decide entirely on its own **only** when your message is an *exact*
match against a short written-down list — "stop", "stop everything", "/stop". Never a fragment of a
message. Everything else is the mind's call.

**Then measuring the code against that rule found it had never worked that way.** Underneath the exact
list sat patterns matching the *beginning* of a message — and those were what actually fired. So
"stop the build please" and "stop deploying for now" — specific, scoped requests — were read by code
alone as *halt everything*, and killed the whole session. The pause side was worse: "hold on a sec" was
swallowed before the agent ever saw it, even though the instructions we give the model in the very same
file say "hold on" is ordinary conversation.

**And a third layer nobody had mentioned turned out to be a real bug.** Any short message typed in
capitals that merely *contained* STOP, NO, DON'T, CANCEL, ABORT, HALT or QUIT killed the session. Which
means: "NO WORRIES". "OK NO PROBLEM". "LGTM NO CHANGES". "NO RUSH". **Typing enthusiastic agreement in
capitals destroyed the work you were agreeing with.** That was found only because the sweep kept going
past the two layers the ruling obviously implicated.

All three loose layers are gone. The genuinely unambiguous phrasings they caught are now written into
the list explicitly, so the same messages still stop the agent — the difference is that the authority is
a list someone maintains on purpose rather than a pattern that quietly matches more than it looks like.

**The honest cost:** if the model is unreachable, code halts only on the exact list and nothing else.
That is the rule working as intended rather than a regression, but it is a real narrowing and it is
written into the rule itself instead of left for someone to discover.

**One nice thing about how this was checked.** Two deliberate breakages were tried. Putting the prefix
patterns back was caught immediately. **Deleting an entry from the list was not** — the guard checked the
*shape* of the exception but never noticed the list getting shorter, and a shorter list is a weaker
safety net. So a second check was added for that, and re-proved. The breakage that found a hole in the
guard was worth more than the one that confirmed it.

## Problem six: two rules owning the same job, twice more

The reviewers found the same defect as problem two, in two more places.

**One pair was about notifications.** One rule says "don't flood the user — if you're looping over a
hundred things, send one summary, not a hundred messages." The other says "a notice that doesn't belong
to any conversation goes to the one alerts topic, never a brand-new one." Both rules were *also*
restating the other's job, so a reader had two places telling them the same thing and no way to know
which governed.

The split is genuinely clean once you name it: one owns **how many**, the other owns **where**. So the
first now explicitly owns aggregation and the creation budget, and the second explicitly says it does
*not* own aggregation and points at the first.

**The other pair was about runaway loops.** One rule says every repeating behaviour needs brakes —
backoff, a breaker, a cap. The other says a self-triggered action must be *proven* to settle down under
sustained pressure. Those sound alike and are not: the first is what an author fits while writing the
loop; the second is the proof the whole class has to satisfy. Now the first owns the brakes and the
second owns the proof, and each says so.

**The check that keeps all three honest got generalised.** It used to be hard-coded to the single
obligation from problem two. It is now a small table — one row per obligation, naming who governs, who
defers, and what each must say. Adding the two new pairs was adding two rows.

That matters beyond convenience: the reviewers found this defect three times in three different
families. A check that only knew about the first instance would have watched one door while the same
thing happened behind two others. Each row was proved by deliberately breaking it and confirming the
check names *that* row rather than failing vaguely.
