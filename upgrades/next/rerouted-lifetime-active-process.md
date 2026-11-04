# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

A rerouted one-shot that passes its configured hard lifetime can now finish its timeout cleanup even when the interactive process still appears active. The session manager checks the saved lane and deadline again before relaxing only process-activity vetoes. All other session protections remain. It now logs “Killed” only after termination succeeds.

## What to Tell Your User

A worker that runs past its time limit no longer holds a subscription slot forever just because its process is still present. Its work is recorded as timed out and can follow the existing retry path. Recent user activity and the other session safety checks still protect live conversations.

## Summary of New Capabilities

None. This repairs the rerouted-session lifetime path.

## Evidence

On Echo, `dashboard-console-default` crossed 480 minutes. The server printed repeated kill attempts, while the durable reap log recorded `skipped:active-process` and the feedback executor stayed blocked at 6/6. A focused test now uses the real `ReapGuard` with active child and main-process signals and verifies the expired reroute ends; another verifies recent user activity still vetoes. The production-shape E2E test also checks the timeout through the HTTP session listing. Focused unit tests, build, lint, and independent review passed. Full three-tier verification remains before merge.
