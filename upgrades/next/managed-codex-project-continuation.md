# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Instar adds an experimental continuation path for managed Codex project sessions. It checks that the current session finished the expected step and issues at most one instruction to continue for that step.

## What to Tell Your User

This update includes groundwork for letting managed Codex projects continue after a step ends. The feature is off by default, so your projects will behave as they do today.

## Summary of New Capabilities

Experimental continuation for managed Codex project sessions is included behind a switch that defaults off.
