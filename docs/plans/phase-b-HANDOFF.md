# Phase B — handoff for the next Pathway session

## WHERE YOU ARE AND WHAT TO OPEN (read this block first)

> ## ⚠️ WINDOW 8 CURRENT STATE — 2026-08-06 ~21:30 PDT. THIS SUPERSEDES EVERYTHING BELOW.
>
> **~~This file exists in two places, byte-identical.~~ It does not, as of 2026-08-06.** There is now
> **ONE source** — the file you are reading, on the branch — and the agent-home path
> `~/.instar/agents/echo/.instar/phase-b/HANDOFF.md` is a **POINTER** to it, not a copy. It was a
> duplicate; it went stale twice in two hours; *Remove What Demands Attention* was ratified this
> morning and this was its first application. **Do not restore the duplicate.**
>
> **The work lives on branch `echo/guard-effectiveness-observability`. HEAD `b604af33a`, pushed and
> remote-verified.** Worktree: `~/.instar/agents/echo/.worktrees/guard-effectiveness-observability/`.
>
> ### What window 8 landed (all pushed, all verified on the remote)
>
> | item | state |
> |---|---|
> | Three-rung amendment (acts AND holds back) | **RATIFIED**, now rule 4 of the node contract. One source: `docs/plans/node-contract-rung-three-amendment.md` |
> | P1 measure-vs-certify | **WITHDRAWN as a standalone**, folded into *Verify the State* as a Rule clause + tooth (D) |
> | P3 decisions-live-where-checks-can-see-them | **IN**, under *Observation Needs Structure* |
> | P4 remove-what-demands-attention | **IN**, under *Distrust Temporary Success* (NOT under the Root) |
> | P5 dispatch-withholds-the-answer | **IN**, under *Verify the State* (a cousin of tooth D, not its child) |
> | P2 recall-by-meaning | **IN**, under *Intelligence Infers* |
> | B3.1 CrashLoopPauser | **WIRED AT BOOT**, dry-run, now a declared guard |
>
> Registry: 82 → 86 articles, enforced share **0.7195 → 0.7326**. Five new lints, all in the `lint`
> chain, all proven two-sided by injection.
>
> ### 🔴 THE ONE THING BLOCKING GREEN — and it is NOT yours to fix
>
> **`standards-coverage --check` fails on exactly one line: the Substrate family audit is stale.**
> That is BY DESIGN. An external review of the amended family returned **NOT ACCEPTED**, and the audit
> record's `verdict` field accepts only `accepted` — so the constitution refuses to grow while its
> family has open findings.
>
> **Four of the five findings are about PRE-EXISTING articles and are Justin-class rulings.** The
> observer is carrying them up. **Do not draft resolutions. Do not touch those articles. Do not start
> new tree work until the rulings land** (observer directive, 3:25pm cycle). The findings are recorded
> verbatim in the section *"The four open findings — VERBATIM"* below, and in full at
> `docs/audits/phase-b/substrate-family-review-2026-08-06.txt`.
>
> **A PR is open** so review starts and nothing lives only on a branch. It sits red on that one gate;
> that is expected and correct.
>
> ### The exit gate is still PASSED and the kickoff charter is still CLOSED.
> Do not re-run the gate. Do not start a new finding sweep.

**The work lives on branch `echo/guard-effectiveness-observability`, 79+ commits, pushed.**
Worktree: `~/.instar/agents/echo/.worktrees/guard-effectiveness-observability/`

```bash
cd ~/.instar/agents/echo/.worktrees/guard-effectiveness-observability && git log --oneline -3
```

**~~Status: the Phase B exit gate PASSED on round 6. The kickoff charter is CLOSED.**
Nothing is queued.~~** — superseded by the window-8 block above; the gate status holds, "nothing is
queued" does not. Do not re-run the gate. Do not start a new finding sweep.

> **SINCE THIS WAS WRITTEN (09:12) — three commits landed. Read this before acting on "nothing is queued".**
> The charter is still closed and the gate still must not be re-run. What changed is that the operator
> ruled on the five proposed standards, and the placement work is DONE:
> - **`docs/audits/phase-b/standards-placement-verdicts.md`** — all five read against all 82 registry
>   standards under the operator's placement rule. Net: **0 discards · 1 amendment · 4 tree nodes (2
>   admissible, 2 were blocked on the case-study condition) · 0 new root nodes.** Priors were
>   pre-registered first, so the verdicts are scoreable; parentage came out 2 of 5.
> - **`docs/proposals/amendment-verify-the-state-declare-measured-and-certified.md`** — **this WITHDRAWS
>   the standalone measure-vs-certify proposal.** Do not re-propose it as a standard; it is an amendment
>   to *Verify the State, Not Its Symbol*. Re-proposing it is the most likely successor mistake here.
> - **`docs/proposals/standard-proposal-recall-by-meaning-not-word-match.md`** and
>   **`...-decisions-live-where-checks-can-see-them.md`** — the two case studies that unblock P2 and P3.
> - **P2's case is CURRENT, not historical** — measured, not read. The vector path works at
>   `/semantic/search/hybrid`; the endpoint the capability list documents as *the* search endpoint,
>   `/semantic/search`, is keyword-only. **Add to the do-not-re-derive list: a search returning ZERO for
>   real-but-absent words is a word-matcher — a vector search always has nearest neighbours.**
> - **Also do not re-derive:** operationalFacts delivers ~2 of 50 facts at boot (byte cap, trimmed from the
>   END, so the newest fact dies first). A boot pointer recorded there does not reach a fresh session.
>
> **Capacity is the binding constraint as of 14:20:** the account is at ~93% of its weekly allowance with
> ~44h to reset. The manager has closed the remainder of the window to everything except his final cycle,
> the run summary, and the between-windows review. **Do not start new work to fill time.**


**Written:** 2026-08-05 ~15:05Z, window 7, ~11h elapsed / ~13h remaining.
**Written proactively**, before a context ceiling, at the manager's request. Nothing here is urgent —
this exists so that hitting the wall costs a re-read rather than a re-derivation.

---

## DURABILITY — checked, not believed (manager's ruling, 15:23Z)

**Verified by measurement at 75 commits:** local HEAD `==` remote HEAD, working tree clean, and each
required artifact confirmed present **on disk, in the commit, and on the remote** individually.

**The check found two things I had wrongly believed were durable:**

1. `docs/audits/phase-b/tree-review-4.md` — the round-4 gate verdict — was on disk, uncommitted.
2. **The journal (14 KB) was not in the branch at all.** It lived only in the agent home, which is
   **not a git repository** — while the handoff cited it as one of three must-reads.

**That second one is Phase A's own lesson repeating verbatim**, corrected there and reproduced here.
Both are now committed and pushed and re-verified on the remote.

> **Nothing of consequence is now only in my context.** That statement is a measurement, not a belief —
> and the measurement is the reason it is now true rather than evidence that it already was.

## Read these three, in this order. Nothing else is required.

1. **`docs/plans/phase-b-remediation-tree.md`** — leads with an authoritative CURRENT-STATE header.
   **Read the header and trust it over the body**; the body is an append-log and several of its
   sections are deliberately marked superseded.
2. **`docs/specs/guard-effectiveness-observability.md`** — the first build item. Leads with a status
   banner. **Design v3; v1/v2 are in `docs/audits/phase-b/guard-observability-design-history.md`** with
   the reviews that killed them.
3. **`.instar/phase-b/phase-b-journal.md`** — what surprised me, per the node contract.

**Branch: `echo/guard-effectiveness-observability`, 72+ commits, pushed and remote-verified.** Everything
below is on it. The working tree is clean.

---

## The state in one paragraph

Phase B's tree is built and its node premises have been swept: **eight checked, five did not survive**.
The first build item is specified through three design generations and **is not ready to build** —
correctly, and the operator has ruled that no build happens until the spec is approved. The plan has
been through its own exit gate **six times. Rounds 1-5 all failed; ROUND 6 PASSED (COHERENT).**
The gate requirement is MET and the kickoff charter is closed. The second failure was mostly my own repairs.
**Three operator decisions are outstanding** and none blocks work.

⚠️ **This paragraph was itself stale within the hour** — it said "twice" and "two decisions" while the
table below said otherwise, because I updated the table and not the prose. **That is trap #6 on the
list below, committed in the same edit that added trap #6 to the list.** Left visible rather than
quietly fixed, because a successor should know how fast this document rots.

---

## What is IN FLIGHT (this is the part that dies with the session)

| item | state |
|---|---|
| exit-gate rounds | **DONE — R6 returned COHERENT; the gate PASSED.** R1–R5 all failed and each caught something real. **Do NOT re-run it.** Verdicts: `docs/audits/phase-b/tree-review-*.md`. |
| Codey engagement | **DONE** — real scoped work filed with ACK (`ATT-echo-trustbcase-1785942194`), framed as a peer proposal he may decline. |
| memory carry-over re-spec | **DONE** — re-specified against available memory, compressor trend, and pageout *delta*. |
| two items for Justin's list | **DONE** — gate-demotion evidence page (published, current) and the enforcing-mode-never-invoked artifact. |
| two candidate standards | **DONE** — both filed as proposals, deliberately NOT written into the registry. |

**Laptop lanes are intentionally at zero.** The manager explicitly declined to flag this: serial
plan-coherence work does not parallelise. **Do not dispatch lanes to look busy.**

---

## Things I already established — do NOT re-derive these

Each cost real time. Re-deriving them is the most likely way to waste the next session.

| fact | why it matters |
|---|---|
| The memory gate reads **`vm_stat` RAM availability**, never swap (`hostMemoryPressure.ts:119`) | Both the manager and I reasoned from swap and were wrong. |
| `/health` `llmReliability` uses **`sinceHours: 24`, hardcoded** (`routes.ts:3638`) | It says `failing` for broken, idle, AND already-fixed. Do not trust it as current state. |
| `--strict` appears **zero times** in the whole repo | Four lints implement an enforcing mode nothing invokes. |
| **28 of 72** guards can carry a caller-owned counter; the other 44 cannot | Settled by per-guard tracing. `docs/audits/phase-b/guard-verifiability-28-and-44.md`. |
| The constitution's "false claim" is **NOT false** — the audit job runs daily | I reported it twice and a correction PR was sanctioned before I retracted. |
| The trust code is **CORRECT**; only its test's name and comment are false | I escalated this as urgent-adjacent. It is not. |
| **`CrashLoopPauser` IS written and unit-tested** — it is never constructed *at boot* | Phase A said "never constructed"; I repeated it 5× without control. `new CrashLoopPauser` resolves 8× in tests, 0× in `src`. **The remedy is wiring, not building.** |
| `telegram-reply.sh` flags go **before** the topic id | A flag after it becomes message text silently. |
| The reviewer's tree needs `git fetch origin <branch> && git checkout FETCH_HEAD` | Otherwise every cited artifact reads as absent. **Two review findings were this.** |

---

## Traps I walked into — they are still open and will catch you the same way

1. **Writing an expectation into a lane prompt.** I wrote *"(expected: empty)"* and the lane returned my
   own error carrying the authority of execution. **A dispatch supplies the QUESTION and withholds the
   ANSWER.** Now a candidate standard.
2. **Renumbering without listing what is taken.** I fixed a duplicate branch id by creating the same
   collision, twice. `B0–B6` are taken; the new branch is **B7**.
3. **A matching total is not matching membership.** Twice my count matched an independent count exactly
   while the sets barely overlapped.
4. **Reading where I should have run.** Three times. The lanes that *executed* beat the lanes that
   *read*, every time.
5. **Appending under an "authoritative" header.** The header I wrote to stop the plan going stale was
   itself stale within the hour.
6. **Correcting in a NEW section instead of tombstoning in place.** Three gate rounds told me this in
   three different ways: a reader hits the stale text first and the correction second. **Strike it
   where it sits.**
7. **Inheriting a claim from trusted upstream work.** I repeated Phase A's "never constructed" five
   times without running a one-command control. **A finding that arrives pre-labelled as verified is
   exactly the one I stop checking.**

---

## Live positions a successor CANNOT reconstruct from the plan file

The plan file records findings. It does not record **which conclusions are settled and what they cost**,
and a fresh reader will not be able to tell. These four are settled:

**1. The exit gate failed FIVE times, caught something real every time, and PASSED on round 6.**
It was converging, not spinning. **It is finished — do not re-run it.** What finally passed it was not
more care: five rounds failed on the SAME defect (a count kept in four places). Round 6 passed because
three of the four copies were DELETED. That is the window's root finding, below.

**2. TWO of the gate's catches were factual errors I had already reported upward as findings.** The
constitution's "false claim" (not false — the job runs daily) and `CrashLoopPauser` "never constructed"
(written and unit-tested; never wired at boot). **Both had been escalated, one had action sanctioned on
it.** The gate is not polishing prose — it is catching claims that reached the operator.

**3. Instance #14 is the purest example in the whole set.** `crash-loop-pauser.test.ts` has **8 passing
unit tests** for a component that has paused nothing across a **492-consecutive-failure** streak. The
tests measure *"the class behaves correctly when constructed"*; they are read as *"this guard works."*
**A fully green test file is the entire distance between a passing suite and a job nobody paused.**

**4. B3.1's remedy changed and this is easy to miss.** Not "build `CrashLoopPauser`" — it is built and
tested. **"Wire it at boot and verify it pauses a seeded crash-loop."** Smaller job than the plan
originally implied.

## The window's root finding — recorded as a finding, not a reflection

**Proposed as a candidate standard under my name** (manager's ruling, 16:30Z):
`docs/proposals/standard-proposal-remove-what-demands-attention.md`.

> **I could not have passed the exit gate by being more careful.** Care produced five consecutive
> partial fixes. What worked was **deleting three copies of a number instead of keeping four in
> agreement** — removing the thing that demanded attention rather than supplying more attention.

Derived from six gate rounds, five failed identically, while ~4 of the ~14 instances of the defect the
plan was auditing were committed **by me, in the document about that defect.** If diligence were the
answer, the person hunting the defect would have been immune.

## Open decisions — operator's, not mine

> **UPDATED 2026-08-06 (window 8). Two of these three are CLOSED — struck in place, not corrected
> below.** Justin ratified the boundary items at 12:14 PDT (topic 36966). **Only B0.4 remains open.**

1. ~~**The three-rung amendment** (acts / holds-back as two axes).~~ **RATIFIED 2026-08-06.** It is now
   rule 4 of the node contract. **One source: `docs/plans/node-contract-rung-three-amendment.md`** —
   every other mention points here rather than restating it. It is no longer "working practice until he
   rules"; it is the contract. Note the clause the proposal did not have: **a rung-three verdict from an
   A-case alone is `acts-only`, not `aligned`.**
2. ~~**Gate demotion**~~ — **RATIFIED as part of the same boundary approval.** Keep the finding, demote
   the block.
3. **B0.4 — STILL OPEN, and explicitly NOT ratified.** The positional ceiling: 10 of 27 enforcement
   guards cannot be tested from an agent workstation. The window-8 kickoff names it by exception: *"Do
   not size downstream work on an assumed answer."* Nothing downstream can be sized until it is answered.

---

## The four open findings — VERBATIM (window 8; Justin-class rulings)

**Do not paraphrase these, do not draft resolutions, do not touch the named articles.** They came from
an external reviewer dispatched with the answer withheld — it was never told which articles were new,
what was expected, or that acceptance was wanted. Full transcript:
`docs/audits/phase-b/substrate-family-review-2026-08-06.txt`.

> **1. COHERENCE — No.** *Intelligence Infers, Keywords Only Guard* says whether a message is a command
> "**is made by an LLM**" and a keyword/regex list is "**NEVER the decision-maker**." Yet *The Operator
> Channel Is Sacred* says "**a message-CONSUMING decision requires a DETERMINISTIC match, never a
> bare-LLM guess**," and specifically permits pause consumption "**ONLY on a deterministic fast-path
> match**." For benign pause commands, this is an unqualified conflict over who decides.
>
> **2. REDUNDANCY — Yes.** *A Wall Is a Hypothesis*, *Never a False Blocker*, and *Self-Unblock Before
> Escalating* all require inventorying and exhausting existing means before declaring a blocker or
> involving a human: "**first inventory the mechanisms**," "**inventory the means already in hand and
> try them**," and "**Exhaust every unblock path… before requiring anything from a human**." Their
> feasibility/agency/resolution labels do not establish a clear governing boundary for an ordinary
> escalation.
>
> **3. PLACEMENT — Yes.** Several articles are operational engineering controls rather than "facts about
> the substrate," notably *Bounded Blast Radius*, *Capacity Safety*, *Ownership-Gated Side Effects*, and
> *Live-User-Channel Proof Before Done*. Additionally, articles explicitly described as "**A tree node
> under**" another article—such as *Recall Over Our Own Material* and *A Dispatch Supplies the
> Question*—are presented as peer headings, not children.
>
> **4. OVERREACH — Yes.** *Session Input Is a Principal* requires authority to be "**structurally
> distinguishable**," but its implementation admits "**required practice… (acknowledged as willpower
> until the structural fix lands)**." *Close the Loop* likewise claims "**Every loop the agent opens…
> must be durably registered and re-surfaced**," while listing only several example mechanisms and
> instructing "**Where there is no cadence, add one**"; that does not substantiate universal coverage.
>
> **5. GAPS — Yes.** *The Body and the Mind* says learned judgments become structure "**once proven by
> repetition**" and that "**Every decision of consequence**" is recorded, but no article defines what
> counts as sufficient proof, a consequential decision, or the required promotion/audit record. The
> central "moving threshold" therefore lacks a stated governance obligation.
>
> **VERDICT: NOT ACCEPTED** — The family contains a direct decision-authority conflict, overlapping
> blocker standards, misplaced operational controls, and structural claims whose enforcement is
> incomplete.

**Finding 3's SECOND half was mine and is already FIXED** — `scripts/lint-registry-tree-parentage.mjs`
makes a declared parentage claim real (the parent must exist and must name the child back). The
heading-level half is unfixable without breaking the registry parser: it matches `###` exactly, so a
`####` child would silently vanish from the constitution's own accounting — a worse defect than the one
being fixed. **Findings 1, 2, 4, 5 and the first half of 3 are untouched and are the operator's.**

---

## Window-8 traps — these are NEW and they will catch you

1. **Your worktree may run ZERO commit and push gates, while looking fully equipped.**
   `core.hooksPath` is relative and `.husky/_` is generated, not tracked. **Measured: 85 commits on
   this branch went through with every gate inert.** Probe it: `git hook run pre-commit` — a missing
   hook says *"cannot find a hook named pre-commit"*; the main checkout finds and runs it (that is your
   control). **If inert, run them by hand before pushing** — `npm run lint`,
   `node scripts/instar-dev-precommit.js`, `check-rule3-coverage.cjs`, `protect-migration-guarantee.js`,
   `check-e2e-pairing.cjs`, then `pre-push-gate.js`, `pre-push-fixture-guard.mjs`, `npm run test:smoke`.
   Running them by hand immediately caught three real things.
2. **An injection proof can pass for the WRONG reason.** A check erroring on an unrelated bug exits
   non-zero in every case, so the B-cases look like they passed and the A-case failure is the only tell.
   **Assert the specific error string, not `$?`, and always run the A-case in the same harness.**
   Happened once today on the recall-surface lint and was nearly recorded as a proven guard.
3. **The agent home carries a stale copy of the whole source tree, and it greps perfectly cleanly.**
   Your working directory WILL drift if you `cd` to send a message. Today I read a two-month-old
   registry for several minutes; the only tell was that 30 articles did not reconcile with 34.
   **Print `pwd` before trusting any grep of the registry or `src/`.**
4. **A ratified standard's proposed guard can be forbidden by another ratified standard.** P5 nominated
   a phrase-scan; it measured 100% false positives AND *Intelligence Infers* forbids a regex from making
   that judgment. Check a proposed guard against the registry before building it.

---

## What I would do next, in order

1. **HOLD. Do not start new tree work.** Observer directive, 3:25pm cycle: the four findings are
   Justin-class rulings, being presented with recommendations. Do not draft resolutions and do not
   touch the named articles until the rulings land.
2. **Do not re-run the exit gate and do not start a new finding sweep** — both already done, and the
   tree has more confirmed findings than capacity to remediate.
3. **Do not re-propose measure-vs-certify as a standard.** It is WITHDRAWN and folded into *Verify the
   State*. This remains the most likely successor mistake here.
4. **Leave the B0.1 schema spec alone** unless the operator approves it. Four review rounds; the
   remaining gaps are prerequisites (the harness), not defects.
5. **B0.4 is still open and explicitly NOT ratified** — do not size anything against an assumed answer.
6. When the rulings land, the Substrate family audit needs a fresh converged review recorded with real
   reviewers and a fingerprinted report. **Never hand-write that record.** It would make the build pass
   in a minute and it would be a fabricated review inside the constitution.
