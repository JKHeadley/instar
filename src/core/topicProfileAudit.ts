import fs from 'node:fs';
import path from 'node:path';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

/**
 * Topic Profile §10.3 — append one structured line to the profile audit
 * trail (logs/topic-profile-changes.jsonl). Size-capped like sibling audit
 * logs (simple head-truncation rotation at ~5MB). Never the triggering turn
 * text or any message content — structured deltas + verified principals only.
 */
let _topicProfileAuditSeq = 0;
let _topicProfileAuditDegraded = false;
export function appendTopicProfileAudit(stateDir: string, event: Record<string, unknown>): string {
  // The audit sequence stamp is included in rendered disclosures (§8 — so the
  // relay's exact-duplicate window can never silently swallow a repeat notice).
  const seq = `${Date.now().toString(36)}.${++_topicProfileAuditSeq}`;
  const logsDir = path.join(stateDir, '..', 'logs');
  const auditPath = path.join(logsDir, 'topic-profile-changes.jsonl');
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    try {
      const stat = fs.statSync(auditPath);
      if (stat.size > 5 * 1024 * 1024) {
        // Keep the newest half on overflow — same pragmatic cap as siblings.
        const lines = fs.readFileSync(auditPath, 'utf-8').split('\n');
        fs.writeFileSync(auditPath, lines.slice(Math.floor(lines.length / 2)).join('\n'));
      }
    } catch { /* @silent-fallback-ok: no audit file yet — the trim is a best-effort size cap, the append below recreates it (TOPIC-PROFILE-SPEC §10.3) */ }
    fs.appendFileSync(auditPath, `${JSON.stringify({ ts: new Date().toISOString(), seq, ...event })}\n`);
    _topicProfileAuditDegraded = false;
  } catch {
    // Preserve a local metadata trace before any refusal returns. This is not
    // a successful primary audit receipt, and never permission to repeat a write.
    const trace: Record<string, unknown> = { seq, reason: 'primary-audit-unavailable' };
    for (const key of ['type', 'topic', 'requestId', 'attemptId', 'messageId', 'outcome', 'contextRequestId']) {
      const value = event[key];
      if (typeof value === 'number' && Number.isSafeInteger(value)) trace[key] = value;
      else if (typeof value === 'string' && /^[A-Za-z0-9:_.-]+$/.test(value)) trace[key] = value;
    }
    if (typeof event.reason === 'string' && /^[A-Za-z0-9:_.-]+$/.test(event.reason)) trace.refusalReason = event.reason;
    console.error('[topic-profile-audit-fallback]', JSON.stringify(trace));
    try {
      // One bounded retry repairs a transient append failure without retrying
      // the profile mutation. Persistent primary failure stays health-only
      // while the captured fallback trace and ordinary user response survive.
      fs.mkdirSync(logsDir, { recursive: true });
      fs.appendFileSync(auditPath, `${JSON.stringify({ ts: new Date().toISOString(), seq, ...event })}\n`);
      _topicProfileAuditDegraded = false;
    } catch {
      if (!_topicProfileAuditDegraded) {
        _topicProfileAuditDegraded = true;
        DegradationReporter.getInstance().report({ feature: 'topic-profile.audit',
          primary: 'Structured topic-profile audit file', fallback: 'Metadata-only trace in the deciding server log',
          reason: 'Primary append and bounded retry failed',
          impact: 'Profile outcomes remain unchanged; audit file needs repair. No user message or write is retried.', internalOnly: true });
      }
    }
  }
  return seq;
}

