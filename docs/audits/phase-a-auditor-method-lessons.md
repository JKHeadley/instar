# Auditing guards without fooling yourself — method lessons from Phase A

**Earned 2026-08-04 over ~7h auditing 48 guards on a live agent.** Companion to
`docs/audits/phase-a-constitutional-alignment.md`, which carries the findings. This carries how they
were earned, and — more usefully — **the twelve ways the auditor produced a false result and caught it.**

**The headline number that motivates everything below: SEVENTEEN times a result looked like a broken
guard. All seventeen were the auditor's method. Zero genuine guard failures were found by injection over
eight hours and 51 verified guards.** Had first results been reported, the audit would have listed
seventeen working guards as broken — and once, after 51 clean verifications, would have announced a
false discovery instead.

## The method that works (~2 min per lint-class guard)

1. **`git diff HEAD origin/main -- <script>` must be EMPTY.** A stale checkout yields a stale verdict.
2. **Baseline run must be exit 0** before injecting. Otherwise you cannot attribute the failure.
3. **Read the detection pattern from source.** Never infer the violation shape from the guard's name.
4. **Inject A (violation) → expect fail. Inject B (compliant) → expect pass.**
5. **Delete/revert, then ASSERT the worktree is back to 0 changes.**

> **B is non-negotiable.** A catch alone cannot distinguish a working guard from one that rejects
> everything. Three guards verified early in this audit lacked a B case and had to be re-run; one of the
> re-runs immediately exposed an error in the *test*, not the guard.

## The false results, by cause (12 catalogued in detail; 17 total)

| # | cause | tell |
|---|---|---|
| 1–3 | **Full-repo scan mode skips untracked files** — pass the path explicitly | exit 0 on a real violation |
| 4 | **PATH-ALLOWLIST lint enforces on an enumerated file set** — inject into a listed file | probe file silently ignored |
| 5 | **Guessed the violation shape** (raw `execFileSync` against a lint guarding provider-class construction) | no match, guard "inert" |
| 6 | **Invented an API for the B case** — the real name was in the header already read | B fails, looks like over-blocking |
| 7 | **The edit never landed** — bad anchor made a scripted edit a no-op | looks like the guard rejecting valid input |
| 8 | **Wrong field depth reading a registry** (`retention.access`, not `access`) | zero results from a populated file |
| 9 | **Compile-breaking injection reports `"no tests"`** — not a failure, not a pass | reads as a clean skip |
| 10 | **An untrusted workspace silently skips the hook set** | three "fast" controls that never ran hooks |
| 11 | **Wrong construct entirely** (optional-chaining vs a config `.get()` call) | nothing could have matched |
| 12 | **`node` inside `while read` consumes stdin** — 7 of 27 items processed | a partial sweep that looks complete |

**Standing rule earned from these: a guard that appears broken is mis-invoked until its invocation has
been read from source.** Twelve for twelve.

## Reading a zero honestly — three kinds, only one is safe

A zero would-act counter cannot distinguish a quiet world from a blind detector **unless the guard also
reports how many times it LOOKED.**

1. **"Looked N times, found nothing."** A real measurement — evidence-backed unmeasured.
2. **"Never looked."** (`attempts: 0`) — the evaluation has not run.
3. **"Cannot tell."** No looked-counter — **a blind detector and a quiet world produce identical rows.**

**Minimum honest schema for a guard's runtime row: `{looked, wouldAct, didAct}`.** Two of the three is
worse than none: it makes an uninterpretable zero look like health.

## Classification traps

**A keyword classification is a search aid, never a finding.** It failed three times here, in both
directions: it undercounted an exclusion class 4.5×, it would have invented a problem in the strongest
guards (a well-designed injection test using different vocabulary), and it mislabelled two enforcing
guards as unknown because they exit via a variable rather than a literal.

**Scoping a population by naming convention and calling it a functional tier** is the same error one
level up. `scripts/lint-*.js` is a filename prefix, not an enforcement tier — 27 further guard-shaped
scripts sat outside it. **This survived into a published completion claim.**

**The cheapest error-detector available: when a new classification contradicts a measurement you already
hold, the classification is wrong.** That caught trap #12 and the naming-convention scoping.

## The direction bias worth naming

**Every number that shrank under checking had first appeared in the alarming direction** — a 47%
would-deny rate, "31 dead components", "2 of 2 exclusions dead", "21 dead jobs", "18 orphaned guards".
Each was true-ish and materially misleading; each cost one cheap cross-check to correct.

**The alarming reading is the one that feels like a finding, so it gets written before it gets tested.**

## Corroboration beats repetition

**Re-running the same check is not a convergence round** — it can only find regressions. A real re-sweep
asks *"what did the previous round MISS?"* The re-run round here found nothing and was comfortable; the
what-did-I-miss round retracted a completion claim within minutes.

## Test the proposal, not just the diagnosis

A remedy proposed without being run at the real failing size is a guess. In this audit the diagnosis
(prompt 2.5× over a hard argument ceiling) and the remedy (a buffer-based send) were both proven on the
same throwaway target at the real payload size, six minutes apart. **The contrasting case — a fix built,
tested, reviewed, published and deployed without ever observing the original failure stop — produced no
demonstrated behaviour change and a public release note that had to be retracted.**


## The finding that mattered most, measured on the auditor

**Four documented lessons were repeated within the same session** — the `timeout` command that does not
exist on this platform, verifying an edit landed, full-repo scan modes skipping untracked files, and
relative paths in `node -e`. Each was written down, in this auditor's own journal, before being repeated.

**One lesson was never repeated: journal timestamps.** Seven-plus were fabricated early in the session.
The moment it stopped being a rule and became a ten-line script that stamps the time itself, it stopped
happening — permanently, with no further effort.

> **Every lesson that stayed prose got repeated. The one that became a mechanism did not.**

That is this project's founding principle — *Structure > Willpower* — measured on the auditor over seven
hours, in a controlled way nobody designed.

**Acting on it:** an injection harness (held in the agent workspace pending the proper instar-dev route into `scripts/`) mechanises the five checks that were being forgotten:

1. baseline must be exit 0 (else the failure cannot be attributed)
2. the A edit must be **verified to have landed** (a no-op edit looks exactly like a working guard)
3. A must fail **and** B must pass
4. harness errors (`no tests`, module-not-found, syntax) are distinguished from real verdicts
5. the tree is restored and the restoration is **asserted**

Self-tested against a guard already verified by hand; it reproduced the verdict and enforced every check.
**A future auditor should not have to re-earn these twelve mistakes.**


## The near-miss that matters most: a control you do not need for the story you want

Fifteen of the auditor's false results would have **wrongly condemned a working guard**. The sixteenth
would have **wrongly announced a discovery**, and that is a materially more attractive error to make.

A pre-publish gate demands fresh contract-test evidence when a messaging adapter changes. Verified facts:
it watches four directories, **two of which do not exist**; the largest adapter (≈5,800 lines, the
primary messaging path) sits **outside every watched path**; that file **has changed since the last
release tag**; the gate is **silent**.

After 51 guards with zero defects, "the 52nd is broken" writes itself.

**The control refused to support it.** Committing a change *inside* a watched directory produced the same
silence. So the gate's silence carries no information about path coverage — it evidently requires more
than a changed path, and **a guard you cannot make fire cannot be said to fail to fire.**

> **The path observation is a fact about the code. The defect conclusion is not, and only a control
> nobody would have asked for separated them.**

**Rule: run the control hardest when the finding is one you want.** A negative control protects a working
guard from a false accusation; it protects the *auditor* from a false discovery. The second failure mode
is rarer, more consequential, and far more tempting — an audit that finds nothing is often correct, and
an audit that finds something is always more interesting.


## Check the story you are least attached to — that is where the free evidence is

Five times in one session, running a check that was not needed for the conclusion being pursued produced
something more valuable than the conclusion itself:

| the check that was not needed | what it produced |
|---|---|
| a negative control on a gate that was already "obviously" broken | killed a false first-defect claim after 51 clean verifications |
| re-testing a call already made and half-doubted | upheld it — and broke the emerging belief that re-checking always overturns |
| an empty-index baseline on a search returning zero | revealed the command was hanging, not the vault empty |
| re-reading a claim after the machine changed on its own | falsified a causal chain already reported upward |
| testing a guess about a *second* agent's unrelated silence | refuted the guess and yielded an independent confirming control for the root cause |

**The pattern:** evidence attaches to the checks you have no stake in. A check run to confirm a favoured
story returns what the story predicts; a check run on an incidental question returns whatever is true.

**Corollary, and the harder half:** the direction bias runs one way. Every number in this audit that
shrank under checking had first appeared in the **alarming** direction — a 47% would-deny rate,
"31 dead components", "21 dead jobs", "18 orphaned guards", "the 52nd guard is broken". Each was
true-ish and materially misleading. **The alarming reading feels like a finding, so it gets written
before it gets tested.** The mundane reading feels like nothing, so it gets tested — and survives.


## Five more, added as the sweep widened

| # | cause | tell |
|---|---|---|
| 13 | **A scripted replace whose target string had zero occurrences** — a silent no-op | the guard "correctly" reports clean; lesson #7 repeated after being written down |
| 14 | **Detection keyed on a git TAG diff, not the working tree** — an uncommitted edit is invisible | injection changes nothing |
| 15 | **Wrong file chosen: the watched paths were subdirectories**, the edited file was not inside one | nothing matches |
| 16 | **A claimed DEFECT, not a false failure** — the control refused to support it (see below) | the finding you want, with no control run |
| 17 | **A gate scoped on assembled output, not the input removed** — an existing versioned guide satisfied it | removal changes nothing |

**Nine of the seventeen were a scoping error: the guard's real input surface was not what its name, or my
assumption, suggested.** Reading the detection from source before injecting eliminates all nine.

## Stopping honestly

The sweep stopped with locally-reachable guards remaining. **The reason was that the marginal information
had gone to near zero — 51 verified, 0 defects, and each remaining guard needing a committed fixture or a
version bump.** Ten more require CI context no workstation can produce; ~82 runtime guards require staged
faults or a schema change, and building staged faults ahead of that decision would be wasted.

> **Stopping because the next measurement tells you nothing is a different act from stopping because the
> work got hard. From outside they are indistinguishable, so the reason has to be recorded.**


## Read your deliverable as its recipient before shipping it

Nine commits into this audit, a two-minute read of the report's own first page found its summary
contradicting the tables directly beneath it: *"one proper round has run · 48 guards · 12 false results"*
above ledgers recording four rounds, 51 guards and 17. Rounds had been appended for hours; the top was
never re-read.

**A document arguing that status must be evidence-derived had an asserted summary drifting above its own
derived record.**

The fix is not a promise to keep them in sync — a hand-maintained summary above a machine-parsed ledger
will always drift. **The fix is to state which one is authoritative.** The report now says the derived
tables win wherever they disagree with the prose.

## The one failure mode behind almost all of the rest

Five distinct incidents in this audit, and every one is the same shape:

| the data | where it was |
|---|---|
| job run history | in `job.state`, while the fields being read were on the wrapper |
| a guard's 9 real opportunities | in the `counters` block, beside the `counts` block being printed |
| the LLM root cause, four hours early | in the tone gate's own message: *"degraded to the deterministic floor (provider-error)"* |
| three "fast" controls that never ran hooks | in the banner above each one: *"this workspace has not been trusted"* |
| the report's own contradiction | in its first paragraph |

**None of these was missing information. Every one was already on screen and was not followed.**

> The auditor's dominant failure is not blindness. It is reading something, forming a conclusion from the
> part that confirms it, and never returning to the part that does not.
