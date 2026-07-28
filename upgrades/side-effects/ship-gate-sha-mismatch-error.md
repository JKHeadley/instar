# Side-Effects Review — ship-gate sha-mismatch error becomes self-service

**Version / slug:** `ship-gate-sha-mismatch-error`
**Date:** `2026-05-30`
**Author:** `instar-echo`
**Second-pass reviewer:** `instar-echo second-pass checklist`

## Summary of the change

`scripts/instar-dev-precommit.js` blocks a commit when the staged side-effects
artifact's sha256 differs from the sha recorded in the trace. The old message
("artifact content has changed ... sha mismatch") never printed the correct sha,
so authors regenerated the artifact — whose volatile `Date:` field changed the
bytes and thus the sha — and chased the hash forever (a ~2h grind 2026-05-30,
worst for codex agents). The hook already computes the correct sha to do the
comparison; it just was not showing it. The change prints the recorded sha
(truncated), the EXACT computed sha to write, and the freeze/re-stage/no-amend
recipe. Failure-path text only; pass/fail logic unchanged.

## Decision-point inventory

- sha-mismatch error string in `instar-dev-precommit.js` — modify — turns a dead
  end into an actionable self-service fix; does not change which commits block.

---

## 1. Over-block

None changed. The gate blocks exactly the same set of commits (a mismatching
sha). No commit that passed before now fails, and none that failed now passes —
the comparison is byte-identical. Only the message emitted on an existing block
changes.

## 2. Under-block

None changed. The change cannot let a genuinely-mismatched artifact through; the
`continue` on mismatch is unchanged, so a bad bundle still fails to produce a
valid trace and the commit is still blocked. Printing the computed sha does not
weaken the check — the author still has to actually set it and re-stage.

## 3. Level-of-abstraction fit

The message lives exactly where the mismatch is detected, in the pre-commit
validator, beside the sha computation it already performs. No new module, no new
data flow — the fix uses a value the function already holds.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No LLM, no new authority. This is a developer-experience improvement to an
  existing deterministic gate's error output. The gate's blocking authority is
  unchanged; the change only makes its existing refusal explainable and fixable.
  The printed sha is a checksum of a public review artifact (not sensitive).
