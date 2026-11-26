# Side-Effects Review — Pair the side-effects check to the work, not the wall clock

**Version / slug:** `pre-push-side-effects-freshness`
**Date:** `2026-08-21`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `self-conducted adversarial pass — see Second-pass review (a subagent was NOT spawned; disclosed there)`

## Summary of the change

`scripts/pre-push-gate.js` check 5 refuses a push when the assembled in-flight release
notes claim a fix/feature and no side-effects artifact is present. It located that
artifact by asking "was ANY file in `upgrades/side-effects/` modified in the last 24
hours?"

That question decays. In-flight fragments accumulate across many already-reviewed PRs
until a release cut folds them into `upgrades/<version>.md`. A batch reviewed on Tuesday
therefore begins FAILING on Thursday purely because the window moved — the reviews did
not stop existing.

Observed 2026-08-21: nine fragments in `upgrades/next/`, nine slug-matched artifacts in
`upgrades/side-effects/` written the same day, and the gate refusing every push —
including a documentation-only one — because the newest artifact was ~41h old.

The check now compares the newest artifact against the newest in-flight fragment
(10-minute skew tolerance), and the operator-facing message was rewritten to describe
the rule it actually applies.

## Phase 1 — Principle check (signal vs authority)

**Does this touch a decision point?** Yes. `pre-push-gate.js` check 5 holds real blocking
AUTHORITY — it refuses a push.

**Does the change comply with `docs/signal-vs-authority.md`?** Yes, and it moves toward
compliance rather than away. No authority is added: the gate could already refuse, and
still refuses on exactly the same trigger (an in-flight fragment claiming a fix/feature
with no corresponding review). What changed is the *evidence predicate* behind that
authority, from one whose verdict decayed with wall-clock time to one that is a function
only of the repository's own contents.

The principle's core warning is brittle logic wielding blocking authority. The predicate
here was brittle in the specific way the principle names — it produced confident refusals
from a signal that carried no information about the question being asked ("was this
reviewed?" answered by "what time is it?"). The replacement is strictly less brittle. It
is still a heuristic over filesystem timestamps, and §2 states the residual honestly.

## Correction to the precipitating incident (recorded after the fix was written)

The push refusal that prompted this change came from a checkout 5 versions stale
(v1.3.1180) still holding 9 un-released fragments. On current `main` (v1.3.1185) the
release cut has already emptied `upgrades/next/`, so `inFlight` is false and check 5 is
skipped entirely — that tree was never blocked.

This is stated because the fix's justification must not rest on a misread cause. The
logic defect is real and independently verifiable, and it WILL recur on any tree where
fragments accumulate for more than 24h before a release cut — the normal condition during
an active week. But the acute blocker was staleness, not this defect, and the change is
therefore prevention rather than the remedy it was originally framed as.

## Decision-point inventory

| Decision | Who decides | Authority |
|---|---|---|
| Does an in-flight fragment claim a fix/feature? | `FIX_PATTERNS` regex | unchanged |
| Is the newest work reviewed? | mtime comparison, fragment vs artifact | CHANGED |
| Refuse the push | the gate | unchanged |

## 1. Over-block

**Before:** systematically over-blocked. Any push, of any content, refused once the
newest artifact aged past 24h with fragments still in flight. The refusal named a
remedy — "add an artifact for this change" — that was unsatisfiable, because the change
already had one. The only literal way through was a redundant document.

**After:** the over-block is removed at its source. A fully-reviewed batch passes
indefinitely, because nothing about it changes as time passes.

**Residual:** an artifact touched for an unrelated reason (an edit to old prose) lifts
the bar for the whole batch. Same exposure as before, and strictly smaller — the old
rule accepted ANY touch of ANY artifact as proof for ANY fragment.

## 2. Under-block

The load-bearing question: can unreviewed work now pass?

No. Adding a fragment makes it the newest file in `upgrades/next/`, so it outruns every
artifact and the gate refuses. Verified live (test 2 below): the gate exits 1.

The 10-minute skew tolerance is the one deliberate softening. It exists because a fresh
clone or checkout writes every file within the same instant and their relative order is
arbitrary — without it the gate would fail spuriously on a clean checkout, which is the
same cry-wolf failure in a new costume. Ten minutes is far shorter than the interval
between authoring a fragment and neglecting its review, so it cannot mask a real gap.

## 3. Level-of-abstraction fit

Correct level. The gate already owns "is this shipment reviewed?"; only its proxy for
recency changed. No new concept, surface, or config is introduced.

## 4. Signal vs authority compliance

The gate remains AUTHORITY (it refuses a push) and its scope is unchanged. This change
narrows a false-positive class; it grants no new power and relaxes no existing refusal.

## 4b. Judgment-point check (Judgment Within Floors)

No judgment point added. The comparison is deterministic, with a constant tolerance.

## 5. Interactions

- Per-change enforcement is unaffected: `scripts/instar-dev-precommit.js` still refuses
  in-scope staged files without an ELI16 + side-effects artifact. This check remains the
  release-level re-check.
- Check 3b (release-relevant push shipping no fragment) is untouched.
- CI still skips check 5 entirely (`process.env.CI`).
- Legacy `NEXT.md`-only trees (no `upgrades/next/` fragments) fall back to the original
  24h freshness rule rather than passing on absent evidence.

## 6. External surfaces

None. No route, no config key, no user-visible behaviour. The only surface is the
operator-facing error text, which was corrected in the same change — a message that
misdescribes its own rule is the defect class this repo has been repeatedly bitten by.

## 6b. Operator-surface quality

The message now names the real condition ("no artifact is as recent as the newest
fragment"), points at the specific change needing review, and explicitly forbids both
known cheats: a version-named file, and re-touching an existing artifact to reset a
clock.

## 7. Multi-machine posture (Cross-Machine Coherence)

`machine-local-justification: hardware-bound-resource` — the check reads the local
working tree's filesystem timestamps to decide whether THIS machine's push may proceed.
It holds no state, replicates nothing, and every machine evaluates its own checkout. No
cross-machine surface exists to unify.

## 8. Rollback cost

One function replaced in one file, no state and no migration. Reverting the commit
restores the previous behaviour exactly.

## Conclusion

Ship. The change removes a self-inflicted refusal whose only remedy taught the exact
habit the check's own source comment warns against, while leaving the refusal it exists
to make fully intact.

## Second-pass review

**Required.** Phase 5 mandates an independent second pass for anything with "gate" in it.

**Disclosure:** no reviewer subagent was spawned. A standing session constraint forbids
delegating to subagents unless the operator asks. What follows is a self-conducted
adversarial pass, which is weaker evidence than an independent reviewer and is labelled
as such rather than presented as a concurrence.

**Concern raised — mtime is not authorship time.** A `git checkout`, rebase, or merge
rewrites the mtime of any file it touches. An operation that rewrites a fragment without
rewriting an artifact makes that fragment the newest file and produces a refusal for work
that was in fact reviewed — the same false-positive class this change removes, in a
rarer form.

**Weighed, not dismissed:**
- Frequency: far rarer than the defect being fixed. The old predicate failed on a fixed
  schedule (every batch, every time, 24h after review). This one requires a specific
  git operation that touches fragments and spares artifacts.
- Direction: it fails toward refusing a push, never toward accepting unreviewed work.
- Remedy quality: the remedy it names is still "write a review that is not needed",
  which is the habit this change exists to stop. That is the part that genuinely bothers
  me and is why it is recorded here rather than waived.

**The correct long-term fix** is to read git commit timestamps instead of filesystem
mtimes, which are immune to checkout effects. Not done here: it needs a git call per
file inside a hook that must stay fast, and it is a materially larger change than the
one under review, and it belongs in its own PR with its own review. <!-- tracked: topic-52222 -->

**Verdict:** ship, with the residual named in §2 and above rather than papered over. The
change strictly reduces false refusals; it does not eliminate the class.

## Evidence pointers

- Test 1 — nine reviewed fragments present, gate exits 0 (previously 1).
- Test 2 — temporary unreviewed fragment added, gate exits 1 with the corrected message.
- Test 3 — temporary fragment removed, gate returns to exit 0.
- Population at time of change: 9 fragments in `upgrades/next/`, each with a slug-matched
  artifact; newest artifact `wire-agent-identity-handover.md` (2026-08-20 00:25), ~41h
  old at the time of the observed refusal.
