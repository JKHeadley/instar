# Upgrade Guide: Instar (latest)

## What Changed

### Robust Auto-Update — Explicit Version Pinning with Retry

Previously, the auto-updater used `npm install -g instar@latest` which was vulnerable to npm CDN propagation delays. When a new version was published, `@latest` could still resolve to the old version for several minutes, causing the update to silently fail (version didn't change).

Now the updater uses **explicit version pinning** (`npm install -g instar@0.X.Y`) with up to 3 retry attempts and exponential backoff (0s, 5s, 15s). If the first install doesn't produce the expected version, it retries rather than giving up.

### Verified Upgrade Notifications — No More Silent Failures

Previously, the upgrade-notify session (which tells your user about new features and updates your MEMORY.md) was fire-and-forget. If the Haiku session failed to complete all 3 steps — notify user, update memory, acknowledge — nobody would know. The pending guide would sit unprocessed.

Now the notification uses **verified delivery with model escalation**:
1. Try with Haiku (fast, cheap)
2. After session completes, verify the guide was acknowledged (`instar upgrade-ack`)
3. If not acknowledged, retry with Sonnet (more capable)
4. If all attempts fail, log the failure and preserve the guide for the next session-start

This means every upgrade guide is either successfully delivered or explicitly flagged as failed — no more silent drops.

### UpgradeNotifyManager — Extracted and Testable

The upgrade notification logic was previously inlined in the server startup code (untestable). It's now extracted into a dedicated `UpgradeNotifyManager` class with dependency injection for sessions, completion checking, and activity logging. This enabled comprehensive test coverage for all failure modes.

## What to Tell Your User

- **More reliable updates**: "My update system is more reliable now. When I get a new version, the install uses the exact version number instead of 'latest', so it won't silently fail if the package registry is a bit slow to update."
- **Better upgrade notifications**: "When I update, I now verify that I actually processed the upgrade guide successfully. If the first attempt fails, I automatically retry with a more capable model. You'll always get notified about what's new."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Explicit version pinning | Automatic — auto-updater now installs `instar@X.Y.Z` instead of `instar@latest` |
| Retry with backoff | Automatic — up to 3 attempts with increasing delays if version doesn't change |
| Verified upgrade notifications | Automatic — guide acknowledgment is checked after session completes |
| Model escalation on failure | Automatic — retries with sonnet if haiku fails to acknowledge |
| Activity logging for notifications | Automatic — success/failure events written to activity JSONL |
