/**
 * Production canary for the real anomaly episode engine. Everything is in
 * memory, namespaced to the canary run, and transport is a tripwire: no
 * Telegram send or model call can leave this process.
 */
import type { JobDefinition } from '../core/types.js';
import { JobAnomalyEpisodeStore, EPISODE_STALE_INTERVALS } from './JobAnomalyEpisodeStore.js';
import { JobAnomalyNarrator } from './JobAnomalyNarrator.js';
import { JobAnomalyPusher, cronIntervalMs, type AttentionRaise } from './JobAnomalyPusher.js';
import type { ParsedAnomaly, ParsedScriptRun } from './jobScriptProtocol.js';
import type { CanaryClock, EpisodeHarnessResult } from './ScriptCanaryRunner.js';

const HOUR = 3_600_000;

function parsed(anomalies: ParsedAnomaly[]): ParsedScriptRun {
  return {
    result: 'success', reason: '', reasonCode: '', summary: 'canary', anomalies,
    ignoredAnomalies: 0, fields: {}, droppedFields: 0, missingResultLine: false,
    overCap: false,
  };
}

/** Run the health-check episode transitions with an injected clock. */
export async function verifyJobAnomalyEpisodes(
  job: JobDefinition,
  runId: string,
  reasons: ParsedAnomaly[],
  clock: CanaryClock,
): Promise<EpisodeHarnessResult> {
  const failures: string[] = [];
  const critical = reasons.find(reason => reason.class === 'critical');
  const recoverable = reasons.find(reason => reason.class === 'recoverable');
  if (!critical) failures.push('fixture has no critical reason');
  if (!recoverable) failures.push('fixture has no recoverable reason');
  if (failures.length) return { ok: false, failures };

  const auditRows: Array<Record<string, unknown>> = [];
  const raised: AttentionRaise[] = [];
  const cleared: string[] = [];
  let forbiddenSends = 0;
  let heals = 0;
  const store = new JobAnomalyEpisodeStore({ filePath: null, namespace: `canary:${runId}:`, now: clock.now });
  const audit = { append: (row: Record<string, unknown>) => { auditRows.push(row); } };
  const pusher = new JobAnomalyPusher({
    store,
    narrator: new JobAnomalyNarrator({ intelligence: null, audit, now: clock.now }),
    machineId: 'canary', now: clock.now, auditOnlyRunId: runId, audit,
    raiseAttention: item => { raised.push(item); },
    clearAttention: key => { cleared.push(key); },
    sendAutomationReply: async () => {
      forbiddenSends++;
      throw new Error('canary attempted an origin send');
    },
    sendDeterministicTopic: async () => {
      forbiddenSends++;
      throw new Error('canary attempted a topic send');
    },
    ensureJobTopic: async () => 1,
    requestHealAttempt: async () => { heals++; return 'refused:canary-no-session'; },
    triageEnabled: () => true,
    jobBySlug: slug => slug === job.slug ? job : undefined,
  });
  let seq = 0;
  const run = (anomalies: ParsedAnomaly[]) => pusher.processRun({
    job, machineId: 'canary', runId: `${runId}:${++seq}`, parsed: parsed(anomalies),
  });
  const pushCount = () => auditRows.filter(row => row.kind === 'push-audit-only').length;
  const calmCount = () => raised.filter(item => item.priority === 'LOW').length;

  // The fixture's real reason lines must open both classes. Critical pushes
  // immediately, recoverable only opens a calm item.
  const first = await run(reasons);
  if (first.push?.outcome !== 'audit-only') failures.push('critical reason did not push in audit-only mode');
  if (calmCount() < 1) failures.push('recoverable reason did not raise a calm item');
  if (!auditRows.some(row => row.kind === 'narration-audit-only' && row.runId === runId)) {
    failures.push('narrator was not reached in audit-only mode');
  }

  // Three clean results close the opening episodes and clear the calm item.
  for (let i = 0; i < 3; i++) { clock.advance(60_000); await run([]); }
  if (store.listOpen(job.slug).length !== 0) failures.push('three clean runs did not close episodes');
  if (cleared.length === 0) failures.push('closed recoverable episode did not clear its calm item');

  // A fresh recoverable episode is silent before six hours. Its heal request
  // must settle before the persistence push can be recorded.
  const beforePersistence = pushCount();
  await run([recoverable!]);
  if (pushCount() !== beforePersistence) failures.push('recoverable reason pushed before six hours');
  clock.advance(6 * HOUR);
  const persisted = await run([recoverable!]);
  if (heals < 1) failures.push('persistence push skipped the heal attempt');
  if (persisted.push?.outcome !== 'audit-only' || pushCount() <= beforePersistence) {
    failures.push('persistent recoverable reason did not push in audit-only mode');
  }

  // A job that stops running retires its open episode after the stale window.
  const interval = cronIntervalMs(job.schedule) ?? 15 * 60_000;
  clock.advance((EPISODE_STALE_INTERVALS + 1) * interval);
  await pusher.tick();
  if (store.listOpen(job.slug).length !== 0) failures.push('stale episode did not expire');

  // Start outside the prior six-hour recurrence window, then open three short
  // recoverable episodes. The third may push once; subsequent openings inside
  // the 24-hour mute must not push again. A new critical episode still pushes.
  clock.advance(7 * HOUR);
  const beforeRecurrence = pushCount();
  const cycle = async () => {
    await run([recoverable!]);
    for (let i = 0; i < 3; i++) { clock.advance(60_000); await run([]); }
  };
  await cycle();
  await cycle();
  await cycle();
  if (pushCount() !== beforeRecurrence + 1) failures.push('three recoverable episodes did not produce one recurrence push');
  await cycle();
  await cycle();
  if (pushCount() !== beforeRecurrence + 1) failures.push('recurrence push was not muted for 24 hours');
  const beforeCritical = pushCount();
  await run([critical!]);
  if (pushCount() !== beforeCritical + 1) failures.push('critical episode was muted with recoverable recurrence');

  if (forbiddenSends !== 0) failures.push('canary attempted a real send');
  return { ok: failures.length === 0, failures };
}
