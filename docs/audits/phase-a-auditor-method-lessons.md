# Auditing guards without fooling yourself — method lessons from Phase A

**Earned 2026-08-04 over ~7h auditing 48 guards on a live agent.** Companion to
`docs/audits/phase-a-constitutional-alignment.md`, which carries the findings. This carries how they
were earned, and — more usefully — **the twelve ways the auditor produced a false result and caught it.**

**The headline number that motivates everything below: twelve times a result looked like a broken guard.
All twelve were the auditor's method. Zero genuine guard failures were found by injection.** Had first
results been reported, the audit would have listed twelve working guards as broken.

## The method that works (~2 min per lint-class guard)

1. **`git diff HEAD origin/main -- <script>` must be EMPTY.** A stale checkout yields a stale verdict.
2. **Baseline run must be exit 0** before injecting. Otherwise you cannot attribute the failure.
3. **Read the detection pattern from source.** Never infer the violation shape from the guard's name.
4. **Inject A (violation) → expect fail. Inject B (compliant) → expect pass.**
5. **Delete/revert, then ASSERT the worktree is back to 0 changes.**

> **B is non-negotiable.** A catch alone cannot distinguish a working guard from one that rejects
> everything. Three guards verified early in this audit lacked a B case and had to be re-run; one of the
> re-runs immediately exposed an error in the *test*, not the guard.

## The twelve false results, by cause

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
