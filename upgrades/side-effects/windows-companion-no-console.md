# Windows companion: windowless build

## Summary

Tier 1: one word in scripts/install-windows-desktop-companion.ps1 (`-OutputType ConsoleApplication` to `WindowsApplication`).

## Over-block

None.

## Under-block

The `--self-test` mode still writes to the console; as a windowless app its text is not shown when run by hand, but its exit code is unchanged. Nothing in the installer or tests runs it.

## Level of abstraction

Build flag only.

## Signal versus authority

No decision point changes.

## Interactions

The red "remote control active" banner is a WinForms window and is unaffected. The scheduled task launch is unchanged.

## 6b. Operator-surface quality

Removes a stray terminal window from the user's Windows desktop.

## External surfaces

None.

## Multi-machine posture

Windows-only, machine-local.

## Rollback cost

Revert the line; the next update rebuilds the console version.

## Class-Closure Declaration

`defectClass: environment-assumption`, `closure: fix`, `guardEvidence: { enforcementType: unit-test, citation: tests/unit/windows-companion-no-console.test.ts, howCaught: a terminal window titled with the companion path was visible in the live Mama PC screen }`.
