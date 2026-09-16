# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Automatic subscription re-login can now be configured remotely through a narrowly scoped, dashboard-PIN-gated endpoint. The endpoint validates exact email identities, preserves the rest of the subscription-pool configuration, records a names-only audit row, and asks the existing supervisor to perform a planned restart so the new authority is actually active.

## What to Tell Your User

You can enable approval or unattended subscription sign-in repair on another machine without opening its config file. Unlock the dashboard once, configure the exact identities, and the machine restarts its Instar server safely to activate the change.

## Summary of New Capabilities

- `POST /subscription-relogin/configure` with a recent dashboard operator session.
- Exact email validation and explicit evidence-floor controls.
- Crash-safe config persistence, redacted audit evidence, and a supervised planned restart.

## Evidence

- Unit coverage for exact-identity and zero-evidence validation boundaries.
- Integration coverage for PIN gating, persistence, audit, and restart signaling.
- AgentServer lifecycle coverage proving the route is live through real authentication.
