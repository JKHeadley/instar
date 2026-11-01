# Machine self-maintenance starts watching

<!-- bump: patch -->

## What Changed

A development agent now runs a practice restart on paper every night. It picks a real restart time in the window, walks the planned steps, and writes down what it would have done: which work it would have asked to stop, how long that work really took to reach its own stopping point, which delays and safety holds would have applied, and what has no declared way to stop.

It cannot restart a machine or stop any work. The build holds no restart command and no method that stops anything, its operating system commands come from a short list of readers, and a test of the source fails if that changes. It sends no notice, closes no work, and refuses nothing. Read it at `GET /machine-maintenance`, in `logs/machine-drain.jsonl`, or on the console's Machines page. It is dark on the fleet (`machineMaintenance`, development-agent gated) and never runs on a throwaway agent.

Spec: docs/specs/machine-self-maintenance.md. The real restart, enrolment, browser cleanup, wedge restart and app controls are later increments.

## What to Tell Your User

Nothing changes for you yet. On development machines I now practise a restart on paper each night and record what it would have done. It cannot restart anything.

## Summary of New Capabilities

- Registry First: "what would a nightly restart do to this machine?" and "is this machine overdue for a restart?" are answered by `GET /machine-maintenance`. Dark on the fleet.

## Evidence

- `tests/unit/machine-maintenance.test.ts`, `tests/unit/machine-maintenance-watch-only.test.ts`, `tests/integration/machine-maintenance-route.test.ts`, `tests/e2e/machine-maintenance-lifecycle.test.ts`.
- No night has run on a real machine yet. The first real evidence is the first night after this release reaches the development agent.
