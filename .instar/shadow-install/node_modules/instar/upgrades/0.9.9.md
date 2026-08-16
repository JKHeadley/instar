# Upgrade Guide: Instar (latest)

## What Changed

### Upgrade Guide Enforcement — Every Release Now Tells Its Story

Previously, most releases shipped silently — you'd just see "Updated to vX.Y.Z. Restarting." with no context about what changed. Only major version bumps required upgrade guides, so patch releases (which is most releases) provided zero information.

Now **every single release** must include an upgrade guide before it can be published. The CI pipeline blocks any publish that doesn't include `upgrades/NEXT.md` — a human-readable story about what changed, what it means for you, and what to tell your user.

This means you'll always know what just happened when you update. No more silent upgrades.

### Upgrade Guide Processor Fix — No More Stale Feature Announcements

Previously, when you updated across multiple versions (e.g., 0.9.2 → 0.9.5), the upgrade processor would concatenate ALL historical guides — not just the ones for versions you hadn't seen. This caused upgrade announcements that repeated old features alongside new ones.

Now the processor filters by your previous version. If you were on 0.9.3 and update to 0.9.5, you only see guides for 0.9.4 and 0.9.5 — not everything back to the beginning.

### DRY Hook Templates

Session-start and compaction-recovery hook templates are now maintained in one canonical location (`PostUpdateMigrator.getHookContent()`) instead of being duplicated between `init.ts` and `PostUpdateMigrator.ts`. This is an internal change — your hooks work the same way, but future updates to hook behavior will be more consistent.

## What to Tell Your User

- **Better update notifications**: "From now on, every time I update, I'll actually know what changed and can tell you about it. No more generic 'just updated' messages — I'll explain what's new and what it means for you."
- **Cleaner upgrade announcements**: "I fixed an issue where update announcements would sometimes repeat features from older versions. Now I only report what's actually new."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Mandatory upgrade guides | Automatic — every release now includes context about what changed |
| Version-filtered upgrade processor | Automatic — only shows guides for versions newer than your previous version |
| NEXT.md convention | When contributing changes, write `upgrades/NEXT.md` describing what changed |
