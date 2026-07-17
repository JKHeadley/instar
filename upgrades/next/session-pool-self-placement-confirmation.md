# Local session-pool placements now become active after delivery

## What Changed

When the session pool chooses the current machine for a new conversation, its
ownership row now advances from `placing` to `active` after the established
local injection or spawn path succeeds.

## Evidence

- Unit and integration coverage verifies the guarded transition, idempotence,
  and the no-confirm-on-failed-spawn ordering.
- A live single-agent CROSS-MACHINE laptop/Mini test advanced a fresh Mini
  placement from `placing` to `active` at epoch 2.
- Focused tests and TypeScript build pass.

## What to Tell Your User

A conversation started on the machine that receives it no longer remains
stuck in a “starting” ownership state after it is already running.

## Summary of New Capabilities

No new setting. This repairs the existing session-pool placement lifecycle.
