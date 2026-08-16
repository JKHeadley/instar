# Upgrade Guide — vNEXT

## What Changed

### Guardian Job Network

Five new guardian jobs added to the default job set. These run automatically in the background to maintain agent coherence:

- **degradation-digest** (4h): Groups repeated degradation patterns and escalates trends
- **state-integrity-check** (6h): Cross-validates state file consistency, detects orphans and bloat
- **memory-hygiene** (12h): Reviews MEMORY.md for stale entries, duplicates, and quality issues
- **guardian-pulse** (8h): Meta-monitor that verifies other jobs are running and healthy
- **session-continuity-check** (4h): Verifies sessions produce lasting artifacts

All guardian jobs use gates for zero-token pre-screening and are silent when healthy.

**For existing agents:** New jobs are automatically added on next update via `refreshJobs()`. No manual configuration needed.

## What to Tell Your User

Your agent now has built-in self-monitoring. Five new background jobs watch for issues like state corruption, memory bloat, and silent job failures. They run automatically and only alert when something needs attention.

## Summary of New Capabilities

- **Guardian network**: 5 new self-monitoring jobs for agent coherence
- **Zero-token gates**: Jobs only run when there's actual work to do
- **Automatic deployment**: Existing agents get new jobs on next update
