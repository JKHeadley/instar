# Hermetic media disk floor, follow-up side effects

## Decision and authority

Tests only, no source change. tests/integration/mobile-remote-media-graph-seam.test.ts passes mediaDiskSpace: () => ({ free: 1e12, total: 2e12 }) to its AppConversationService, the existing option that AppMediaStore uses ahead of statfs. The production floor is unchanged.

## Data and resource effects

None outside the test.

## Rollback and verification

Revert the two lines. Search done before the change: every test that constructs AppConversationService, AppMediaStore or AgentServer and reaches the floor (media uploads, platform media ingest, reply reservations) already has a fixed reading or a diskSpace spy (slack-platform-media and telegram-platform-media spy AppMediaStore.prototype.diskSpace; the e2e files use tests/helpers/hermeticMediaDisk.ts), except this file. The remaining services without one never write media. Verification needs a whole-file run of this integration file on a machine with disk room (the M5 is under a disk hold).

## Review

Machine fix per the Chief of Staff (2026-11-27 11:17 PT).

## Second-pass review

**Reviewer:** independent Claude sub-agent, fresh context, not the author (Parity session, 2026-11-27 11:19-11:21 PT)

Verdict CONCUR. The single AppConversationService in the file builds both machines' stores, so the option reaches every store; it is passed as diskSpace and checked ahead of statfs, which backs the 507 refusal. The search claim was verified across unit, integration and e2e: every test that writes media has a fixed reading or a diskSpace spy, and the remaining look-alikes never reach the floor (replication or text stubs, empty attachments, a proxy hop with fetch stubbed, and the session attachments route, which has no floor check). The internal-only fragment fits a change with no src file.

## 6b. Operator-surface quality

No operator surface.

## Framework generality

Test fixture only.
