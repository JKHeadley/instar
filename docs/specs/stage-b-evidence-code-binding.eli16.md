# Stage-B Evidence Binds to the Code — Plain-English Overview

> The one-line version: the release gate stops asking "is this the same version number the canary ran on?" (which can only ever be true once) and starts asking "is this the same code the canary certified?" (which is the question it always meant to ask).

## The problem in one breath

Two days ago a safety gate shipped that blocks every release unless it carries signed proof that a two-hour, fifty-delivery canary run certified the new Codex delivery machinery. The proof was stamped with the version number it expected to ship in. That version shipped, the next release got a new number, the stamp no longer matched, and publishing froze — for every fix, forever, no matter whether the certified code changed. The fleet has received nothing since.

## What already exists

- **The canary evidence** — a genuine, Echo-signed record of the two-hour, fifty-delivery run with its full case matrix, zero failures, and an approved review. Nothing about it is wrong.
- **The publish gate** — a script the release pipeline runs that refuses to publish without valid evidence. Its refusal instinct is right; its matching rule is what broke.
- **A verified fact** — the five source files whose behavior the canary certified are byte-for-byte identical today to the day the evidence was signed. The thing the canary vouched for has not changed.

## What this adds

A small manifest, checked into the repository, that records exactly which source files the canary certified and a fingerprint of their exact contents, tied to the exact signed evidence. The publish gate now checks two things: the evidence is genuine and complete (same checks as before, minus the version comparison), and the certified files' fingerprint today matches the manifest. If anyone changes those files, the fingerprint changes, publishing blocks, and the message says exactly which files drifted and that a fresh canary is needed. If anything else in the system changes, releases flow.

The current binding uses fresh repair evidence rather than inherited proof. Candidate `cfe468dc5` completed 50/50 live deliveries over 7,213,141 ms, exercised identical messages, multiline input, an active-turn queue, resize, a real server restart, and encrypted ownership transfer, and produced zero forbidden outcomes. Thirty timestamped health/status samples also succeeded. Echo signed that evidence with its machine identity, and the manifest records its exact digest and certified-source bytes.

## The safeguards

**The canary requirement is not weakened.** Duration, delivery count, case matrix, zero failures, signed approval — all still required, unchanged. Only the "same version number" comparison is gone, replaced by "same certified code", which is stricter where it matters and looser only where the old rule was simply wrong.

**A change to the certified code still forces a fresh canary.** That is the whole point of the fingerprint: it tracks the actual subject of the canary instead of a proxy that broke after one release.

**Nothing is re-signed and nothing is edited.** The existing signed evidence stays exactly as it is; the manifest points at it by digest. The machine-local canary path for future release candidates keeps its strict exact-build binding.

**Drift is caught early.** The fingerprint check also runs before every push, so a developer who touches a certified file finds out immediately, not after their change has merged.

## What ships when

One pull request, full review process, immediately. When it merges, the release pipeline unblocks on its own, the two stuck days of fixes publish in the next release, and the fleet auto-updates.

## What the reader needs to decide

Nothing new. The operator approved this direction explicitly on 2026-09-03 after two plain-language descriptions of it. The one judgment call inside — the gate's own policy file is not part of the certified set, so gate-policy fixes do not force irrelevant canaries — is explained in the spec and visible in the PR.
