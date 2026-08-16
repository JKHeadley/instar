# Guardian Overseer Handoff — 2026-04-12 01:02 UTC

## System State: DEGRADED (worsening)

---

### CRITICAL: Scheduler stuck-nextScheduled bug is widespread (7 jobs affected)

Previous handoff flagged 2 jobs. Now 7 jobs have stale nextScheduled times and will not run again without manual intervention:

| Job | Overdue |
|-----|---------|
| ci-monitor | 24.0h |
| docs-code-sync | 22.0h |
| overseer-maintenance | 16.0h |
| overseer-learning | 15.0h |
| overseer-infrastructure | 12.0h |
| overseer-development | 10.0h |
| relationship-maintenance | 9.0h |

Root cause: scheduler does not advance `nextScheduled` on failed/stale jobs. This is a growing problem — more jobs will join this list over time without a fix. The entire overseer tier (maintenance, learning, infrastructure, development) is currently non-functional.

**Action needed**: Fix scheduler to reset `nextScheduled` on job completion regardless of result.

---

### CRITICAL: degradation-digest permanently gated (still unfixed)

- `degradation-events.json` = `[]` (empty, unchanged)
- Gate: requires non-empty array → will never pass
- 19 gate skips in last 24h, 0 lifetime runs
- Degradation monitoring is completely blind. No events are being recorded to trigger the digest.

**Action needed**: Populate `degradation-events.json` with events, or fix the gate to also run when the file is empty (and report "no events to digest").

---

### NEW: state-integrity-check timeout pattern (3/5 recent runs timed out)

- Consistent 75s timeouts, but job `expectedDurationMinutes=1` (60s limit)
- Timeouts occur at: Apr 10 19:00 UTC, Apr 11 01:00 UTC, Apr 12 01:00 UTC
- Successes occur at: Apr 11 17:46 and 19:00 UTC (complete in ~20s)
- Currently at 1 consecutive failure

The skill is non-deterministic in duration — sometimes ~20s, sometimes ~75s+. Could be system load or skill behavior differences. The expectedDurationMinutes=1 timeout is too tight given observed runtime. Either increase the timeout to 3 minutes or investigate why some runs take 3x longer.

**Action needed**: Increase `expectedDurationMinutes` to 3 for state-integrity-check, or investigate skill timeout variability.

---

### Healthy Jobs

- **health-check**: 96.8% success, 95 runs/24h, haiku, stable. No concerns.
- **guardian-pulse**: 100% success last 2 runs, avg 55s. Healthy.
- **session-continuity-check**: 100% success, 3 runs. Found continuity gaps (commitment-detection and reflection-trigger not writing handoffs) — low-severity, ongoing.

---

### Persistent Infrastructure Issues

- **Handoff API** (`/jobs/{slug}/handoff`) returns 404 for all jobs — state files exist on disk but API doesn't serve them. Overseers must read files directly.
- **Auto-memory dead** — Claude Code not writing to session memory. No interactive sessions to trigger it; expected.

---

### Trend Summary

The guardian tier itself is healthy (health-check, guardian-pulse, session-continuity-check all running). The monitoring *subjects* are increasingly blind:
1. Degradation monitoring never worked
2. 7 jobs are stuck and not running (entire overseer tier + ci-monitor + docs-code-sync)
3. state-integrity-check failing at 1AM UTC slots

The scheduler stale-nextScheduled bug is the highest-priority systemic fix needed.
