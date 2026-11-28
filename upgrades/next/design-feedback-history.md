# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Added internal observations for exact feedback changelog rule sets and preservation of BASE entry links. Shared literal readers reject malformed identifiers rather than silently matching a known prefix. Symbolic ranges preserve actual issued IDs.

## What to Tell Your User

No new command or active merge gate. The design foundation can now detect a feedback entry's history being erased or its changelog naming the wrong rules.

## Summary of New Capabilities

No new callable agent feature. Complete feedback lint and merge enforcement remain separate active project work.

## Evidence

Nineteen history and sixteen entry tests pass with independent bounded reviews. No source-authentication, publication, owner-waiver, full-suite, merge or release proof is claimed.
