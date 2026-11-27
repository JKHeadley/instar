# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The project registry can store an owner-approved purpose, done list, and scope boundaries for one exact conversation. The record includes the original owner message references and an increasing revision. The writer verifies Telegram owner messages. An unanchored project can start from one original owner message in local history. The registry copies its complete text and leaves the done and scope lists empty.

## What to Tell Your User

Once you approve a project anchor, Instar can use the same text whenever that project conversation needs to recover its context. If the conversation belongs to more than one project, Instar uses its ordinary recovery context until the membership is resolved.

## Summary of New Capabilities

The project registry exposes operator-authenticated source-backed purpose initialization and an in-process consumer lookup.

## Evidence

The HTTP fixture accepts the same owner-backed draft it declines without an operator session, and refuses a changed quote or stale revision. A real SQLite fixture proves that an existing TaskFlow wait keeps its original identity through anchor approval and that a new tracker can read the approved revision.
