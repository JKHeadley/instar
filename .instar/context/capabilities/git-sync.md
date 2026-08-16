# Git Sync

Automatic version-control and multi-machine synchronization of your state.

## How It Works

The `git-sync` job runs hourly, commits local changes, pulls remote changes, and pushes — all automatically. It uses a gate script to skip when nothing has changed (zero-token cost).

## Agent Types

- **Project-bound agents**: Your state (`.instar/`) lives inside the parent project's git repo. The git-sync job uses this repo directly — no separate repo needed. Just make sure the parent repo has a remote configured (`git remote -v`).
- **Standalone agents**: Run `instar git init` to create git tracking within your state directory, then set a remote with `instar git remote <url>`.

## Verify Sync is Working

Check your jobs list for the `git-sync` job. If it's enabled and your repo has a remote, sync is automatic.

## Endpoints

- **Status**: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/git/status`
- **Commit**: `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4042/git/commit -H 'Content-Type: application/json' -d '{"message":"description of changes"}'`
- **Push**: `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4042/git/push`
- **Pull**: `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4042/git/pull`
- **Log**: `curl -H "Authorization: Bearer $AUTH" http://localhost:4042/git/log`

## First-Push Safety

The first push to a new remote requires `{"force": true}` to prevent accidental exposure of state.

## When to Use Manually

After significant state changes, before and after major updates. But the hourly job handles routine syncing automatically.
