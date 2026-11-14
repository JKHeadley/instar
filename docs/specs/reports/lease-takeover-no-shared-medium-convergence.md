# Convergence report: lease-takeover-no-shared-medium

**Outcome: converged in 3 rounds.** The outside reviewer went from serious issues to minor issues, and the
minor issues are fixed in the text and code.

## Iteration summary

| Round | Standards-Conformance Gate | Internal | Outside (codex-cli, gpt-6-astra) | Result |
|---|---|---|---|---|
| 1 | ran (1 flag) | 10 findings, not ready | serious issues, 3 | design changed |
| 2 | not rerun | not rerun | serious issues, 3 | pull bounded; hold needs a peer |
| 3 | not rerun | not rerun | minor issues, 3 | wording, logs, pass criteria, one test |

The gate's flag asked whether both machines believing they hold breaks Cross-Machine Coherence. The standard
allows a transient second belief and forbids a durable second authority; the spec says so and tests the heal.

## What changed along the way

- The first design made a cut-off machine wait for peers to be presumed gone. Review showed that left the main
  machine dark for about 14 minutes when a standby's lid closed, and could wedge after a restart. It was
  replaced by a simpler rule: a holder in an unnamed pool keeps its epoch. That also removed most ties.
- The first design dropped the preferred check in every pool. It now applies only to pools with no named machine.
- The store change was first unswitched. It now sits behind the same switch.
- Review found moving the lease does not start Telegram polling or the scheduler. The spec states this, and
  it is a condition of turning the switch on for anyone.

## Limits left behind

- During a cut with internet on both sides, two pollers fight and jobs run on both sides until reconnect.
- The live power-off and link-cut drills have not been run. No agent's behaviour changes until they pass.
- `pollFollowsLease` and scheduler start on promotion are still needed before step 3.
