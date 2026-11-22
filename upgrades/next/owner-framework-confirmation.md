# Confirm Engine Changes from Another Conversation

<!-- bump: patch -->

## What Changed

The existing owner-confirmation route can now include the engine (framework) when proposing a change to another eligible Telegram conversation. The HTTP route and final write surface share the same field list. Armed proposals use the existing bounded owner-decision delivery lane, so they are visible in their addressed conversation under Quiet by Default. Exact-change display, typed yes, owner verification, destination checks and confirmation-time rechecks remain.

## What to Tell Your User

When you ask me here to move another project conversation to Codex, I can show the exact change here and let you confirm with "yes." You do not have to visit the other conversation first. I still refuse changes to someone else's or a team member's conversation.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Confirm an engine switch from the conversation you are in | Existing POST /topic-profile/TARGET/propose with framework and confirmIn; the owner confirms the displayed change |

## Evidence

The allocated normal-enforced targeted batch passed all137 unit,31 real HTTP and15 lifecycle checks with zero failures. Unit files cover the real write surface, confirmation slots, owner/destination eligibility, notification capability and source-bound lint, and awareness format. The lifecycle uses the actual server, adapter and notification gate; it does not claim a live Telegram polling run. Full normal Local Verify remains required before merging; no deployment is claimed.
