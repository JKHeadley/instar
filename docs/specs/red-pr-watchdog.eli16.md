# Red-PR Watchdog — Plain-English Overview

> The one-line version: if one of my own pull requests sits RED (a required check failed) for too long, I now raise ONE quiet, self-updating heads-up instead of letting it rot unnoticed.

## The problem in one breath

On 2026-07-08 one of my PRs (#1399) sat red overnight and nobody noticed — the merge watcher only ever acts on *green* PRs, so a PR that goes red and *stays* red is invisible to it. The operator found it on his morning check-in. That is an "operator-found escape": the exact failure the automation is supposed to prevent.

## What already exists

- **Green-PR auto-merge** — a background watcher that, on each tick, lists my own open PRs and merges (or arms GitHub auto-merge on) the ones that are green, mergeable, and not held. It already fetches each PR's check status in that same list call. It has zero interest in a PR that is red — it just skips it.
- **The attention queue** — the one place I surface things the operator should look at, with built-in coalescing so the same item never floods as many messages.
- **The check-status reader (`deriveRollup`)** — the helper that collapses a PR's many checks into a single SUCCESS / PENDING / FAILURE verdict.

## What this adds

A **signal-only watchdog** bolted onto the same green-PR watcher tick. After the merge logic runs, it looks at my own open PRs and, for any that have a required check that has been failing longer than a threshold (default 2 hours), it raises ONE attention line: `PR #N red for Xh — <failing check names>`. It never merges, never closes, never blocks anything — it only tells the operator "this one is stuck." The line is de-duplicated per PR (you get one, not one every ten minutes) and only re-raised when the PR gets *older* in red or its failing checks change. The moment the PR goes green, merges, or closes, the memory is cleared so it stops being mentioned.

## The new pieces

- **`redPrWatchdogPass`** — the per-tick sweep. It is allowed only to *raise attention*; it is structurally forbidden from touching the merge/close path. It keeps a small per-PR "already told you" memory so it dedups and age-escalates instead of nagging.
- **`stuckRedChecks` / `latestRunPerCheck` / `failingChecksFromRollup`** — the pure helpers that turn a PR's raw check list into "which checks are failing, and since when." Reused, no new network calls — the data was already fetched.
- **A read surface** — `GET /green-pr-automerge` now also reports `stuckRed` (which of my PRs are flagged and for how long) and the watchdog's config, so "why did I get a red-PR alert?" is answerable by reading state, not guessing.

## The safeguards

**Prevents false alarms from a flaky-then-fixed check.** The same investigation surfaced a real correctness bug: the check-status reader did not de-duplicate re-runs, so a stale FAILED run that a later re-run turned green still read as FAILURE. That is fixed at the source — every check is collapsed to its *latest* run before judging — so a PR whose red check was re-run green is correctly seen as not-stuck (and, as a bonus, the green-PR merger no longer refuses to merge such a PR).

**Prevents nagging.** One line per stuck PR. Re-raised only when the red gets older (a new whole-hour bucket) or the failing-check set changes. Cleared on recovery. Unknown failure-times are treated as "don't alert" — the watchdog fails toward silence, never toward crying wolf.

**Prevents scope creep into authority.** It is a detector, not an actor. It cannot merge, cannot close, cannot block a message. If it is wrong, the worst case is a spurious heads-up the operator ignores — never a bad merge.

## What ships when

All of it ships together in one PR: the pure helpers + the correctness fix, the watchdog pass, the config default, the read-surface fields, and full unit + integration tests. It runs only where the parent green-PR watcher already runs (maintainer/dev agents with an analyzable instar repo); on every other install it is inert, exactly like the parent feature.

## What you actually need to decide

Is a **2-hour** default the right "stuck" threshold, and is **default-on wherever the merger is on** the right posture (versus shipping it off and opting in)? The build ships 2h + default-on — a red PR sitting silent is the incident this closes — and the threshold is tunable via `monitoring.greenPrAutoMerge.redPrWatchdog.redThresholdMs` and can be turned off with `enabled: false`.
