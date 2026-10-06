# A repeated agent-health alert no longer retries every 30 seconds

## What Changed

`TelegramAdapter.createOrReopenAgentHealthAttentionItem` rethrew a `duplicate-content` hold on its "returned after recovery" post, so callers (the Threadline spawn drain's give-up handler) treated an alert the operator already had as a failed Attention write and retried every 30 s for the whole dedup window (ACT-1304 fault 2, Luna/sagemind log 2026-10-04 12:05-12:18Z). That one hold reason now counts as delivered; every other hold still throws.

## What to Tell Your User

If something I warned you about in the Agent Health topic comes back, I no longer keep retrying the same heads-up in the background every 30 seconds.

## Summary of New Capabilities

None — a retry loop is removed.

## Evidence

`tests/unit/attention-single-topic-routing.test.ts`: a `duplicate-content` hold on reopen resolves with the item OPEN; an `origin-display-authority-unavailable` hold still rejects. The new test fails on main and passes with the fix; all 21 tests pass.
