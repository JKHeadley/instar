# Side-Effects Review — ratchet the standards enforced-ratio floor 0 → 0.64

**Parent standard:** Structure beats Willpower (the constitution's root) — a measurement nobody can regress
is worth more than a measurement someone must remember to check.
**Files:** `scripts/standards-coverage.mjs` (one constant + its comment).
**Not a feature.** No flag, no route, no config key, no migration. A committed floor moves.

## What changed

`FLOORS.enforcedRatio` default: `0` → `0.64`. The surrounding comment is rewritten to record why, what the
measured value was, and the cross-implementation discrepancy found while choosing it.

This is the action the script's own comment asks the next person to take: *"Ratchet this upward (a visible
PR diff) as the documented-only set shrinks."* It shrank **34 → 24** on 2026-07-30, as ten standards whose
guards already existed gained resolvable citations (#1762–#1766, #1769, #1771–#1773).

## Blast radius

**Exactly one consumer.** `FLOORS` is read only by this script's own `--check`, which runs as the
`standards-coverage` job in `ci.yml`. Nothing else imports it; no route, no runtime path, no agent behaviour
reads it. A fleet agent never executes this file.

**It cannot fail a build that does not regress.** The repository measures **0.6543** today against a
**0.64** floor. Every build whose ratio is at or above today's level passes exactly as before. The only
builds it can newly fail are those that *lower* the ratio — which is the entire purpose.

**What it will newly fail, stated plainly so it is not a surprise:** a PR that adds a constitutional standard
without a resolvable guard citation, or removes a guard file a standard cites, far enough to drop the ratio
below 0.64. On today's 81-standard denominator that is roughly one standard of headroom. **That failure is
the intended signal, not a false positive** — and the message names the floor and the measured value, so the
author sees immediately what happened.

**The dangling ceiling is untouched** (still zero, still enforced). This change adds teeth to the ratio only.

## The margin, and the discrepancy that set it

I first chose **0.65**, taken from `StandardsEnforcementAuditor.computeCoverage` reporting **0.6585 over 82
standards**. Running the real script showed it reports **0.6543 over 81** — over the *same* registry file.
Two implementations of the same measure disagree by one article.

I did not average them or pick the flattering one. The floor is set against **this script's** number,
because this script is what CI executes, with roughly one standard of headroom rather than the 0.0043
(about a third of a standard) that 0.65 would have left. **The discrepancy is recorded in the code comment
rather than resolved**, because resolving it is a separate piece of work and hiding it would make a future
reader trust two numbers that do not agree.

## Rollback

Three levers, cheapest first:
1. `STANDARDS_ENFORCED_RATIO_FLOOR=0` in the CI job — the env override already exists and needs no code
   change.
2. Revert the constant to `0`.
3. Revert the commit.

No state is written, no migration runs, nothing persists. Rollback is instantaneous and total.

## Verification

**Proven to fail, not merely to pass** — a guard nobody has watched fail is not a guard:

```
STANDARDS_ENFORCED_RATIO_FLOOR=0.99  node scripts/standards-coverage.mjs --check  → exit 1
STANDARDS_ENFORCED_RATIO_FLOOR=0.64  node scripts/standards-coverage.mjs --check  → exit 0
```

The existing `tests/unit/standards-coverage-ratchet.test.ts` already covers the floor-regression and
dangling-ceiling failure paths against a temp fixture, and it reads the floor from the committed constant —
so it exercises this value rather than a hardcoded copy.

## Multi-machine posture

**Not applicable — machine-local by construction.** This is a CI script executed by GitHub Actions on a
checkout. It reads no agent state, contacts no peer, and is never run by a deployed agent.

## Signal vs. authority

The script is **authority** by design: it fails a build. That authority already existed for the dangling
ceiling; this change extends it to the ratio, where it was previously advisory-by-accident (floored at 0, so
computed and reported but never binding). No new *kind* of authority is introduced — an existing gate stops
being toothless on one of its two measures.

## What this does NOT claim

- **Not** that 0.64 is the right long-term floor. It is today's measured level minus headroom, and the
  comment says to ratchet it again as the gap closes.
- **Not** that the ratio measures enforcement quality. It measures that *a guard of the declared shape
  exists and is named* — the auditor says so itself. This change locks in a bookkeeping level, not a safety
  level.
- **Not** a fix for the 81-vs-82 discrepancy, which is recorded and left open.
