# Side effects — url-log lint resolves split credentialed literals

## 1. Over-block

The dominant risk: this lint fails builds, so flagging correct code is more
expensive than missing a case (a noisy check gets switched off, and then it
guards nothing).

Bounded four ways:
- the fold joins only ADJACENT string literals of the SAME quote style;
- a variable operand ENDS the fold, so no runtime value is ever assumed;
- the fold is bounded to 8 passes and returns the input unchanged if it cannot
  make progress;
- it can only ever JOIN existing literal text — a test pins that the folded line
  is never longer than the input, so the fold cannot synthesise content.

Measured, not asserted: four anti-over-block fixtures were run against BOTH the
shipped lint and the fixed lint and returned identical verdicts. The real tree
lints clean before and after.

Note one verdict that looks like over-block and is not: a hardcoded
`https://user:tok@host` literal is flagged even when the log call redacts it.
That is pre-existing behaviour (the literal branch never consulted the redaction
check) and it is correct — a credential hardcoded in source is a leak regardless
of what happens at log time. Verified identical under the shipped lint.

## 2. Under-block — what this does NOT close

Stated by kind, because the two halves of this lint fail differently:

- **The variable-name half is untouched and still defeatable.** `RISKY_URL_VAR_LOG`
  matches five names through `console.*`. A renamed variable (`originUrl`) and a
  different sink (`logger.info`) both evade it — measured. This is deliberate:
  that pattern matches a SPELLING correlated with the behaviour rather than the
  behaviour, so widening the list makes a finer net and no more of a policy. The
  correct repair is to demote it from decider to candidate-gatherer with the
  weighing downstream, which changes the check's authority and belongs in a spec.
- Cross-line construction (a credentialed URL assembled over several statements)
  is not resolved — that needs dataflow, not a line-scoped fold.
- A credentialed URL arriving from config, argv, or another module is invisible
  to any source-text check.

## 3. Level-of-abstraction fit

Correct layer. A `user:pass@` inside a URL literal is an exact lexical fact about
our own source, which is what a deterministic source lint is for. The runtime
redaction funnel (`src/core/redactUrl.ts`) remains the authority for URLs whose
credentials only exist at runtime; this lint does not and cannot replace it.

## 4. Signal vs authority

Unchanged. The lint holds the same blocking authority it already had, over a
strictly more accurate view of the same prohibited fact. No new authority, no
new decision class, no runtime surface.

## 5. Interactions

None. No other check reads this one's output. The direct-invocation guard is
additive — it only changes behaviour on `import`, which nothing did before,
because the module exported nothing until now.

## 6. External surfaces

None. CI-only. No runtime code path, no API, no user-visible behaviour.

## 7. Multi-machine posture

Not applicable — machine-local by design. This is a build-time check over source
text in a checkout; it holds no state and replicates nothing.

## 8. Rollback cost

Revert the commit. The lint returns to its previous matching behaviour; nothing
persists and no state migrates.

---

## Addendum — CI caught a guard conflict in the TEST, and the fix is a redesign not a workaround

**What CI found.** `Unit Tests shard 1/4` failed on node 20 AND node 22 (same shard both versions, so
not a flake): `SourceTreeGuardError: Refusing to run ... (requested dir:
.../src/core/__urlLogLintProbe.ts, resolved git root: ...)`. The test planted a probe file inside
`src/` so the real lint would scan it, then removed it through `SafeFsExecutor` — and SourceTreeGuard
refuses ANY delete inside the instar source tree (the 2026-04-22 incident class).

**Why it passed locally and failed in CI is the honest part:** I did not establish that, and I am not
guessing at it. What I did establish is that the test design was wrong on its own terms regardless of
which environment surfaces it.

**Two defects in that design, and the second is the one I had not considered:**
1. It performs a destructive operation inside the source tree — exactly what the guard exists to stop.
   Routing it through the audited funnel satisfied the destructive-op lint and walked into a different
   guard. Satisfying one guard is not evidence about another.
2. A probe file sitting at `src/core/__urlLogLintProbe.ts` is **visible to every other suite running at
   the same time**. That is shared mutable state in a shared tree, and it would have been a latent
   flake source for other people's tests, not just mine.

**The fix.** `scanForCredentialedUrlLogs()` now takes optional `srcDir`/`rootDir` that DEFAULT to this
repo, so the shipped CLI behaviour is unchanged. The test scans a throwaway temp tree instead. Nothing
is written into `src/` and nothing is deleted inside the source tree.

### Review answers for this addendum

1. **Over-block.** None new. The CLI path takes the defaults and is behaviourally identical — verified
   by running it before and after the change (`exit 0` both times) and by the real-tree control below.
2. **Under-block.** One thing genuinely got WEAKER and I am naming it rather than letting it pass: the
   defect cases now drive the exported scanner, so they no longer exercise the CLI's
   offender-printing + `process.exit(1)` path end to end. A new test keeps the exit-code path covered
   in the passing direction (`the shipped CLI still exits 0 on the clean tree`), but the failing
   direction of the CLI wrapper is uncovered. That wrapper is eight lines and unchanged by this PR.
3. **New surface introduced.** The scanner now trusts a caller-supplied root. A caller could point it
   at an empty directory and receive a clean verdict — but this is a lint's test seam, not a decision
   authority, and the CLI never passes arguments. Named because "a scan over nothing reports clean" is
   the exact defect I fixed in `lint-no-direct-destructive` earlier this window; here it is reachable
   only by a caller that deliberately supplies the wrong root.
4. **Signal vs authority.** Unchanged — still a deterministic detector with a build-failing exit code.
5. **Interactions.** Removes an interaction rather than adding one: no more shared probe file inside
   `src/` for concurrent suites to observe.
6. **Multi-machine posture.** Machine-local by design — a lint script and its unit test.
7. **Rollback cost.** Revert the commit; the parameters are additive with defaults.

### Evidence

- `tests/unit/url-log-lint-split-literal.test.ts` — **17/17 green** (16 before; +1 for the CLI exit path).
- **Negative control re-run after the redesign, because rewriting HOW a test drives its subject can
  quietly turn it into a check that cannot fail:** removing the fold from the decision makes exactly
  the **3 defect cases fail**, 14 pass both ways. Source restored byte-exact (sha match, 0 markers).
- Real-tree anti-over-block control is now STRONGER: it asserts `scanForCredentialedUrlLogs()` returns
  `[]` under the real defaults, instead of asserting a temp tree with one inert line is clean.
- `tsc --noEmit` exit 0 (run via the real binary — `npx tsc` here is a shim that exits 0 without
  typechecking). Full lint chain exit 0.
