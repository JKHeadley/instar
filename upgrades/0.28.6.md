# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

Fixed 8 CI test failures across trust wiring, quota tracking, config validation, and job scheduler edge cases. UnifiedTrustWiring now handles missing threadline config gracefully. Quota tracker tests updated for consistent warning/failure threshold assertions. Config tests aligned with current schema defaults. Job scheduler edge case test fixed for timing sensitivity. Builtin manifest updated to reflect current version.

## What to Tell Your User

- **Stability improvements**: "Under-the-hood reliability fixes — nothing you need to do, everything just works more consistently now."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Improved trust wiring resilience | Automatic — threadline config failures no longer cascade |
