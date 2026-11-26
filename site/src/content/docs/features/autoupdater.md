---
title: AutoUpdater
description: Built-in update engine that keeps your agent current.
---

A built-in update engine that runs inside the server process -- no Claude session needed.

## How It Works

1. Checks npm for new versions every 30 minutes
2. Downloads the update to a **shadow install directory** (`.instar/shadow-install/`)
3. Notifies you via Telegram with a changelog summary
4. Self-restarts with the new version

Since v0.17.3, updates use a **shadow install** pattern rather than global `npm install`. The new version is installed into a local shadow directory, and the server restarts using the shadow binary. This avoids permission issues, keeps updates isolated, and works whether Instar was installed globally or via `npx`.

## Restart safeguards

`RestartCascadeDampener` batches update-driven restart requests that arrive too close together. `PlannedRestartVerifyGuard` holds an ordinary planned restart while a local verification child is running, and pauses new verification starts until the request is consumed. `ServerSupervisor` consumes the request after that hold clears. A forced restart can still bypass the hold.

`UpdateRestartHandshake` records the version expected after a restart and delays the success notice until the new process proves it is running that version. `StaleProcessGuard` separately detects when a long-running process has older code or configuration than the files on disk. Lifeline restarts caused by health or version skew use `RestartOrchestrator`; they have different rules from an update-driven server restart.

## Status

```bash
curl localhost:4040/updates/auto
```

Returns last check time, current version, available version, and next check time.

## Manual Check

```bash
curl localhost:4040/updates
curl localhost:4040/updates/last
```

## No Session Required

Previous versions used a `update-check` prompt job that spawned a Claude session to check for updates. The AutoUpdater replaces this with a lightweight server-side check -- no Claude session needed, no quota consumed.
