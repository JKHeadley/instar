# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Added an opt-in browser credential grant. An eligible native owner can authorize one paired browser to complete one exact Needs You credential request.

## What to Tell Your User

The browser can ask for a credential only after you authorize the exact request from your paired native device. This update leaves that option off by default.

## Summary of New Capabilities

The optional `needsYou.browserCredentialGrants.enabled` setting enables the server grant flow once compatible owner and Dashboard clients are installed. It adds no browser trust approval authority.

## Evidence

Disposable end-to-end tests verify native presence, the default refusal, a signed browser submission and refusal after reassignment.
