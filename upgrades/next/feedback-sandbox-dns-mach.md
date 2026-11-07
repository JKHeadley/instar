# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Feedback fix checks on macOS can now read the local DNS configuration that Node needs to start some tests. Previously, those checks could hang before a worker-produced fix reached review. The sandbox still blocks outbound network access and access to other agents' files.

## What to Tell Your User

No action is needed. Feedback fixes that use Node's DNS module can proceed through their normal tests and independent review on macOS.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Feedback fix verification on macOS | Runs automatically when the feedback executor checks a worker's change. |

## Evidence

The exact confined Node DNS import hung before this change and completed after allowing only the local DNS configuration service. Unit, integration and end-to-end tests pin the permission and the remaining network block.
