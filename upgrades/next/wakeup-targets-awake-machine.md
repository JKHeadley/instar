# `instar wakeup` talks to the machine that is actually awake

## What Changed

`wakeup()` named the awake machine from the registry's lagging role field and posted the handoff challenge to its OWN server, which verified the signature with itself as receiver and answered `Invalid challenge signature` (instar#2122).

- `resolveAwakeMachine`: live lease holder from the local server's `/health` (`multiMachine.syncStatus.leaseHolder`, active non-revoked entry), else the registry role.
- `resolveAwakeServerUrl`: probes the awake machine's advertised endpoints + last-known URL with `/health`; never localhost.

## What to Tell Your User

Moving me to another machine with "instar wakeup" now talks to the machine that is really in charge, so the hand-over no longer fails with a signature error.

## Summary of New Capabilities

None — a CLI fix.

## Evidence

`tests/unit/wakeup-targets-awake-machine.test.ts` (5): live lease wins over the registry; registry fallback; a revoked/unknown lease holder is ignored; endpoint probing picks the first rope that answers and never localhost; null when none answer.
