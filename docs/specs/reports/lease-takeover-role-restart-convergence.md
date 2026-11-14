# Convergence report: lease-takeover-role-restart

**Outcome: stopped by proportion after 2 rounds, not by a clean round.** The last outside verdict was still
"serious issues". Its one design point needs a stamp that cannot be written and a flapping lease together. Building
recovery for that behind a dark switch would be over-building, so the limit is stated in the spec instead.

| Round | Standards-Conformance Gate | Internal | Outside (codex-cli, gpt-6-astra) | Result |
|---|---|---|---|---|
| 1 | not run | not run | serious issues, 3 | demotion pauses jobs at once; request before stamp; one-minute retry |
| 2 | not run | not run | serious issues, 2 | job gap stated; double failure stated as an accepted limit |

Round 1's catch mattered: a throttled restart would have left jobs running in two places.

## Limits left behind

- With the stamp unwritable and a flapping lease, restarts are not bounded to one per 15 minutes.
- A second promotion inside the window can leave up to 15 minutes with no jobs.
- Telegram polling is separate and still needs `pollFollowsLease`.
- Not yet proven live: that needs the power-off and link-cut drills.
