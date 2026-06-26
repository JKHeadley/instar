/**
 * EnforcedTerminationWatchdog wiring — the adapters that bridge the pure
 * decision core to real instar state. This file holds the READ side (the
 * `listRuns` adapter that reads autonomous state files into snapshots) plus the
 * audit sink. The session-killing ACTUATOR is built in server.ts where the live
 * SessionManager / ResumeQueue / operator-stop recorder are in scope, mirroring
 * AutonomousLivenessReconciler.settleKill — it is deliberately NOT here so this
 * module stays free of a session killer and remains unit-testable against real
 * files. Spec: docs/specs/enforced-termination-watchdog.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { listAutonomousJobs, readAutonomousRunMarkers } from '../core/AutonomousSessions.js';
import type { AutonomousRunSnapshot } from './enforcedTermination.js';
import type { EnforcedTerminationAuditRow } from './EnforcedTerminationWatchdog.js';

/**
 * Build the `listRuns` provider: read every per-topic autonomous run file and
 * project it into the pure-core snapshot. Legacy single-file jobs (topic === null)
 * are skipped — the watchdog only governs per-topic runs (the only ones with a
 * resolvable session to terminate). Each snapshot is durable-state only (file
 * frontmatter + mtime), so the overrun decision survives a server restart.
 */
export function buildEnforcedTerminationListRuns(stateDir: string): () => AutonomousRunSnapshot[] {
  return () => {
    const out: AutonomousRunSnapshot[] = [];
    for (const job of listAutonomousJobs(stateDir)) {
      if (!job.topic) continue; // skip legacy single-file jobs (no per-topic session)
      const startedAtMs =
        job.startedAt != null && Number.isFinite(new Date(job.startedAt).getTime())
          ? new Date(job.startedAt).getTime()
          : null;
      let fileMtimeMs = 0;
      try {
        fileMtimeMs = fs.statSync(job.file).mtimeMs;
      } catch {
        fileMtimeMs = 0; // unreadable mtime → 0 epoch; the ceiling check then treats it as very old
      }
      const markers = readAutonomousRunMarkers(stateDir, job.topic);
      const moveSuspended = markers != null && (markers.moveSuspended || markers.movedTo != null);
      out.push({
        topicId: job.topic,
        startedAtMs,
        fileMtimeMs,
        durationSeconds: job.durationSeconds,
        iteration: job.iteration ?? 0,
        active: job.active,
        paused: job.paused,
        moveSuspended,
      });
    }
    return out;
  };
}

/**
 * Build the audit sink: append one JSON line per transition to
 * `logs/enforced-termination.jsonl`. Bounded rotation at ~5MB so the audit can
 * never grow unbounded. Wrapped by the watchdog's safeAudit so a write error
 * never reaches the loop, but we also swallow here for defense in depth.
 */
export function buildEnforcedTerminationAudit(logsDir: string): (row: EnforcedTerminationAuditRow) => void {
  const file = path.join(logsDir, 'enforced-termination.jsonl');
  const MAX_BYTES = 5 * 1024 * 1024;
  return (row: EnforcedTerminationAuditRow) => {
    try {
      try {
        const st = fs.statSync(file);
        if (st.size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
      } catch {
        /* no existing file */
      }
      fs.mkdirSync(logsDir, { recursive: true });
      fs.appendFileSync(file, JSON.stringify(row) + '\n');
    } catch {
      /* audit must never endanger the loop */
    }
  };
}
