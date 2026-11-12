# Side-Effects Review — Local Verify integration-lane deadline 30 → 45 min

**Slug:** `lv-integration-deadline-45`
**Date:** 2026-11-12
**Author:** Echo (Opus 5.5)
**Decision:** operator chose this option in topic 141133 on 2026-11-12 07:38 PST ("1" = raise the 30-minute integration limit).

## Summary of the change
`LOCAL_VERIFY_DEADLINES.lanes.integration` in `src/localVerify/policy.ts` goes from 30 to 45 minutes (the e2e lane's existing value). The spec line in `docs/specs/local-verify-merge-authority.md` §4 that names the deadlines is updated to match, with the reason.

## Why
On 2026-11-11/12 every Local Verify run on the Studio from ~13:00 PST onward except two quiet-hour runs ended `error:deadline:integration` (PRs 3072 ×2, 3079 ×3, 3081, 3087), at 36–42 minutes total, with no failing test. The Studio's config pins `monitoring.localVerify.laneShards` to `{integration: 1, e2e: 1}` (owner unrecorded), so the integration lane runs as one process; under the Studio's normal daytime load (12+ live sessions) that process needs 30–40 min. Two runs at 23:15 and 00:10 PST fit (26m44s total). Raising the shard count to 2 was tried live and still hit `deadline:integration-1` at 42 min, so the lane is CPU-bound, not split-bound; the setting was restored.

## 1. Over-block
This change removes over-blocking: runs that would pass are no longer killed at 30 min. Nothing new is blocked.

## 2. Under-block
A genuinely hung integration file now takes up to 15 more minutes to be stopped; the overall 120-min active-work deadline still bounds the run. No test result is skipped or softened — the lane still runs every file and any failure still fails the run.

## 3. Level-of-abstraction fit
The deadline is a policy constant the spec says is "fixed in config, reviewed at Acceptance"; this is that review. A load-aware deadline would be better long-term (see feedback fb-0350562f-dd7) but is out of 80/20 scope for unblocking the line.

## 4. Signal vs authority compliance
No new authority. The deadline is an existing hard stop; this only lengthens it.

## 5. Interactions
`computePolicyHash()` includes the deadlines, so the policy hash changes. A peer verifier on an older build reports a different policy hash and its records are refused at import until it updates (the existing version-skew rule; the current peer has been dropping attempts anyway). Queue slot time per PR can grow by up to 15 min in the worst case.

## 6. External surfaces
Only the instar-dev Local Verify path on machines that run it. No user-facing or agent-runtime behaviour.

## 7. Multi-machine posture
Machine-local by design: each verifier uses its own installed policy. Takes effect on a machine when it updates to the release containing this commit.

## 8. Rollback cost
Revert the one-line constant; no data migration.

## Evidence
`tests/unit/localVerify/*` (orchestrator deadline cases derive from the constant) pass locally.
