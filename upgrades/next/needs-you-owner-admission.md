# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Needs You uses the owner admission check by default. Existing configurations get the default when the setting is missing. Agents with an explicit false setting keep the legacy view.

## What to Tell Your User

Needs You is designed to show requests that require your attention. If your client needs an update to show the new list, it will tell you.

## Summary of New Capabilities

`needsYou.ownerAdmission.enabled` controls the owner admission check. The negotiated Needs You response is the authority for list membership and count.

## Evidence

This draft verifies the default and rollback in disposable server tests. Fleet release awaits deployed-client and production source acceptance.
