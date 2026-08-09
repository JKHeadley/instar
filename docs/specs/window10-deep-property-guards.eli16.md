# Window 10 — teaching the rules to check themselves, in plain terms

## The problem with "tracked"

Our rules say that putting something off is the same as deleting it, unless the deferral is genuinely
tracked. There is already a check for that, and it works: if a document says "we'll do the rest later",
it must carry a tracking number.

But a tracking number is only worth what it points at. Ours point into a list that lives on each
machine separately — not in the shared code. So when the build sees `ACT-1153`, it has no way to look
it up. It just sees that *a number is present*.

I counted. Of 178 tracking numbers written into our specifications, **110 — sixty-two percent — point
at nothing that exists anywhere in the shared repository.** For those, "tracked" was a claim nobody
could check, ever. Which is the exact thing the rule forbids, wearing a badge that says it isn't.

## What changed

The build now asks a different question: not "is there a number?" but "does the number refer to
anything a person could go and look at?" A new deferral whose number points nowhere fails immediately.
The 110 already there are recorded as a debt that can only shrink — because the change that *discovers*
a debt cannot also pay it off.

## What it still cannot tell you

Whether the promise was actually kept. A number mentioned in a test file passes this check whether the
work shipped, stalled, or was quietly dropped. Answering *that* needs the per-machine lists, which no
build can reach. So the honest state is: we went from "a number exists" to "the number refers to
something real", and the last step — did it actually get done — is written down as an unsolved problem
with a date on it rather than implied to be handled.

## The mistake I made proving it

I tested the new check by writing a fake deferral and pointing it at a file I had just created. The
check refused it, and for about a minute I thought I had a bug. I didn't: the file wasn't committed
yet, and an uncommitted file isn't something anyone else can follow. The refusal was correct and my
test was wrong. Worth writing down, because "the check is broken" and "the check is right and I am
wrong" look identical from the outside.

## And one number I checked before trusting

Adding this guard moved our overall protection score up. That is the same signal that caught me
yesterday, when a score rose on an edit that built nothing — so I looked before accepting it. This time
the rise is real: a rule that had no check now has one, wired into the build and tested three ways.
The number went up because something got built. That distinction is the whole job.

## Asking a new rule when it actually bites (2026-08-08)

Our rules say what must be true. Many of them also name the check that enforces them. **None of them
have ever said WHEN the check happens** — and that turns out to be where things go wrong.

The rule we broke on the seventh is the example. It passed every "is there a check?" test. And when I
went looking, there *were* five checks sitting at exactly the right moment — the instant an escalation
gets sent. The gate was switched on. The bad message went out anyway.

Nobody can say why, because those checks don't write down what they decided. We keep a record of a
different, simpler layer, and nothing anywhere records which of the five looked at that message or what
each concluded. So "did it fire and get overruled", "did it never fire", and "did it fire and get it
wrong" are all equally consistent with what we can see. A checkpoint that keeps no log can't be audited
— that's why the failure was invisible for a whole night.

**What changed today.** Any *new* rule added from now on has to state the moments it bites at, chosen
from a fixed list of seven that I counted from the codebase rather than made up: while you write, at
commit, at push, in CI, when a message goes out, on a schedule, or always-on. "None of them" is an
allowed answer — a rule that admits it has no teeth is honest, and we already have machinery that puts
a deadline on those. What's no longer allowed is not answering.

**What it doesn't do**, and this is in the check's own documentation so nobody mistakes it later: it
doesn't verify the answer is *true*. Someone can write down a moment that isn't really where their rule
gets violated. Forcing the question to be asked is not the same as forcing it to be answered correctly
— and a field like this, mistaken for proof, would recreate exactly the problem it was built for.

**One rule already moved off the exemption list.** The deferral rule now carries a real fingerprint,
including an honest note about the two moments it does *not* cover. It could go first because I spent
today building its guard, so I know when it bites instead of guessing. The other 86 need the same
thought, one at a time — the change that introduces a requirement can't also satisfy it 87 times.

**And a note on how this got built.** I had stopped after the measuring step, saying the design needed
more care. A guard in my own system called that out as the familiar excuse it was. It was right: being
careful means doing it carefully *now*, not later. The measuring insight was real; it just wasn't a
reason to stop.

## Making one failure teach every rule (2026-08-08, later the same evening)

The step above forces a new rule to say *when* it is enforced. Justin added the piece that makes that
worth having, and it is the better half of the idea.

When a rule fails even though something was watching, that failure is not really information about
*that rule*. It is information about **watching** — about the shape of hole a violation can fit through.
So we now write the failure down as a *shape*: not "this broke", but "here is how something got past a
watcher, described well enough that you could recognise the same hole somewhere else". Then we check
that shape against every rule that has declared where it is watched.

My own week is the argument. The same shape — a guard that is switched on and doing nothing — showed up
in three separate guards inside two days, and each time I found it fresh, as if it were new. Under this
loop the first one would have gone looking for the other two.

**The part that keeps it honest is staleness.** A sweep is easy to do once and then quietly stop being
true: check a shape against the one rule that exists today, and it sits there looking finished while
new rules arrive unchecked. So every sweep writes down exactly which rules it examined. The moment a new
rule declares where it is watched, every old sweep goes red — you cannot add one without checking it
against every failure shape we know about. I proved that by attaching a declaration to a second rule and
watching all three sweeps fail at once.

**And it caught something the same day it was built.** The shape "switched on and doing nothing" was
swept against the one rule that has declared its watchers — and matched it, halfway. That rule names two
places it is enforced, and only one of them has ever been proven to fail on purpose. The other is trusted
because it has been around a long time, which is precisely the trust the shape exists to puncture. A
lesson from three unrelated guards found a soft spot in the newest one, on day one.

**What it doesn't do**, said plainly because pretending otherwise would rebuild the problem one floor up:
it does not check that a sweep was done *thoughtfully*. Someone can wave at every rule and pass. What is
forced is that each one was actually looked at, in writing, where a reviewer can see it.

**One more thing, and it is a mistake of mine.** Editing a rule changes the fingerprint of the whole
family it lives in, which invalidates that family's recorded review. The previous step did that and I
did not notice, because I skipped the check that would have told me — the same check I skipped earlier
today and promised myself I would always run. Nothing broke publicly, since no pull request was open yet.
The fix is a real re-review, not an edit to the record.

## The reviewer said no (2026-08-08, late)

I sent the evening's work to an outside reviewer and it came back **reject** — six serious findings. That
is the system working, so here is what it found, in plain terms.

The biggest one: **my deferral guard was watching less than half of what it claimed to watch.** The
commit-time marker accepts any label; my check only recognised two specific numbered forms. Of 194 labels
actually in use, 102 were invisible to it. So the honest headline number moved from "62% of deferrals
point at nothing" to **54%** — measured over the real population instead of a convenient slice of it. I
widened the guard and wrote the reason for the reset into the file, because a ratchet you can quietly
re-zero is not a ratchet.

The most embarrassing one: **the check I built to catch over-claiming was over-claiming.** It would have
accepted a sweep that said a rule both has and doesn't have a problem, and it accepted a bare name as an
answer to "did you look at this one?" Both are closed now, and both were proven by making them fail on
purpose.

The most useful one: **it belonged somewhere else.** The registry has a written rule about what qualifies
as a deep property of the model versus ordinary engineering discipline — a rule I wrote — and the reviewer
applied it to my own text and found it failed. It is machinery, readable in the code, so it now lives with
the engineering standards as its own entry rather than as a paragraph bolted onto a different rule.

**And then something happened that I did not plan.** Giving that new entry its "when is this enforced"
declaration made the population it is checked against grow from one to two — and the loop I had just
built immediately went red across the board, refusing to let the build pass until the new rule had been
checked against every failure shape on record. Not a test I ran. The real thing, on its first day,
refusing its own author. If I had to point at one moment tonight and say *that is why this exists*, it is
that one.

What is still not done: the family's recorded review is stale, and a rejection does not turn into an
approval because I fixed the findings afterwards. It becomes a second reading, and the record will say
which reading passed and why.

## Saying "nothing guards this" out loud (2026-08-08, later still)

Three more rules now say when they are enforced. Two of them say **nothing** — and that is the useful part.

*Documentation IS Being* — the rule that an agent's undocumented hour effectively did not happen — has no
guard, and now I understand why rather than just noticing it. Every check we have fires when something
*happens*: a file changes, a commit lands, a message goes out. This rule is broken by something *not*
happening. There is no moment at which "you didn't write it down" arrives to be caught. That is a design
problem, not a backlog item, and writing `none` makes it a dated question instead of an invisible one.

*The Right to Stand Ground* — don't fold to a critique that is wrong — is worse. To catch a violation you
would have to know the critique was wrong, which is the exact judgment in dispute. We do have a check
sitting at the right moment, and I could have cited it and looked greener. I wrote down the refusal
instead, because agreeing too easily and giving up are different failures, and on the wire the first one
looks just like ordinary cooperation.

The third, *Iterative Audit to Convergence*, does have real enforcement — you cannot stamp an audit
"converged" unless the rounds you recorded actually earn it. But there is a hole I had not named: nothing
catches an audit that was never *started*, because the decision that a task needs one lives in my judgment
and no check watches judgment. So the guard binds the careful auditor and is invisible to the careless one.

**And the loop caught me a second time.** Adding those three declarations grew the population it checks,
so every sweep went red again — and this time it matched: *Iterative Audit to Convergence* names a guard
that has never been made to fail on purpose. It is trusted because the code reads correctly. That is the
identical mistake I made four hours earlier with a different guard, found by the identical question. Twice
in one evening, the same shape, the same author.

## I got one wrong, and the check let me (2026-08-08, near midnight)

An hour ago I reported that the loop had caught a second guard making a claim it could not back up. It
had not. I checked, and that guard has thirty-five tests, nineteen of which deliberately make it fail —
one of the best-proven checks in the whole repository. My finding was false.

**Why it happened is the useful bit.** Four hours earlier the identical suspicion turned out to be true,
and what made it true was that I *tested* it. This time the pattern felt familiar, so I skipped the test
and wrote down the conclusion. Being right once about a shape is exactly what makes you careless about it
the second time.

**And my own check waved it through**, because it asked me for a *reason* and reasons are free. So a match
now has to name what I actually ran or read — a test file, an experiment, a line of code — or the action it
triggers. Declining to accuse still costs only an explanation, which is right: it should be cheap to say
"I looked and this one is fine" and expensive to say "this one is broken."

Running total, honestly: one real catch, one false alarm corrected within the hour, and the mechanism
itself firing three times on its own author. A tool that produced a false positive on its first day and
said so is worth more than one with a spotless record, and this false positive paid for a real tightening.

## The reviewer said no again — and this time it found the real hole (2026-08-09, after midnight)

Second reading, second rejection, nine findings. One of them matters more than the rest.

**My freshness check only noticed rules being ADDED, not rules being CHANGED.** It remembered which rules
a sweep had looked at by name. So when I edited a rule's declaration — as I had done hours earlier,
withdrawing a claim that turned out to be false — every stored conclusion still described the old version,
and the check happily said everything was current. My headline promise, that you cannot add a rule without
re-checking it against every known failure, was true only of the word *add*.

It now remembers rules by a fingerprint of their actual text. Change a word in a rule's enforcement
declaration and every conclusion that examined it goes stale. I proved both directions, and then the new
arm caught me for real on my very next edit.

The rest were smaller but the same species: an exemption list that compared sizes instead of names, so a
rule could quietly stay exempt after it no longer needed to be; a stale statistic still asserted in two
places after I knew it was wrong; a four-item list of limitations that I had only written three of; a
"reason" field that would have accepted the word `true` as a reason; and a line declaring a rule's parent
in a syntax the system does not recognise — so it declared nothing at all, while looking exactly like a
declaration. That last one is the whole theme of this week in miniature.

**One finding I deliberately did not fix.** The reviewer says two rules claim the outbound check covers
them without evidence it can. That is a sharper version of a question I had already handed to an
independent machine precisely because I benefit from the answer. Answering it myself now would defeat the
reason I referred it.

Of my six claimed fixes from the first round, the reviewer marked two as held and four as *partial* — real
but overstated. Which is the exact failure this whole stretch of work keeps uncovering, this time in my own
account of having fixed it.

## The referee I hired said no, and then caught me rigging the question (2026-08-09)

Earlier I noticed a rule marked "nothing enforces this" that I thought was actually enforced already — an
unusual direction for us, claiming *less* than the truth. Fixing it would have raised the rule's score
without building anything, and I stood to benefit, so I sent the question to an independent machine
instead of answering it.

**It said no.** The check I wanted to credit only runs its real judgement after a list of seventeen exact
phrases matches first. So the cheap filter sees every message; the thinking part does not. The reviewer
tested that rather than taking my word: it wrote eight sentences that plainly break the rule — asking me
to rotate a key on an account that is mine, asking permission to spend my own quota — and ran them past
both lists the way the code does. **Five of the eight matched nothing** and would never have been looked
at. So the rule stays marked unenforced, which is the honest state.

**Then it found the thing I did not know I had done.** My question was carefully unbiased in the obvious
way: I gave three options and flagged my hunch as a hunch. But buried in the setup I wrote, as if it were
an observed fact, the one claim the whole answer depends on — that the check runs on every message. It
does not. A reviewer who trusted my framing would have said yes, and made exactly the false claim I
convened the referral to prevent.

There is a rule in our constitution for this: when you send someone a question, give them the question and
keep your answer to yourself, because an expectation written into a request does not get tested, it gets
adopted. I ratified it. I then broke it, in the very message meant to protect against bias. **And the
check I built for that rule cannot catch it** — it confirms the question was asked in the right shape, and
my question *was* the right shape. The ritual was present; the property was not.

That is the same failure as everything else this week, in the last place I would have looked: the referral
I set up specifically because I did not trust myself.
