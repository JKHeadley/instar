# Accounts repair coverage

## Summary

Tier 1. A narrow repair to the existing Accounts read and approval presentation. The read-only fan-out retries a timeout once. The browser preserves known roster entries and refuses to start unattended approval when coverage is unresolved. The existing write endpoint, PIN authority and revision checks still decide whether any setting changes.

## Effects

- The Accounts opt-in read can take up to 13 seconds of peer wait per request. Responsive peers are fetched once in parallel. Other clients retain the original timeout.
- The response includes expected machine IDs and existing display names only. A name is shown using the existing verified-display rules.
- Failure, missing config, unknown fleet inventory and absent revisions keep the turn-on control disabled. A readable empty account set is resolved.
- No new persistence, credential access, background job, or rollout setting.

## Rollback

Revert the commit. No data migration is involved.

## 6b. Operator-surface quality

A machine that has not answered shows its name, a short status and a Retry button together on the same row. No machine IDs or transport errors are shown as primary content. The turn-on control stays visible and disabled with a plain explanation of what to check. Switching back uses the existing quiet secondary control. Chromium at 390 and 1280 pixels verified the row, the disabled control and successful retry without horizontal overflow.
