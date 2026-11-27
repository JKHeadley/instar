# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The recovery installer now gives macOS more time to inspect the Node runtime's linked libraries on a busy machine. The check remains bounded and still refuses a runtime that cannot be verified. The paired enrollment request also allows time for the runtime checks to complete before it expires. The worker cleanup integration check also allows enough time for its real child process to start during parallel verification.

## What to Tell Your User

Installing recovery on a busy Mac is less likely to fail just because the system utility needs a few extra seconds. If the runtime still cannot be verified within ten seconds, the installer continues to refuse it safely.

## Summary of New Capabilities

This change adds no new capability. It makes two existing reliability checks tolerate normal machine load while preserving their failure limits.

## Evidence

Focused tests cover the real Cartographer worker's child cleanup and recovery installation's owned Node runtime. The Studio main run had recorded intermittent failures in both tests, and their isolated reruns passed.
