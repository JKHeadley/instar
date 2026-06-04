<!-- bump: patch -->

## What Changed

Enforces the dogfooded-channel standard (APPRENTICESHIP-PROGRAM-PROJECT-DESIGN §4a) in
code. Every `ApprenticeshipCycleStore` record now carries a `channel`
(`telegram-playwright` | `threadline-backup` | `direct-shortcut` | `unknown`), with an
idempotent migration for existing DBs. `roleCoverage` now counts a
`mentor-mentee-differential` cycle toward the keystone axis **only** when it did NOT run
through a `direct-shortcut` — a shortcut cycle is still recorded (for honesty, surfaced via
the new `shortcutDifferentialCount`) but can never make the keystone look healthy. Unset /
pre-field channels are grandfathered as `unknown` and still count, so an already-earned
keystone is never retroactively un-fired.

## What to Tell Your User

Nothing user-facing changes. Internally, the apprenticeship now records which channel each
mentor↔mentee cycle ran through and structurally refuses to let a CLI/API shortcut count as
real keystone progress — so "is the real mentorship happening?" can't be faked.
