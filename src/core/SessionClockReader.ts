/**
 * SessionClockReader — the I/O layer that turns active autonomous-state records
 * into computed SessionClocks. Read-only; never mutates a record. Keeps
 * SessionClock.ts pure (no fs). Spec: docs/specs/ROBUST-SESSION-TIME-AWARENESS-SPEC.md
 * (Component 3 query surface; the autonomous-state record is the substrate).
 */

import { activeAutonomousJobs } from './AutonomousSessions.js';
import { computeSessionClock, deriveLabel, type SessionClock } from './SessionClock.js';

/**
 * Read the computed clock for each ACTIVE autonomous-state record under `stateDir`.
 * Only records with a parseable `started_at` are returned. The emitted `label` is
 * DERIVED + sanitized from the record's `goal` (never the raw goal).
 *
 * @param topicFilter when set, return only the record bound to that topic
 *   (multi-session binding); a legacy single-file job (topic null) matches any
 *   filter only when there is no per-topic record for that topic.
 */
export function readSessionClocks(stateDir: string, nowMs: number, topicFilter?: string | null): SessionClock[] {
  const jobs = activeAutonomousJobs(stateDir);
  const clocks: SessionClock[] = [];
  for (const job of jobs) {
    if (!job.startedAt) continue; // no clock to compute without a start
    if (topicFilter != null && job.topic != null && job.topic !== topicFilter) continue;
    clocks.push(
      computeSessionClock(
        {
          label: deriveLabel(job.goal),
          kind: 'autonomous',
          startedAt: job.startedAt,
          durationSeconds: job.durationSeconds,
        },
        nowMs,
      ),
    );
  }
  return clocks;
}
