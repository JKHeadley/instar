# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed
Codex delivery resolves its transcript baseline in the running session’s account home. Pooled account conversations previously searched the default home and could refuse owner Telegram follow-ups before terminal input. Existing journal, ownership fences and durable FIFO remain authoritative.

## What to Tell Your User
Telegram follow-ups to an agent using a separate Codex account no longer fail merely because its conversation transcript is stored in that account’s folder.

## Summary of New Capabilities
None. This repairs the existing delivery path without adding settings or replaying historical messages.

## Evidence
Actual focused checks passed: unit10, HTTP1, lifecycle1, zero skips. The initial HTTP authentication-fixture failure is preserved; its secret-header-only correction was independently reviewed before a fresh authorized invocation. Build passed and independent review concurred. Complete exact-head verification remains required; production delivery and actual model consumption are not claimed.
