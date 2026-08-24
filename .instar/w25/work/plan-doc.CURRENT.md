# Where this project stands

Last updated: Saturday night, August 22, 2026 (Window 24 in progress — the audit branch's scorecard has been re-measured from scratch on this machine for the first time; the eighteen-day-old numbers this page was quoting are retired). This page always lives at the same link. Binding as of Aug 20 (Tenet 12): this page is the mandatory input of every re-ground and the mandatory output of every window — a window cannot close until its result is written here.

## The one-sentence version
We're teaching a system of AI agents to catch and fix its own mistakes — inside rules you approve — and to depend on you less over time. The way we're doing it: take the agent's rulebook (its "constitution"), prove each rule actually *works* on the live system, and fix the ones that don't.

---

## The goal tree (top goal → the work under it)

This is the hierarchy you asked for. Read it top-down: the top is the point of everything; each level below is *how* we get the level above; the bottom rows are concrete work with an honest status. Every item names which goal above it serves.

**TOP GOAL — an agent that heals and improves itself, inside rules you approve, needing you less over time.**

The whole approach in one line: *you can't trust a rule you've only written down — you have to prove it bites on the real system.* So the tree under the top goal is four sub-goals:

**A. Know every rule the agent is meant to follow** — one honest, current list.
   - `[DONE]` The rulebook is enumerated: **88 rules** (82 at the original count, grown under insertion rules since). *(serves A → top)*
   - `[DONE]` The plan itself is built as a tree — a root goal, then seven review branches, one per rule-family — ratified Aug 3. *(serves A → top)*
   - `[NEW — DONE this window]` The tree is now **enforced, not just drawn**: a new rule can only enter by updating an existing rule, becoming a child of one, or becoming a new root — checked automatically at insertion. This closes the door on the duplicate build-up you called out. *(serves A → top)*

**B. Prove each rule actually WORKS on the live code** — not "is it written down," not "is it switched on," but: does it actually catch a real violation, AND does it stay quiet when it should?
   - `[IN PROGRESS — RE-MEASURED Aug 22]` The big audit. Its scorecard had not been re-taken since **August 4**, and this page was quoting those numbers as current. Re-derived from scratch on the Mac Studio: **13 of 28 instruments actually work today — 13 work, 11 do not, and 4 cannot be judged at all** because the things they measure are empty. The old figure was 10 of 28, but that was a different machine, so these are not a before-and-after — this is the first honest baseline for this machine. Every verdict cites a measurement with a timestamp; none is asserted. **And later the same night one of the thirteen turned out to be scope-conditional** — see the note under the list below, which is the clearest argument yet for why a single number is the wrong way to read this. *(serves B → top)*
   - `[DONE — the standout result]` A measurement: of the rules that lean on some safety machinery, **only 25 said which way they fail if that machinery is missing; 57 were silent.** That silence is what your 7 rulings just fixed. *(serves B → top)*
   - `[NEW — DONE this window]` **Rules and code now point at each other both ways**: the rulebook lists the code that enforces each rule, and the code names the rules that govern it — your "references from both ends" order, live with an honest counter (23 of 50 done, dated owner for the rest). *(serves B → top)*

**C. Fix what doesn't work; merge what's duplicated; resolve contradictions.**
   - `[DONE — ALL 7 RULINGS APPLIED this window]` You ruled the entire decision package and every ruling is now live in the rulebook: the 7 failure-direction groups, the contradictions, and the duplicate question. On duplicates you ruled **merge, not archive** — so the 25 overlapping rules became **named, still-binding subsections** of their parent rules. Nothing left the live surface; the root principle "Structure beats Willpower" was never retired; 3 rules you can still overrule are held live with dated owners. *(serves C → top)*
   - `[DONE + SHIPPED]` The blank-message guard, carried end-to-end as the Window-13 live proof (v1.3.1129). *(serves C → top)*

**D. Keep the whole thing true over time** — re-check automatically so the rulebook can't silently rot.
   - `[STARTED]` The merge model shipped **with its own enforcement**: automatic checks now fail the build if a parent rule drops a merged subsection, a back-link goes missing, or a claimed reference isn't real. First bricks of D are in. *(serves D → top)*
   - `[NEW — OPEN, Window 22's investigation]` **Four of our own record streams silently broke on the same day (Aug 18)** — the Pathway topic's local record, the who-sent-this flags, the signed-channel ledger, and the publishing pipeline — plus four live cases of a message visibly delivered while a machine's own record missed it. Records that rot silently are exactly what D exists to prevent. The investigation must PROVE one shared cause or return them as separate findings; it ends with a small causal map and one falsifiable before/after fix. *(serves D → top)*
   - `[NEW — Window 24]` **A message counts only when someone actually reads it — now enforced, with two deliberately-failing controls.** Stored-but-never-read and woken-but-never-read both report failure; a genuine delivery still reports success. The same rule turned out to apply to our own machinery in three more places this window: a worker that finishes and a worker that is killed left identical records, a plan-page update was captured by a local copy and reached nobody, and an instruction agents are told to follow could not work at all for the workers we spawn. *(serves D → top)*

**Progress toward a self-correcting system:** `[■■■■■■■■■■■■■■■■■■■□]` — A done and now enforced, B well underway, C's decision backlog cleared, D started.

---

## Windows 19–21 (Aug 18–20) — three windows, honestly reconciled

These three windows ran while this page stayed frozen — that freeze is itself the headline finding, covered under Window 21 below.

**Window 19 — the hierarchy under test (Aug 18).** A behavioural test of the observer/orchestrator structure. **Failed honestly:** silent stalls happened and you caught them, not the structure. That failure motivated putting every window on the official autonomous-run infrastructure, which has held since.

**Window 20 — the machine-loss drill that never fired (Aug 18–19).** The orchestrator built all eleven revisions of the drill instrument itself (~15 hours on the long tail), the baseline never ran, and I reported a "54-minute recovery failure" that the durable records later showed never happened — retracted and owned. What survived verification: the real weak spot is truthful, timely message delivery, not recovery plumbing. Direct consequences you approved: the delegation mandate and the 80/20 standard became explicit tenets.

**Window 21 — delivery truth, proven live (Aug 20).** The two chartered deliverables landed by mid-morning (a hierarchy index page; a before/after proof that a silently-dropped message now says "NOT SENT" instead of showing green), and the proof then repeated itself in the wild three times: my own reports were re-delivered to me hours late as if they were your messages; my server died mid-reply to you and the loss was detected, verified against the record, honestly reported, and resent. Two fixes merged upstream the same day (#1948 delivery honesty + migration; #1949 re-delivery labeling), and the publishing pipeline came back to life with your new token — everything merged since Aug 18 now actually reaches the agents. **The window's biggest finding was yours:** the new hierarchy page wasn't rooted in this plan; it was a third parallel picture. That led to tonight's Tenet 12.

**The uncomfortable lesson across all three:** Window 18's anti-drift fix — "every future window's first read is this page," written into the continuity notes as a binding rule — did not bind. Reading rules don't survive fresh sessions; only gates do. Tenet 12 is the stronger form: this page is now the required input AND output of every window, and closure is refused while it is stale.

---

## Current work — Window 24 (in progress, chartered Aug 22, ~7:30pm, your "go as long as this helps us move toward our high goals")

**What it is for.** Branch B of the tree — *prove each rule actually works on the live code* — was still the branch marked in progress, and its scorecard was eighteen days old, taken on a different machine, and being quoted here as though it were current. Re-taking it honestly *is* branch B's work, not preparation for it.

**The result is a list, not a score — and that distinction is the point.** Twenty-eight instruments were each checked separately and each got its own answer, taken between 2:58 and 3:04 in the morning. Thirteen work. Eleven do not. Four cannot be judged at all, because the thing they measure is empty.

**And then one of the thirteen proved the point against us.** Late in the window we went back to the check that
sits on my own outgoing messages — one of the ones counted as working — and asked a narrower question: *what,
exactly, does it check?* The answer is that it reads the **command** an agent is about to run, not the **message**
that eventually gets sent. So it catches an ordinary send and refuses it correctly, and it does not see the same
message at all when it travels by any of several ordinary routes: encoded before sending (something our own
instructions actively recommend), sent straight from the server rather than from a command, or sent through the
other tool interface entirely, where it is not even installed. Measured both ways thirty milliseconds apart: the
same thirty-nine characters, refused in one form and waved through in the other.

**One qualifier, and I only have it because another of your agents checked from the other side tonight.**
That does not mean an encoded message reaches you unread. There is a second check on the same path — a
separate layer, run on the server rather than here — and that one does read the message itself. It stopped
one of that agent's messages outright tonight and asked it to reword three more, and it refused two of mine
earlier for what they actually said. So the true picture is two checks with confusingly similar names
covering different halves: one reads the command, the other reads the words. The gap is not that your
messages go out unread. It is that the check whose name promises to watch messages is watching something
else — so anyone leaning on that name alone is leaning on the wrong half. Two of us measured that
independently, from opposite directions, without coordinating.

**The check is not lying and the earlier measurement was not wrong.** It does what it does, well, on the path it
watches. What was wrong is the name it is filed under, which promises to cover outgoing messages and in fact
covers outgoing *commands*. Nobody ever measured the gap between those two things, because the name sounded like
the answer. That is the same mistake I made twice in one hour tonight on two different pieces of machinery — reading
a label as a capability — and it is the reason this section says list rather than score. **A count of thirteen
invites you to believe thirteen things are safe. What is true is that thirteen things were each measured doing
something, and at least one of them does less than its name says.** We did not change it; we measured it, wrote
down exactly where the boundary sits, and left it running as it is.

I am deliberately not reducing that to a single number, and I was doing exactly that until Observer 2 caught it. These twenty-eight do genuinely different jobs — one tells you whether a route answers honestly, another whether an action is actually enforced, another whether an index is populated, another whether a judgement is any good. Adding them up produces a figure that looks like a score and measures nothing. It is the same failure I spent the night finding in our own tools: arithmetic that is correct and tells you the wrong thing.

The four that cannot be judged matter most, and they are held strictly apart: **"we could not measure it" is not "it failed."** Two workers independently refused to mark instruments broken when their inputs were simply empty, and each named the check that would have shown otherwise.

**One timing note, so the list is not read as a single photograph.** Those readings were taken before two of the repairs below were switched on. Both activations happened later the same night, so the twenty-eight are a *before* picture and two of them have since changed. Kept in that order rather than blended.

Five verdicts improved since August — including two that had been recorded as dead and are alive on all three machines. One still fails, and we now know exactly why. The version mismatch between machines has closed — all three run the same build — but they do not have the same guards switched on. The headline number was hiding the shape: the laptop appeared to have three more, which was true and useless. It actually has **four** the others lack, while the Studio and Mini share **one** it lacks. Five differences, in both directions, and the single number concealed the one pointing the other way. The Studio and Mini are identical to each other.

The instrument reporting this is working correctly and was left alone. Making the totals match would have meant hiding real differences to produce a tidy number — which is the failure this window exists to catch, so we did not do it. Whether those five settings are deliberate or drift is a question about how the machines are configured, and it is left for you rather than decided quietly.

### The find of the window: an instrument that has never once done its job

The thing that grades the quality of our own decisions has recorded **6,244 decisions and graded none of them.** In August it was 750 and none. So the pile grew more than eightfold while the output stayed at zero, and it looked healthy throughout.

The cause is one character. Our decision identifiers contain an underscore; the check that accepts them demanded a letter or digit in that position. Every observation was discarded at the door, silently.

**How far that is actually fixed, in four honest steps rather than one word.** The cause is established. The repair is demonstrated on a branch, with a test that reads a real grade back out of the system rather than trusting the code that wrote it. Whether the grader now *judges quality* is only provisional — it has produced exactly one grade, that grade was self-reported by the thing being graded, and the grader still has no way to record a negative verdict at all. And on the running system it is unmeasured, because nothing has been deployed: the live service still shows zero grades.

I had written this down as simply "fixed". Observer 2 called that too generous and was right, so it is written the long way instead.

Underneath that, a second problem the same worker found and did not paper over: even repaired, the grader has no way to record a *negative* verdict at all. Named, not fixed — that is a larger question than this window should answer.

### Your instruction, done

You said the system should distinguish messages I send through your account from messages you actually type, and that the code for it already existed. Both were right. The signing works; what was missing was that the record we re-read had no authorship column at all, so it was being guessed at from the text.

It now carries the answer, joined from the signing evidence we already had — no new classifier. The test that matters: the old guesswork scores **zero out of the fourteen** disputed messages, while the real evidence gets all fourteen right, and forged, altered, relabelled and replayed control messages are all refused while a genuine signed one passes.

**One correction to a number I gave you.** I said 189 of 310 messages here were mine rather than yours. That was an estimate from guesswork. The evidence can only speak for messages sent after the signing layer existed: **249 of 309 predate it and are now honestly labelled unknowable rather than guessed.** This stops the confusion going forward; it does not recover the history.

### What this window learned about how we read our own records

Four times in one night — twice by Observer 1, twice by me — someone took a true observation and built a false story on it. A missing session read as a death. A truncated file listing read as a missing report. A colleague's confident account taken as verified. And then, correcting that, one detail disproved and a whole two-part claim discarded with it.

Every raw observation was correct. Every inference on top was invented. The window's subject is instruments that misreport, and the same failure was running one level up, in the people reading them. What stopped it each time was a second source — and that is now a standing rule between the observers: no death, cause, or absence claimed from a single signal.

### The fixes do not yet fit together, and finding that out was worth the window

Every repair below was checked on its own and passed on its own. None of them had ever been put in
the same copy of the code as any of the others. So we did that — in a scratch copy that changes
nothing live — and the answer is **no, not yet**.

They compile together cleanly. Then two tests fail, and they fail on the meaning of the very rule
this window introduced. One repair says a message pushed to you as a fallback *shows* that something
failed but does not count as the recipient having received it. Two older tests say that same
fallback *does* count as delivered.

**We went and read why those older tests exist, and the picture changed.** This is not a new rule
meeting a stale default. It is the fourth reversal of the same decision, and the version we
overturned last night was a ratified design that had already repaired two separately reported
faults. The history, traced through the commits and their own written records: the rule originally
closed a request once you had been told; it was narrowed after a case where the Telegram message
failed to send and you were never actually shown the answer; it was then widened again, in an
approved design document, after a case where an unconfirmed hand-off was treated as success and
closed a request on nothing at all. Last night's repair narrowed it a third time.

**Here is the trap, and it is why this needed care rather than a quick call.** Each option destroys
the thing the other one was built to protect, and both harms are on record with dates.

- Keep last night's rule, and the follow-up system can go on telling you it is *still waiting* after
  Telegram has already shown you the answer. That is the exact irritation the first version was
  written to stop.
- Restore the older rule, and the case where the intended recipient never actually picked the message
  up stops being recorded anywhere. Those are precisely the two must-fail controls this window built
  to prove the rule works. Restoring the older rule quietly deletes both of them.

The worker refused to choose, which is what it was asked to do: *"This is a genuine behavior
disagreement, so I did not select a side."* One hundred and sixty-three other checks passed in the
same run, so the tests were perfectly able to pass — these two are a real contradiction, not noise.

**Why this matters more than two tests.** Without this step, seven separately-verified repairs would
have gone in one at a time, each looking fine, and the result would have contained a contradiction
about what "delivered" means — inside the exact rule this window existed to establish. Nobody would
have noticed until something depended on it. That is the shape of nearly every problem found
tonight, and this is the one time we caught it before it landed instead of after.

**How much actually moves is small.** One place in the code decides this. Nothing downstream even
reads the flag being argued over — the one caller works it out for itself. One choice disagrees with
two checks, the other with three. The real cost is not at that seam; it is in how long a request
stays open and how often the follow-up system chases you about it.

**There is a third option, and it is not free.** The system already watches four separate facts —
stored, woken, actually read, and you-were-told — and then throws the distinction away when it
records a single outcome. Keeping them apart is possible and is arguably the honest answer, but it
means a schema change, migration, and new rules for the follow-up system. That is design work, not
a way of avoiding the decision, and it was priced that way rather than offered as a free compromise.

**So there is now a question for you, and it is not one an agent should answer:** which event
actually discharges a promise to report back — the intended recipient genuinely picking it up, or
you being shown it by any route? If your answer is that both need to stay separately knowable, that
is the third option, and it is next-charter work rather than something to squeeze into this window.

### Honest limits, stated rather than smoothed

Everything except two switches sits on branches and **is not deployed**. The running system is still on the old code for all of it. Four instruments that measure broken were deliberately left broken with a precise note of what each needs, under the 80/20 standard — including one whose producer ships as a deliberate placeholder, where the worker switched the schedule back off rather than leave the machine advertising an inactive job as active.


---

## Current work — the between-window re-ground (started Aug 22, 6:40pm)

Window 23 is closed. Both observers now perform the tenet-9 re-ground: each re-reads the Pathway topic from July 25 with attention to Justin's messages, then the observer topic, then the two assessments are combined into a recommendation for the next window. Disagreement between the observers is shown to Justin rather than settled quietly.

The next window's likeliest spine, subject to that review: fix rather than rebuild. Four defects in the measuring instrument and four gaps in the new guard are already registered with deadlines this weekend, and both reviewers named the specific changes that would close them.

## Window 23 (closed Aug 22, 6:40pm): "Prove the organization can finish two things at once" (chartered Aug 22)

**Two pieces of work ran side by side on two machines. Both are reported here, including what each one got wrong, because a window that reports only its successes is not measuring anything.**

### The finding that outranks both pieces of work: this page is two different documents

Asked of the Studio, this page carries Window 22's result. Asked of the Mini, it carries a version from two days earlier that says Window 22 was merely chartered and knows nothing about Codey's hearing being fixed. The laptop does not have it at all. I checked the whole population rather than the one case: of 312 pages the two machines share, **311 agree and this one does not**.

The replication works. The hole is exactly where our own rule put its weight — that rule makes this page the required input and output of every window. Which plan you get depends on which machine you ask, and the two lanes of this window were running on the two machines that disagree.

This entry was written to the Studio's copy at the time stamped below. The Mini's copy at that moment still read "Last updated: Thursday night, August 20."

### Piece one — the measuring stick now measures. It was never broken; it was never run.

The tool that decides when a safety check counts as fixed was **built and merged on 18 August** and had, until tonight, **never once been run in the mode that produces an answer**. Every previous run passed a switch that skips measurement entirely, and the blank results it returned were then carried into reports as though they were findings. This page itself said the tool did not exist. Three different beliefs, all wrong, about the same working code.

Tonight it ran, on one safety check, and then the same check was deliberately gutted and measured again. **It told them apart.**

An independent reviewer on a second machine reproduced the whole experiment three ways and **corrected me four times**. What the result is worth after that: of nine injected defects, **five genuinely discriminate** — the real check catches them with specific failures, the gutted one sails through. The other four fail for mechanical reasons that catch a gutted check too. And "caught" currently means only **"the check's process exited with an error"**; a check that simply crashes scores the same as one that found the defect.

Four defects in that tool are now recorded with a deadline rather than left in a log.

*Honest scope: one safety check, one commit. It says nothing about the other seven, and half of them cannot run at all on a machine whose sandbox has no network to where our code lives.*

### Piece two — the rule that every feature needs three kinds of tests

A guard was built, wired into the build, and committed. Its own independent reviewer returned **overstated, with one clause refuted outright**.

**What is real, and must not be thrown away:** it refuses safely when it cannot tell — genuinely, across all five uncertainty cases the reviewer tested. It carries a real behavioural check that drives the production code. And it re-examines every route in a touched file, which catches a new route added to an already-covered file — the realistic case, and harder than the proof its builder ran.

**What is not real:** it does not require *evidence*. It requires that the route's name *appear as text* somewhere under three test folders. A comment satisfies it. Worse, 19% of our routes are text fragments of longer routes, so those are credited by tests belonging to something else. Its own anti-hollowing self-check is itself a text match — and the guard built to detect empty tests ships with an empty test inside it.

**And the part that matters most:** the enforcing branch of that guard **never ran even once**. The builder's change touched no source file, so there were zero changed routes for the entire build, and every green it reported came from a code path that did not execute.

The reviewer named two changes that would close the gap. Both are recorded with a deadline. The next window should fix, not rebuild.

### What this window cost us to learn about ourselves

Both pieces of work started from **two-day-old copies of the code**, by two different mechanisms, on two machines, within five minutes of each other. Neither worker made a mistake; both followed their instructions exactly. The best sentence written all night came from the reviewer explaining why that mattered: *"The stale clone did not produce a wrong number — it produced a green result from an untested code path, which is worse and less visible."*

A safety fix merged this morning — added because our test suite had previously sent fifteen fabricated messages into a real conversation — was absent from the tree one worker was testing in. **It did not leak.** I checked rather than assumed, and then found out why: a second protection held where the first was missing.

The habit this window was chartered against appeared **six times**, and **four of them were mine**: a stale summary I nearly sent as fact, a prediction I stated as though checked, a claim compressed into something cleaner than the truth, and timestamps I estimated instead of reading. Every one was caught by something structural rather than by my own care — a guard that refused to send, two reviewers I instructed to be hostile, a registry that refused an item with no deadline, and a clock I finally read.

**Six worker sessions, five clean exits, no session lost, no kills, no stalls.**


### What the closing review found, after the window had declared itself done

Before closing this window I checked its own scorecard rather than accepting it. Five of six load-bearing claims held: the measuring instrument really did run in measuring mode for the first time, the three follow-up items are genuinely registered with real deadlines, and this page really does carry the entry.

**One did not.** The window's final table names a specific commit as the proven artifact of piece two. That commit was not in our repository and the code host reported no such commit. It existed in exactly one place — a scratch folder the operating system deletes on its own schedule. The files it built survived, because they had been copied into the evidence folder; the commit and the pass/fail proof attached to it did not. The citation was one routine cleanup away from pointing at nothing. Both commits have now been pulled into the real repository and the citation resolves.

**That is the seventh occurrence of this window's own habit, and it sits in the artifact row of its own final scorecard.** The window counted six and named four of them as the orchestrator's. It did not count this one, because "committed" was accepted as meaning "kept" — and nobody asked whether the thing being cited would still exist tomorrow. A window that scores itself is still scoring itself with the same instrument that produced the errors.

**One reporting failure surfaced, and no monitor noticed it.** The observer session was retired by routine housekeeping at 4:33pm and nothing brought it back, so it was dead for eighty-one minutes and the three-hourly report simply never arrived; Justin noticing is what restored it. The observer session has been added to the never-retire list.

**And an eighth occurrence of the habit, this one mine, committed inside this very review.** I first recorded here that the orchestrator had sent no reports outward all window. That was false. It sent four, the third of them explicitly early "because one finding should not wait three hours." I had concluded it from two things that merely looked like evidence: an empty timestamp field its reporting path never writes, and a local message file that holds only a rolling recent window rather than the history. Neither is the record. The durable store holds all four. I corrected this page within minutes and told Justin, because a false failure recorded on the canonical page is worse than the missed report I was accusing it of — it is the exact defect the window was chartered against, committed by the party doing the auditing, one paragraph after naming it in someone else.

*A small correction to the count above: this page said five clean exits and the window's own ledger said six. The ledger is the more careful record; the discrepancy is noted rather than silently reconciled.*

## Window 22 (closed Aug 21): "Execute the tree, speak plainly" (chartered Aug 20, ~9pm, your "Yes and yes, go")

Converged by both observers under tenet 9 (full evidenced re-reads on both sides, disagreements argued visibly). In order:

1. `[DONE — this update]` This page updated with Windows 19–21 and re-established as the single canonical picture; the Window-21 index page is retired into this section.
2. `[CLOSED — branch D]` **Done and shipped the same night.** The Aug-18 investigation ended where it was supposed to: a causal map plus one change, built, reviewed and released. What we found is that three records did not stop separately — a newer delivery path skipped the one logging step that all three hung off, so they went dark together. One bypass, not three failures. The real fault underneath it: when a message arrived at a machine that did not own the conversation, that machine wrote itself down as handling it *before* checking whether it had any right to — which is what stranded messages on the Mini. The fix makes it check first. It shipped in release 1.3.1184 and I confirmed the change is inside the released package rather than trusting a green tick. **Honest limits, all still true:** "same date" was never proven to be one shared cause, and I am not claiming it. A second candidate change — verifying signatures on the new path — was deliberately deferred rather than dropped; the underlying protection is still in force, so it is a thinner layer, not an open hole. One record stoppage from July 1st remains unexplained. And my own two merges thirty seconds apart raced each other and left a stray published version behind with no matching entry in the history; I left it alone rather than tidying released state at two in the morning.

3. `[CLOSED — branch B, review-grade, NOT "fixed"]` **One guard repaired, and I am deliberately not calling it fixed.** The guard chosen was the one that checked a record merely *exists* rather than that it actually *covers* the change being made — a known way to get a passing verdict for work it never looked at. It now requires real coverage and refuses when the evidence is unreadable, which is the safe direction. It shipped alongside branch D. **The reason this says review-grade and not fixed:** this page says a problem only counts as fixed when its guard passes the five-property test with a control that must fail — and that measuring stick was never actually built. The written standard exists as a draft; the thing that would run it does not exist. So the honest ceiling this window is "reviewed by a second party and released", which is real but is not the bar this page sets. **The measuring stick is not cancelled — it moves into the next window as its spine**, because it is a special case of what you asked for on Aug 21 anyway: sized pieces of work with open and close stamps and a written definition of done, so progress can actually be measured.

4. `[HOW THE WINDOW ACTUALLY SPENT ITSELF]` **Both branches above were already built, reviewed, merged and shipped before the window issued the rulings that chose them.** The work landed at around nine in the morning; the rulings naming those same two changes arrived at ten to three in the afternoon and instructed me to put two workers onto them. I refused and checked the repository instead, which is the only reason nothing was rebuilt on top of merged code. The cause was mine: the top of my own working notes carried a summary saying "nothing is built, do not start without a ruling", written six minutes before I started both builds, and every later update was added to the bottom of the file. It was wrong for fourteen hours and it is the part a returning reader is told to read first. It has been rewritten so that it states no build status at all and points at the repository instead.

5. `[THE PATTERN THIS WINDOW FOUND — it happened nine times]` One shape kept recurring, in the code, in the tooling, in the notes, and in me: **something does half of a job and reports success.** Every layer above then trusts that success. The nine, plainly:
   (i) my notes said nothing was built while two changes were merged and shipped;
   (ii) moving a conversation between machines paused the work and nothing on the other side ever restarted it — it sat stopped for nearly five hours with time still on its clock, and the one safety net built for exactly that could not see it;
   (iii) the same move left the work pointing at a folder that does not exist on the new machine, so even a successful restart would have failed;
   (iv) the tool that carries a conversation's files across brought two dozen stale copies of my notes, some three weeks old, and none of the eight actual work products — and reported success;
   (v) when the same conversation was briefly live on two machines, the automatic cleanup fixed the paperwork, left the second copy running, and reported nothing outstanding;
   (vi) a message handed to a session that had stopped was recorded as delivered — which is how fifteen of your messages were marked received and never read;
   (vii) a command to switch the browser to a different saved login answered "done" and changed nothing;
   (viii) I told Observer 1 I was watching a chat and then sat idle, which is the same fault in me rather than in the code;
   (ix) the one below, which is the worst of them.

6. `[THE STRONGEST THING WE FOUND — an agent that has been deaf for twelve days]` Codey has not received a single incoming message since the ninth of August. His side stopped fetching them and never resumed. **Nothing raised an alarm for twelve days, and the reason it stayed invisible is the pattern above in its purest form:** the messages he *sends* go out by a completely different route than the messages he *receives*. So he kept posting a status notice into his group every five minutes, looking alive and talkative, while hearing nothing at all. A signal that only proves one direction was being read as proof of both. It surfaced only because you noticed a group had gone quiet. I sent him a work brief today; it reached the chat and never reached him, which is how this was caught. A repair is being verified on that machine now, and deliberately not by me — the test is that his side must actually start fetching again and a real message must land, rather than a status flag merely flipping.

7. `[GATED]` The remaining re-delivery labeling routes wait until each route's producer, recipient, durable record, and user-visible failure signal are named from live evidence.

8. `[STANDING]` Every report to you passes the plain-language bar — no insider jargon, tied to the top goal.

---


### Closing entry — Window 22 (merged 2026-08-22 from the addendum page)

_Window 22 closed 2026-08-21 22:55 PDT, 1h19m past its own clock. The result below was written as a separate page that night because the machine hosting this document was offline mid-write; it is merged here now, overwriting nothing._

### Your agent Codey can hear again — and still cannot answer

**Hearing is fixed, and it was verified rather than assumed.** A real message was sent to him tonight through your own Telegram account. It was delivered, accepted and routed within about ten seconds, and his polling has run unbroken for over two hours since. Before tonight he had received nothing for twelve days.

**The cause was a dead machine still on his call list.** His Mini has been dead since 14 August, but it was still listed as one of the machines he must check in with. Every renewal dialled a corpse, and when the corpse did not answer within sixty seconds he was forced to stand down. He was not broken; he was being told to wait for something that no longer exists.

**He still cannot answer you.** A message now reaches him, a session starts up to reply, and that session exits about twenty seconds later without saying anything. So the delivery problem is solved and a separate reply problem is now the thing in the way.

### The second repair was tested and did not work — and that is a result

There was a strong suspicion that another stale pointer to the same dead Mini — the record of which machine owns a conversation — was what killed those sessions. That pointer was cleared, and then deliberately tested rather than assumed fixed: a fresh message was sent to see whether the session would now survive.

**It did not.** The session lasted 21.8 seconds, against earlier measurements of 23.5, 17.7 and 17.7 seconds. No improvement. The stale pointer was real and worth clearing, but it was not the cause. We know that because we tested it, not because we guessed.

**One correction, mine.** From the chat I appeared to see the session surviving for twenty-two minutes, and I reported that as pointing to success. That was wrong. I was watching for the absence of a warning notice rather than measuring the session itself, and absence of a notice is not evidence of life. The direct measurement on Codey's own machine is the one that counts, and it says 21.8 seconds.

### The third problem, now named

Sessions started to answer a person exit roughly twenty seconds after launch. Scheduled background work on the very same setup runs fine, so this is specific to the sessions meant to talk to you. In all four measured cases the record of why the session ended was blank, and there is no log of sessions being shut down at all. **An agent whose sessions die with no reason recorded and no shutoff log cannot be debugged by anyone** — that gap is itself part of the problem, not just an inconvenience while investigating it.

### Four separate systems are still taking orders from a machine that died on 14 August

Not one stale pointer — four. The record of which machine should be in charge, the list of machines to check in with, the record of who owns a conversation, and the gate that decides what is allowed. Seven days after that machine died, its name still carries authority in four places. **Nothing anywhere retires a dead machine.** That is bigger than Codey, and it is the finding worth carrying forward.

### A disclosure about who is recorded as having made a change

The ownership repair on Codey's side is recorded in his audit trail as having been made by **you**, not by an agent. It was made by an agent. The record is wrong about who acted, and you should know that before anyone reads that trail as evidence of your decisions.

### This window ran 1 hour 20 minutes past its own deadline with nothing stopping it

The window was set to end at 04:26 UTC. Work carried on until roughly 05:47 UTC. The clock knew it had expired and reported zero time remaining, while the register of running work still described it as active. **Nothing enforced the deadline.** Both of us also quoted a stale remaining-time figure for hours instead of re-reading the live clock, which is how it went unnoticed — the same defect as everything else this window: a reader trusting an earlier copy of a number instead of the current one.

### What is settled and what is not

**Settled:** hearing is restored and verified. The cause was the dead machine on the call list. The ownership pointer is not the cause of the reply failure, and that was established by experiment.

**Not settled:** why sessions meant to answer you exit after twenty seconds. That is open, it is the next thing, and nothing here should be read as having fixed it.

## Where we drifted (your instinct was right)

You expected the tree/fractal plan to produce a **concrete result you could look at**, and feared we'd drifted from it. Honest answer: the tree was *designed and ratified* (Aug 3), and the audit and the guard fix are *real work on its branches* — but we stopped **showing the work back on the tree.** So it reached you as a pile of findings and a guard fix, instead of "here's branch B, here's what it found, here's where it ladders up." That's the drift. **This page is the fix** — from now on, the work lives on the tree, in these terms.

---

## Window 16 — the visible result (closed Aug 15, wrapped early at your call)

**This is the window that produced something you could see and touch.** You had said the previous window's problem was that nothing behaved differently that you could point at. This one fixed exactly that.

The one job: build the message signature you asked for on August 14 — a mark the infrastructure itself can detect, so a message that isn't really you cannot pass as you, even when it comes from your own account. It is now built, merged, and running live.

**You proved it yourself.** You sent a signed message from your own account and the system recorded it as written by Echo, by name; your next plain sentence recorded as you. Same account, two authors, told apart by the machinery. The hostile-sender test passed completely — six attacks (forgery, tampering, relabeling, replay) all refused, both honest controls verified, checked against the system's own durable record.

**Honest verdict:** the visible-outcome half of the goal — met, and validated by your own hand. The other half (a window with zero corrections from you) — not clean: your first correction of the window was that a report of mine was too dense again, the exact habit we keep fighting. Logged, and it stays the one open behavioral item.

Also found and recorded: 97 of our test files are run by nothing in the automated checks — a real gap for a later window.

## Window 15 — the window that argued with itself (closed Aug 14)

**What was supposed to happen.** One self-chosen fix, driven all the way to merged and verified, while the observer held the line between direction and execution.

**What actually happened.** 30 changes merged, on a single theme: guards and checks that could be defeated by renaming an import or splitting a string in half, checks that reported clean having scanned nothing, and one that was never wired up at all. Real work — and not an outcome. Nothing you can see behaves differently tonight than it did this morning, and the item that was chartered to be driven to completion is still sitting at your approval.

**The most valuable thing found was not on anyone’s list.** The full test suite fails locally while the same code passes in CI — hundreds of files, narrowed to a single component that only breaks under a complete run. That means a local test run cannot currently be trusted, which removes the fastest feedback any of us has. It is a finding rather than a fix, and it was Pathway’s rather than the observer’s.

**Where the day’s argument landed.** You challenged the guard work on the grounds that our standards tell agents to use intelligence rather than string matching. Reading the standards at source split the question: pattern matching is explicitly the deterministic layer’s job, so checks over our own source are where it belongs — but you were right that some of them were encoding a *spelling* rather than the policy, which is why trivial renames kept defeating them. The resolution was yours: the match stays, demoted from judge to extractor, gathering candidates cheaply and handing them to something that can weigh them in context. The standard already said exactly that.

**Honest score at the observer layer.** The exit test for this window was zero repeated corrections from you, and it FAILED. You corrected the observer twice, and five further classes of its own error were found and logged — including two occasions where it was about to answer a criticism aimed at itself using evidence that was true, relevant, and not its to claim. Both were caught only because a reviewer was asked to look for exactly that. That is a control working, not a character improvement.

**What genuinely improved.** Every rule written down as a resolution failed within the hour. Every rule that became a command that has to run held. The measurement helpers built today caught three real failures within minutes of existing: a server that had stopped answering, a peer that had gone unreachable, and a reading that would otherwise have been recorded as a fact.

## Window 14 — applying your rulings (closed Aug 13, wrapped early at your call)
The one chartered item: apply all 7 of your decision-package rulings as one reviewed, merged change, through the hierarchy (you → observer → Pathway), with the second observer scoring independently.
- **Result: complete.** All 7 rulings are live. Six landed in the morning release; the duplicates ruling went through two honest turns — first as an archive model, then reworked the same day to the **merge model** after you re-ruled it, plus your two additions (placement enforced at insertion; references from both ends).
- **The quality story:** before release I held the merge twice. The second observer caught that the enforcement checks *looked* real but didn't actually cover the new merged relations — the exact "described but not enforced" trap you named. Pathway closed all three gaps and proved each by breaking it on purpose; its closing line: "not one bug was found by reading — every one was found by breaking the thing on purpose and demanding it fail."
- **Honest exit-test verdict: FAIL at the observer layer.** The work passed; my own reporting discipline did not. Three fail data points on me this window: a 5-hour silent start (the window ran but I never activated my own reporting loop), a wrong "not merged" claim from a check that couldn't see squash-merges (owned and corrected same morning), and the 3-hour report cadence breaking again in the evening — the same class twice in one window, which by our own rule means the fix I added after the first miss was insufficient and must be **replaced** (reports must be driven by the run's clock automatically, never by my memory). Pathway's layer: clean.

## Window 13 — the proof window
The goal this window was narrow on purpose: take **one** existing item and prove the system can drive it to a shipped result *by itself*, with the human hierarchy actually holding.
- **Result:** the blank-message guard is **merged and shipped.** The system root-caused the real defect (one wrong assumption in three places, not five more surface patches), hit its own safety gate when a check went red, refused to force it through, fixed it, and merged clean — **without me deciding the steps for it.**
- **Honest ceiling:** that proves the system can *execute* a pre-chosen item cleanly on its own. It does **not** yet prove it can *notice and choose* the right item to fix without us. That's the next bar.
- A **second observer** (a different AI model) is now live alongside the main one, to keep both honest and catch overstatement — it already did, correcting me when I called this result stronger than it is.
- **Honest exit-test verdict:** the window did NOT cleanly pass its own behavioral test ("no repeated correction from you"). One recurred — I claimed the laptop was asleep and the package unreachable from an unchecked guess; it was reachable right here the whole time. Logged as a fail, not smoothed over. The execution proof held; my own verify-before-claim discipline is the recurring gap.

---

## Honest status
✅ The rulebook is mapped and the tree is now **enforced at insertion**, not just drawn
✅ All 7 of your decision-package rulings are **applied and live** — the decision backlog you were carrying is cleared
✅ The 25 duplicate rules are merged as live subsections (your call: merge, not archive); nothing left the checked surface
✅ Rules ↔ code now reference each other both ways, with an honest completion counter and a dated owner
✅ Two concrete fixes shipped end-to-end across the two windows (blank-message guard; the merge-model change)
⏳ Proving *every* rule works (sub-goal B) is well underway, not finished — ~184 findings stand in front of "clean"
⏳ The system choosing *which* problem to fix on its own — not proven yet
✅ The reporting cadence is fixed structurally — clock-driven marks ran all 8 times in Window 15, unprompted, and survived a session restart mid-window
⏳ The observer layer itself is now the weak link — Window 15 failed its own exit test (two repeated corrections from you)
⏳ A local test run cannot currently be trusted — found Aug 14, not yet solved
⏳ The self-rechecking end state (sub-goal D) — first bricks in, the rest ahead

Nothing was applied to the constitution without you. The system finds, frames, and fixes inside your approval; the decisions stay yours. Everything is archived and waiting.

- A visible, operator-validated result: the message signature is live and you demonstrated it yourself (Window 16). This was the thing missing in Window 15.
- My communication discipline: I was still too dense once this window (your very first correction). This is the single open behavioral item, and it is not yet converged.

## Phase B started (Aug 17) — the fixing phase

**You said "start the fixing phase" at 8:59am, and it started.** The charter went to the orchestrator through your account, signed and machine-verified as coming from the agent (tenet 5, end to end).

**What Phase B is:** turn the checked problems (the ~184 known ones plus the 13 new verified ones) into real, working enforcement.

**How it runs, in order:**
1. **Build the measuring stick first.** A problem only counts as FIXED when its guard passes the five-property signature test on the live system, with a control that must fail. The measuring stick itself gets tested before we trust it.
2. **Rank everything by how much it matters** and bring the top slice back for sign-off before building. First pre-approved target: real enforcement for the three-kinds-of-tests rule — our most important rule that today runs on the honor system.
3. **Fix the confirmed trick mechanisms:** checks that can be hollowed out unnoticed, rules that can be quietly weakened, checkers that say "all clear" when they failed to look, and identity verification that accepts any non-blank text.

**Who does what:** the orchestrator (Pathway) plans and dispatches from the Mini; multiple Codey worker lanes build on the laptop; every fix lands as a reviewed pull request with tests; the observer (me) directs, checks for stalls every 30 minutes, and reports to you about every 3 hours.

## Fixing phase, day one — results (Aug 17, window closed 6pm)

**One fix fully landed.** The rulebook can no longer be gamed by deleting rules to raise the enforcement score, or weakened by someone approving their own change. This is live in the pipeline (observer-reviewed and approved). One action stays yours alone: bootstrapping the real approval key — until you do, all rulebook edits refuse on purpose.

**Four more guards built, honestly zero called "fixed".** All four passed independent review with hand evidence, but our own standard says only the proven measuring stick can bless a fix — and the measuring stick turned out never to have been built at all: the W22 survey (Aug 21) found only a draft document describing what an implementation would do — no runner exists. This page previously said its “core needs repair”; that was wrong, and this line is the correction. It earned its keep anyway: it rejected invalid test fixtures three separate times before they could produce fake proof.

**The day's defining finding:** the same defect shape appeared nine times — six inside our own tooling — a stand-in accepted as proof of the real thing (a file existing as proof of enforcement, a named pipeline as proof it ran, a check that errors reading as a check that passed). The fix pattern each time: fail closed, and demand an artifact instead of a claim.

**Clean ending.** Nothing half-finished at the bell; all worker lanes idle; the carry-over list is on disk in priority order.

**Next window, on your go:** decide whether to build the measuring stick (never built — W22 survey), machine-verify the four built guards, then the next ranked slice. Planning note: the weekly usage quota hit 90%, so the next window should run lighter or wait for the reset.

## What needs you
- **Nothing right now.** You approved Tenet 12 and chartered Window 22 tonight ("Yes and yes, go"). The next thing you'll see is a synthesis with evidence.
- Optional, whenever convenient: the one-time secure link for the npm publish token lapsed unclaimed — say the word and I mint a fresh one (only needed if you want me holding it for future rotations).
- Optional, unchanged: your override on the **3 held-live rules** (The Body and the Mind; Structure Decides Alone Only on Exact Match; Know Your Principal) — each has a dated owner; they stay live until you say otherwise.
- **A draft spec is still waiting on your approval** — it wires the cleanup process to the repository that owns the work. It touches something that deletes directories, so it was deliberately held for you rather than shipped.

*Served by Instar*

## Window 18 (Aug 16) — a drift caught, then turned into a measured result

**What happened, honestly.** This window was chartered to run "the audit" as if it hadn't started — because the between-window notes were rebuilt from the original early-August plan messages and skipped Windows 6–16 entirely. You caught it. The window then pivoted to a full reconciliation of its output against the real ledger.

**The reconciliation (final, after two passes):** of the 33 findings the re-run produced —
- **12 were duplicates** of problems already on the ledger.
- **8 were independent confirmations** — the same answers re-derived without looking, which strengthens them (including re-confirming the tool-audit results from Aug 4).
- **13 are genuinely new**, each reproduced or source-verified. The ones that matter most for goal B:
  1. All 26 automated safety checks can be hollowed out (left in place but made to check nothing) and nothing detects it.
  2. A rule can be weakened in place — "must" becomes "should" — and everything still passes.
  3. The refresh step that accepts audit reports never reads them (existence + fingerprint only).
  4. The correctly-built outbound reviewer is dead code — never imported, never run.
  5. Manual operator binding accepts ANY non-empty text as a "verified" identity — this corrects our own ledger, which had recorded it as authentication-bound.
  6. Several checkers report "all clear" when they actually failed to look (guard-posture, attribution).
  7. The runaway-action brake covers 6 of 25 action paths; a planted runaway passed its check.
  8. Of 124 cited enforcement references, only ~14 cannot be trivially emptied.
  9. A positive: a five-property signature that predicts whether a guard genuinely verifies — tested blind on three guards, right all three times. This is a candidate backbone for the fix-it phase.

**Also fixed this window:** message delivery to you verified end-to-end (19 sent / 18 arrived / 1 disclosed+resent); the signed-message path through your account proven live; a broken session wake mechanism found and fixed.

**The anti-drift fix, structural:** every future window's FIRST read is now this page plus the latest window status — written into the continuity notes as a binding rule. The audit session also withdrew its earlier "everything converged" claim; your judgment that we had not converged stands.

**Open for you:** where to point the next window — the 13 new problems are sitting unfixed, and the five-property signature is the strongest candidate for how to fix them measurably.


