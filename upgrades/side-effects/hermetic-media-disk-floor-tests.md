# Hermetic media disk floor in tests side effects

## Decision and authority

Tests only. No source file changes. A new helper, tests/helpers/hermeticMediaDisk.ts, sets an own-property diskSpace on a test agent's AppMediaStore returning 1e12 free of 2e12, so AppMediaStore.belowDiskFloor and every caller (upload admission, AppConversationService send, AppMediaReplicator) see ample space regardless of the host. The four affected end-to-end files call it right after each AgentServer is built. Production AppMediaStore.diskSpace, mediaDiskFloorBytes (max of 5 percent and 2 GiB) and the 507 refusal are unchanged.

## Data and resource effects

None outside tests. A test agent can now write media to a host volume that is below the production floor; the test files are a few kilobytes.

## Rollback and verification

Revert the helper and the four one-line calls. The 507 refusal stays proven by mobile-native-media-alive's full-disk case, which spies on diskSpace returning one free byte; its spy now restores to the helper's reading instead of the host's. Verification belongs on the Studio (the M5 is below its floor and out of the line for full runs): the four files must pass there and on any host.

## Review

Machine fix per the Chief of Staff, 2026-11-27 05:58 PT.

## Second-pass review

**Reviewer:** independent Claude sub-agent, fresh context, not the author (Parity session, 2026-11-27 06:00-06:04 PT)

Verdict CONCUR. Traced: the own property shadows the private prototype diskSpace that belowDiskFloor and every floor caller use (AppMediaStore admission, AppConversationService, AppMediaReplicator via the same instance); the store is built in the AgentServer constructor, so it exists at each call; every server in the four files is covered; tinyspy's restore returns the own descriptor, so the full-disk spy restores to the helper reading; all 12 failures in the PR 3985 M5 run map to the floor; the 507 proof stays; no src file changes; the pre-push gate accepts an internal-only fragment without src changes. Optional hardening taken: the helper throws instead of returning false when a server has no media store.

## 6b. Operator-surface quality

No operator surface.

## Framework generality

Test fixtures only; no agent framework or model provider involved.
