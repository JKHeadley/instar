# Protect saved sign-in browser profiles

## What Changed

Registered Google sign-in browser profiles now refuse Playwright activation, debugging-protocol launches and unsafe browser MCP configuration. Native Claude and Codex tool hooks also refuse ordinary automated access to these profiles. Normal Chrome sign-in repair remains available; tests should use disposable profiles.

## What to Tell Your User

Testing tools are now kept away from the saved Google browser logins used for subscription repair. A failed repair is checked before asking you to act.

## Summary of New Capabilities

Code enforcement for saved sign-in profile safety, including existing-agent hook updates and browser startup checks.

## Evidence

Unit boundary tests, HTTP activation integration test, and migration-to-hook execution lifecycle tests. Incident review confirmed an unsafe Playwright launch; it did not establish historical sign-out causation or a completed repair.
