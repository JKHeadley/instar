# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The manual design inspection command accepts --feedback to inspect committed feedback entry structure, rule links, changelog declarations and history. It returns findings for deleted records and refuses linked files. This does not activate automatic enforcement or verify source messages.

## What to Tell Your User

You can ask for a manual check of the feedback records behind the design rules. The check flags broken links and deleted records, but it cannot approve a design or a merge.

## Summary of New Capabilities

Use `instar design:inspect --repo PATH --base BASE --head HEAD --feedback`. The JSON states its limited scope and keeps source verification, privacy review and merge authority false.
