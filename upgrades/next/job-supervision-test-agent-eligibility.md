<!-- bump: patch -->

## What Changed

The scheduled-job supervision test cohort now recognizes Instar's actual
expiring throwaway-agent record. It rejects a boolean marker, malformed
record, or expired test agent. The audit and cohort rollout gates remain off.

## What to Tell Your User

The test-agent safety check is ready for the supervised trial. Jev result
decisions are still off while the benchmark and rollout checks continue.

## Summary of New Capabilities

- An unexpired, recorded throwaway agent can qualify for the test cohort once
  its separate code-owned rollout gates are reviewed and opened.

## Evidence

Focused tests cover a valid expiring record, boolean and malformed markers,
expired records, cohort separation, and the still-closed rollout state.
