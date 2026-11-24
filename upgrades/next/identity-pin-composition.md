# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The one-time local dashboard link and confirmation-page PIN protection now coexist in the same server. The local link retains its bounded recovery allowance and recovery instruction. Confirmation requests still share the public guessing limits and retain their own request limit, even when a request includes a local-link credential.

## What to Tell Your User

The local dashboard recovery link keeps working alongside the protection against PIN guessing on confirmation pages. A successful local unlock does not give a guessing program more attempts.

## Summary of New Capabilities

None. This preserves the behavior of two separately approved changes when combined.

## Evidence

Focused tests cover both existing features and their interaction. Full verification and parent release requirements remain separate gates; this fragment does not certify deployment.
