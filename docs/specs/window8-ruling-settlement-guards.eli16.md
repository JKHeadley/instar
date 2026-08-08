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

## Problem seven: the third door, found by someone else

After the exact-match rule shipped, Codey reviewed it — a take-or-decline advisory ask, and he took it.
Verdict: **changes requested.** He was right, and I reproduced every one of his cases before touching
anything.

The rule was supposed to close every door where code decides on its own. I closed two and missed a
third, on a different path. **After any uncertain "pause" result, a separate helper searched the whole
message for a stop-ish word and upgraded the result to "kill".** So whenever the model was reachable
but *overloaded* — which is exactly when things are going badly — code was still killing sessions
based on a word appearing somewhere in a sentence.

What that actually did:

- "stop the build please" → killed everything, not just the build
- "this was a non-stop session" → the word "stop" is in "non-stop" → killed
- "/stop the build only" → killed everything
- **"please do not cancel the review because it is complete" → cancelled it**

That last one is the whole argument. **You said do NOT cancel, and it cancelled.** A fragment of a
sentence cannot carry a "not" — so no amount of tuning makes a word-search safe here.

**Why my own tests didn't catch it, which is the part worth remembering.** Every test I wrote built the
system with *no model attached at all*. Production always has one attached. "No model" and "model
attached but overloaded" are different paths through the code, and only the second reached the broken
helper. **So I proved the rule held in a situation that never happens in production.** A test can be
thorough and still be pointed at the wrong world.

**And five existing tests were demanding the broken behaviour** — one of them named after its own
reasoning ("a kill is recoverable, a missed stop is not") and explicitly insisting that "non-stop"
should kill. That reasoning wasn't stupid; it was a deliberate call, now overruled. All five were
turned around.

**Nothing was lost by removing it.** An exact "stop" is caught *before* the model is ever consulted, so
overload can't swallow it. A non-exact message now gets *delivered to the agent* instead of killed —
which is the safe direction: the agent reads it and decides. The narrow remaining risk is written down
rather than glossed: model overloaded, plus a genuine halt worded outside the list, plus a session too
busy to read it.

Third time this week that green tests were protecting a contradiction instead of a property.

## Problem eight: defining the line between what code may decide and what the agent must

Our foundational rule says code informs the agent, and "past a threshold of importance" it may only
inform, never decide. It never said where that threshold is. So the rule drew a line and gave nobody a
way to find it.

Codey drafted the answer and the good part is that it **isn't a new idea** — it's a promotion of one we
already use. Every spec here already has to label each decision it touches as either an *invariant*
(a closed set: is this string one of five allowed values?) or a *judgment* (what did this person mean?
is this safe? is it ready to ship?). That labelling **was** the threshold all along; nobody had ever
written it down as the rule.

So: below the line, code may refuse malformed input. Above it — what someone meant, which owner to
affect, whether something irreversible should happen — code offers signals and the agent decides and
records why. The emergency-stop floor stays the one narrow, separately-listed exception.

It landed as an **amendment** to the existing rule rather than a new one, which matters practically:
that family is sitting exactly on its enforcement floor, so a new rule without a working check would
have failed the build the moment it was added.

**And it carries an expiry rather than a claim.** No check today proves anyone labelled a decision
*correctly* — only that a label exists and the named decider is wired up. The honest counterexample is
written into the rule: a route labelled "invariant" because its name comes from a fixed list, which
then picks an owner based on who is asking. Bounded on paper, consequential in fact. That's a question
for a human reviewer — explicitly **not** an argument for adding a keyword matcher, which another rule
forbids outright.

---

## The re-review, and the two things it caught me doing (2026-08-08)

I ran the outside reviewer again on the amended families. It rejected all three, and two of the
findings were mine in the area I had just "fixed".

**The first is embarrassing in a useful way.** The operator ruled that the emergency-stop floor may
only match a message EXACTLY — never a prefix, because `stop the build please` is a scoped request,
not a halt. I changed the running code. I wrote the new rule that way. And I left the article next
door still describing the floor as matching anything that *starts with* "stop". So the constitution
said both things at once. Nobody was lying; I edited one article and didn't re-read its neighbour.

**The second is the interesting one.** The old defect was "one obligation, several owners, and no
boundary" — a reader cannot tell which article governs. I fixed three instances of that. Then, fixing
them, I created a fresh one: the article that used to own emergency-stop authority still claimed it,
and the new article said "this article is its whole extent". Two owners again, one day later.

So the fix isn't the text. It's that the ownership boundary is now **registered in a check** — a small
table saying *this obligation, this owner, these articles must disclaim it* — and the check fails the
build if an owner stops declaring, or a disclaimer disappears. I proved it by putting the defect back
and confirming it failed for the right reason, then restoring the file byte-for-byte.

## A hole in a guard I had already built

The same review found an article that formally hands an obligation to another article — and then, three
paragraphs later, gives the order anyway ("must AGGREGATE"). My check verified the hand-off was
*declared*. It never checked whether the article actually stopped commanding.

That is worse than plain duplication, and the reason is the part worth remembering: **a reader who goes
looking for the owner finds the denial and stops looking.** A disclaimer plus an imperative is a
duplicate obligation wearing a disguise. The check now also fails when a deferring article states the
obligation in one of its known order-giving forms — added the way regression tests are, from literals
that were actually found doing it, not from guesses about what someone might write.

## Where I disagreed with the reviewer

It said the token-accounting rule contradicts itself: it permits providers onto a "cannot-surface"
list, while its implementation describes a list that starts empty and may only shrink — so nothing can
ever be added. That would be a real contradiction if it were one list. It's two: one for *call sites
that forgot to tag themselves* (empty, shrink-only, because the debt was paid off when the check was
written), and one for *tools that genuinely cannot report token counts* (not empty, not shrinking,
because that's a fact about the tool, not a debt).

The reviewer was wrong. The ambiguity that misled it was mine, so the text changed and the mechanism
didn't. Worth naming: the honest response to a review finding is sometimes "no, and here is why" —
recorded, so the next reader sees the reasoning rather than the concession.

## Making the tree visible (2026-08-08)

Nine articles in the constitution say, in their own text, "this one sits underneath that one." And
every one of them is printed as an ordinary top-level entry, often pages away from its parent. All
three reviews found this separately, and one named the thing underneath it: the document keeps
asserting a structure it never shows you.

The obvious fix — indent the children — is the wrong one, and the reason is worth knowing. The tooling
counts entries by their heading depth, and several build checks compare those counts against fixed
floors. Indenting nine children would quietly remove nine entries from the count and move every ratio
CI checks. A change meant to help a reader must not move the numbers that decide whether the build
passes.

So the tree is now **generated** from the declarations and printed near the top, and a check fails the
build if that printed tree stops matching what the articles say. You cannot edit it by hand; you edit
the article and regenerate.

**What it deliberately does not claim.** Codey designed this, and the sharpest part of his proposal was
the counterexample against his own idea: someone files a narrow deployment rule under a foundational
one, every mechanical check passes, and *the generated view makes the bad placement look official*. His
answer is the right one — the view is labelled **declared**, never *approved*. A generated tree makes a
wrong declaration more visible, not more correct.

**And one thing I nearly shipped.** The check that catches "this article claims two parents" could not
have caught anything: the code that reads declarations stopped at the first one, so a second parent was
invisible before my check ever ran. I found it by trying to trigger the failure and getting silence.
A guard that cannot fire looks exactly like a guard that passes.

## Naming a gap is where the work starts (2026-08-08, second pass)

Our rules are written as absolutes — "every feature must work on every engine", "every LLM call is
recorded" — and the checks behind them usually cover a slice. We already require each rule to SAY so:
here is what the check measures, here is what it does not. Three separate reviews read those honest
admissions and called them overreach.

They had a point, and it took me a while to see it. Saying "there's a hole here" is not the same as
doing anything about it. A hole that is described politely and left alone is still a hole — and it
reads as candour, which makes it *less* likely anyone fixes it.

So a named gap now needs a date. If the date passes and the gap is still there, the build goes red
until someone either builds the missing check or deliberately moves the date — the same rule the
operator set for rules we relabelled last week, applied one level down to gaps *inside* rules that do
work.

**The part I'd want a reviewer to notice.** The older version of this idea keeps a hand-written list
of which rules need a date. That list has already failed once this week: I added a rule saying "one
article owns this decision", listed the articles that had to defer to it, missed one — and the missed
one kept claiming ownership for another whole review cycle. A list you maintain by hand is a list you
forget to update.

This new check doesn't have a list. It looks for the words "unenforced sub-obligation" anywhere in the
document and demands a date next to them. Write a new rule that admits a gap, and it's caught the same
day, with nothing to remember. I proved that by dropping a fake admission into a rule that no list
anywhere mentions; it failed immediately, by name.

Same lesson as everything else here: the check that depends on someone remembering is the check that
eventually doesn't fire.

## Counting exceptions the wrong way (2026-08-08, third pass)

We allow code to make exactly one kind of decision on its own: when the operator's message is a
word-for-word match against a short written-down list. Everything else goes to the agent. The rule
said "exactly one exception."

The reviewer found a second one — the *pause* path also decides on its own from a fast match — and it
was right that the text said one thing and the system did another. But the fix is not to admit a second
exception. It is that we were counting the wrong noun. There is one *mechanism* (word-for-word match
against a written list), used at two places. Count exceptions by place and the number grows every time
another part of the system adopts the same safe pattern — which punishes doing the safe thing. Count by
mechanism and the sentence stays checkable: something not on the list does not exist.

## Two articles, one phrase, one collision

I wrote that one rule owns "pre-ship evidence validation". Another rule already owned what counts as
evidence a fix works — reproduce the original failure, watch it stop. The phrase covered both jobs, so
both rules claimed the same ground.

They are genuinely two jobs: *what must be shown* and *who may sign it off*. Now each rule owns one and
explicitly says the other is not its business, and a check enforces that boundary in both directions.

## The false alarm that nearly taught the wrong lesson

Registering those boundaries failed with "this article does not exist" — and it does exist. The
matcher didn't handle headings with a parenthesis in them. The quick fix was to paste the full heading
into the check's list, which would have gone green immediately and left the matcher broken for the
next heading with a parenthesis.

Two failures look identical from the outside — "the rule is broken" and "the tool that reads the rule
is broken" — and only one of them is fixed by editing the rule. Worth slowing down for, because the
green build is equally convincing either way.

## Splitting "who decides" from "what may be swallowed" (2026-08-08, fourth pass)

Last pass I said the word-for-word-match rule applies at two places, not one. True, and it created the
next problem: the *pause* path then had two rules claiming to govern it.

The fix was to notice they are answering different questions. One rule owns **may code decide this by
itself, and by what method** — word-for-word match against a written list. The other owns **may a
decision swallow the operator's message**, and its answer is: never on the model's say-so, because a
swallowed message is gone and the model reports high confidence whether it is right or wrong. Those
compose. They only looked like a conflict because one of them was quietly stating both.

A related thing fell out of it. A third rule said the "safe list" exception applies to emergency stop
*only* — while the pause path has always used the same kind of list. So one rule banned something
another rule required, in the same codebase, about the same lines. What justifies the exception is the
**form** (an exact match against a written list, which can't quietly widen), not how bad the mistake
would be. How bad it would be decides something else: whether the message may be swallowed.

## Two things that looked like the same thing

The reviewer flagged nine rules that say "Parent principle → X" as children that were never properly
filed. They aren't. We have two different notes that both use the word *parent*:

- "a tree node under X" — a real structural parent. One per rule, the parent has to name it back, and
  it shows up in the printed tree.
- "Parent principle → X" — which founding idea this rule descends from. It can name more than one.

The proof isn't an argument, it's in the document: one rule carries both, and its "parent principle"
line names *two* roots — which the structural kind cannot do, because a second structural parent is a
hard build failure by design.

Two of those nine did turn out to have a real missing structural parent, and they were declared. The
other seven were fine. The distinction now sits in the printed tree itself, where someone reading it
will actually meet the question — not in a commit message nobody reads twice.

## The same bug, twice, in two different checks (2026-08-08)

A check I wrote reads the constitution looking for rules that admit a gap, and demands a deadline next
to each one. It found the first admission in a rule and stopped looking. So when one rule admitted two
gaps, the second had no deadline and nothing noticed.

I caught it by accident. I added a deadline and the running total didn't go up. The number was the
tell — the check itself said "clean" the whole time.

What makes this worth writing down is that it is the *second* time today. Earlier, the code that reads
"this rule sits under that one" also stopped at the first match, which made a check for "two parents"
impossible to trigger. Different file, different author-sitting, same mistake.

So it's not a slip, it's a default I get wrong: **when something scans a document for occurrences,
assume there is more than one.** The failure is always silent, and silence from a check is
indistinguishable from good news.

## A move I measured and didn't make

Two reviews said one rule is filed in the wrong family. Before moving it I checked what moving it would
do: that family has seven rules, five of them backed by a real check, against a floor of five-of-seven.
Taking a backed rule out leaves four of six — under the floor. The build would go red, and the honest
description of that red is "we improved the filing by lowering the enforcement."

So it stays where it is, with the measurement and a deadline written into it. The move is available the
moment someone builds a check for one of that family's two unbacked rules. That is the right order, and
it is worth naming because the wrong order would have *looked* like progress.

## The thing that was actually wrong, and is now fixed (2026-08-08, fifth pass)

Every review since this started opened with the same complaint in every family: two rules claiming the
same job, so a reader can't tell which one governs. This pass, all three families came back clean on
that. The reviewer listed the pairs and confirmed each one now says which side owns what — and checked
both sides rather than taking the declaration's word for it.

That is the one class of defect that is genuinely closed. It took five rounds, and three of those
rounds found duplications that my own fixes had created. Worth being precise about: the original set is
resolved, and the ones I introduced along the way are resolved too.

## A rule that wasn't approved yet was quietly acting like it was

The reviewer noticed something I would not have. One rule is marked "pending operator ratification" —
it hasn't been formally adopted. And in the tree we print, it sits above another rule as its parent.
So the printed structure was presenting an unapproved rule as settled authority over an approved one.

Nothing was *wrong* in the sense of a bug. It just read as more official than it is, which is the whole
category of problem these reviews keep finding.

The tree now says so, right on that row. And it works out the status by reading the rule itself rather
than from a list I keep — because a list I keep is a list I forget, which is the lesson this session has
now taught me three separate times. I checked it both ways: mark the rule approved and the warning
disappears; put it back and it returns.

Approving the rule isn't mine to do. Making the gap visible instead of letting the layout imply an
authority the rule doesn't have — that part was.

## Changing the question, not the answer (2026-08-08)

Six rounds of review all came back "not accepted", and I had started to wonder whether the bar was
reachable at all. It turned out I had set the bar myself, badly: the reviewer was measuring against
"are there any findings", because that is what I asked it. A document this size will always have
findings. Measured that way, it can never pass, and passing would be suspicious if it did.

The operator's ruling replaced that with something better. Accepted means: the findings are getting
*smaller* — not just fewer, but less damaging to the document's usability as a set of rules — what's
left has been written down as dated work rather than vague acknowledgement, and nothing remains that
makes the rules unusable *today*, like two rules contradicting each other.

The important part of how I applied it: I did **not** take the existing "not accepted" and decide it
really meant "accepted" under the new definition. That would make me both the thing being reviewed and
the judge of whether the review counts. I put the new definition into the reviewer's instructions, gave
it the across-rounds numbers it cannot see from reading one family once, told it that data is untrusted
and to refuse if the text doesn't back it up — and let it answer.

It refused again. And the refusal was worth having: every family failed on the same specific thing —
gaps I had admitted in words but never given a deadline. Not "there are problems." A list. Three of
them, now dated.

That is the difference between a review that stops you and a review that moves you. Same reviewer, same
document, better question.
