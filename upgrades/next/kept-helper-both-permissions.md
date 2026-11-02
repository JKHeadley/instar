## What Changed

- When a Mac runs the installed desktop helper because it holds a permission the kept helper lacks, the "allow it again" message now asks for both permissions on the kept helper, and guided setup names that same kept helper. Previously it asked only for the one missing overall, so after granting it the kept copy took over still short of the other permission and the operator needed a second trip.

## What to Tell Your User

If your Mac asks you to allow the desktop helper, it now asks for everything it needs in one go, and the setup page and the notice point at the same program.

## Evidence

- Unit tests drive the probe with an installed copy holding one grant and a kept copy holding none, and check the change asks for both permissions on the kept path and setup names the kept path; a kept-serving case still asks only for what is missing.

## Summary of New Capabilities

- `helperChange.keptMissing` in desktop diagnostics lists every permission the kept helper still needs.
