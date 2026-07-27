<!-- internal-only -->

## What Changed

Fixes the pre-push gate's side-effects-artifact check, which refused **every push from a clean
post-release tree** and named an impossible remedy when it did.

After a release cut there are no in-flight release-note fragments, so the check fell back to
`upgrades/<version>.md` — the guide for the version that already shipped — and demanded
`upgrades/side-effects/<version>.md`. Side-effects artifacts are named per change slug; the release
flow has never produced a version-named one, so the demand could not be satisfied.

The check is now scoped to the notes the push is actually shipping. With no notes in flight there is
nothing to check and it stays silent. With notes in flight it fires exactly as before.

## Evidence

**Three observed recurrences, self-documented in the repo.** `upgrades/side-effects/1.3.492.md` and
`1.3.802.md` are hand-written placeholders whose own text says they exist only to satisfy this
check; the second calls itself "its second observed recurrence". Today (v1.3.1009) was the third,
and it refused a sibling branch before diagnosis.

Both placeholders claim the gap "remains logged in the framework-issues ledger under dedupKey
`pre-push-gate-versioned-artifact-fallback`". It is not. Queried four ways — unfiltered,
`?status=fixed`, `?bucket=instar-integration-gap`, `?framework=instar` — the ledger holds 163 issues
and zero matches, with no dedupKey containing `release`, `artifact`, or `push`. Declared tracked,
never tracked, recurred. It is registered for real with this change.

**Verified by reverting, because a passing test proves nothing:**

| gate | result |
|---|---|
| OLD code, new tests | **3 failed** \| 16 passed (19) |
| NEW code | **19 passed** (19) |

Plus a live run against the real repo in its actual post-cut state: errors before, warnings only
after.

**Nothing is weakened, and this was the load-bearing question.** Per-change enforcement still lives
in the pre-COMMIT gate (which refuses in-scope staged files lacking an ELI16 + side-effects artifact,
and blocked this very change twice while it was being written); check 3b still refuses a
release-relevant push with no fragment; and check 5 still fires when in-flight notes claim a fix with
no fresh artifact — asserted by a dedicated negative-control test, since the easy mistake here is
trading a false positive for a false negative.

## What to Tell Your User

None — internal change (no user-facing surface).

## Summary of New Capabilities

None — internal change (no user-facing surface).
