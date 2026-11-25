# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Adds the server side of one-time owner approvals for an exact set of eligible Work Board cards. The paired app reviews the bound card versions and signs the decision. The writer records the cause and each result before pickup can follow.

## What to Tell Your User

This release prepares permission slips for Work Board approvals. They remain off while we verify the production board’s starting history and confirm that every machine respects its designated writer.

## Summary of New Capabilities

The proposal, paired-device disclosure, challenge, submission and receipt routes are present. Production startup supplies no enrollment, so these routes cannot grant or apply a slip in this release.

## Evidence

Focused coverage includes exclusive lock acquisition and loss, rejection of an operator override, explicit empty and complete peer history, and refusal of a journal write emitted through the legacy path.

The follow-on also verifies the folded starting history against a separately attested digest. Its sync fixture persists a real legacy journal batch before checking that the enrolled writer refuses it.
