<!-- bump: minor -->

## What Changed

The dark-gated job-result supervision path now has a pinned pool authority for signed exact-result certificates. Every fixed decision reads a fresh signed registry snapshot, and a local false-routine grade writes a durable revocation request. Scheduler admission checks revocations and canary age before a script claim and again before a delayed script executes. The authority can atomically renew a certificate with a fresh canary assertion. A newly accepted false-routine proof suspends every active certificate for the exact result contract; replayed proofs leave a later reviewed recovery alone. The version-2 proof signs both the independent grade time and the machine signing time, so a later key rotation does not misdate a queued revocation. New certificates must include the writer's latest accepted-miss epoch in both reviewers' signatures. The Jev live-decision cohort remains off while the quality, surveillance, and outage-reservation gates are incomplete.

## What to Tell Your User

The job-result supervision foundation now keeps reviewed fixed-result certificates in a signed, single-writer pool registry. Each machine checks the live registry before treating an exact result as routine or starting its script. A confirmed incorrect routine grade requests pool revocation, and an unreadable or revoked certificate leaves the result unresolved and holds the affected script route. This foundation is installed dark; it does not turn on Jev decisions or claim a token saving.

## Summary of New Capabilities

- Pinned signed registry for reviewed exact-result certificates, with authenticated issue, renew, read, and revocation paths.
- Fresh per-decision authority checks, durable revocation delivery, and fail-closed holds for registry loss or false routine grades.

## Evidence

The post-fix TypeScript check and build pass. `dev:preflight` passes lint,
capability discoverability (194 checks), and new-route prefix coverage. The
documentation coverage check also passes after the registry components were
added to the job-result feature and architecture pages. Focused certificate,
registry, scheduler, and store unit tests passed before the latest worker
missing-reader correction; that new case still needs its suite result. The
same-slug registry-hold release regression added after the final review also
needs its suite result. The post-correction TypeScript check, build, and
`git diff --check` pass. The independent reviewer checked the store's
transactional guard plus its scheduler and worker callers and found no
remaining bypass for this identified race; that review did not run tests. The
authenticated HTTP integration, production-boot two-machine lifecycle, and
full `npm run test:all` remain queued behind the host's single suite test
slot. The first lifecycle queue attempt hit its 45-minute start budget without
running any test; it was requeued with the documented four-hour wait budget.
The first full-suite queue attempt reached the same start limit with zero tests
run; the unchanged unit → integration → E2E command was requeued with that
longer, still semaphore-enforced wait. It later acquired the lane and ran the
unit phase: 54,727 tests passed, while two static gates failed because the new
long-lived SQLite stores were missing from the registration allowlist and one
fail-closed payload catch lacked the silent-fallback exemption. I added the
two allowlist entries, a real handle-registration test, and the exemption;
their focused rerun and the full suite are still required. The authenticated
registry HTTP integration passed (1/1). The first joined lifecycle run found
that its local assertion expected `certificate-revoked` after the independent
grade had already written the stronger `confirmed-false-routine` hold. The
assertion now checks that stronger source hold and still expects the peer's
pool revocation. The focused rerun then reached the peer and found that the
test fixture had registered the writer in peer metadata without pinning its
remote signing identity, so snapshot verification correctly refused the peer
read as `registry-unreadable`. The fixture now establishes that identity
through the production pairing method and checks that the peer verifies a fresh
revoked snapshot before its scheduler fires; the corrected E2E still needs a
pass. The current source again passes `npm run build` and `dev:preflight`,
including source lint and all 194 capability-discoverability tests.
Delayed false-routine revocation proofs now sign their delivery time separately
from their grade time so key validity is checked at the actual signing time;
the independent reviewer concurred on that narrow correction. No lifecycle
or full-suite pass is claimed yet. The independent
reviewer concurred on the dark authority safety path after the pending-result
correction. The full review is
`upgrades/side-effects/job-supervision-pool-authority.md`.
