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
