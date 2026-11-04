# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

On a fresh Linux server the sandbox used for private memory needs two packages. The agent now installs them at startup if it has passwordless sudo, instead of only reporting that they are missing.

## What to Tell Your User

Nothing to do. On a new Linux server, private memory now sets itself up when it can.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Sandbox tools installed at boot | Automatic on Linux with passwordless sudo |

## Evidence

Found on a real test server that had neither tool.
