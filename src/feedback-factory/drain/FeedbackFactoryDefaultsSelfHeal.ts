import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SelfHealGate, SqliteSelfHealEpisodeStore, type SelfHealNotice } from '../../core/SelfHealGate.js';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import { consumeAdmissionToken, governor } from '../../monitoring/selfaction/governor.js';
import type { DerivedTarget } from '../../monitoring/selfaction/types.js';
import { ensureFeedbackFactoryGeneratedDefaults, inspectFeedbackFactoryGeneratedDefaults, type GeneratedDefaultsInspection } from './FeedbackFactoryGeneratedDefaults.js';

/* @self-action-controller: feedback-factory-generated-defaults-heal */
const feedbackDefaultsGovernor = governor.for('feedback-factory-generated-defaults-heal');
function deriveTargetKey(target: DerivedTarget): DerivedTarget { return target; }

export interface FeedbackDefaultsHealOptions {
  stateDir: string;
  developmentAgent: boolean;
  bootId: string;
  currentFence: () => string | null;
  notify: (notice: SelfHealNotice) => void | Promise<void>;
  audit?: (event: { event: string; reason?: string; elapsedMs?: number }) => void;
}

type HealContext = { inspection: GeneratedDefaultsInspection; fence: string | null };

export function requestSelfHealRestart(stateDir: string, stableRequestId: string): boolean {
  const dir = path.join(stateDir, 'state'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const destination = path.join(dir, 'restart-requested.json');
  if (fs.existsSync(destination)) {
    try { return (JSON.parse(fs.readFileSync(destination, 'utf8')) as { requestId?: string }).requestId === stableRequestId; } catch { return false; }
  }
  const tmp = path.join(dir, `.restart-request.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  const body = JSON.stringify({ requestedAt: new Date().toISOString(), requestedBy: 'self-heal-gate', requestId: stableRequestId, plannedRestart: true, pid: process.pid }, null, 2);
  try {
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try { fs.writeFileSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.linkSync(tmp, destination); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return (JSON.parse(fs.readFileSync(destination, 'utf8')) as { requestId?: string }).requestId === stableRequestId;
    }
    return true;
  } catch { return false; }
  finally { try { SafeFsExecutor.safeUnlinkSync(tmp, { operation: 'feedback-defaults-self-heal restart temp cleanup' }); } catch { /* already absent */ } }
}

export async function runFeedbackFactoryDefaultsSelfHeal(options: FeedbackDefaultsHealOptions): Promise<{ attempted: boolean; outcome: string }> {
  const stateFailure = async (): Promise<{ attempted: boolean; outcome: string }> => {
    try { await options.notify({ id: `self-heal:feedback-factory-generated-defaults-heal:state-failure:${options.bootId}`, controllerId: 'feedback-factory-generated-defaults-heal', reason: 'state-failure', priority: 'HIGH' }); }
    catch { options.audit?.({ event: 'notice-enqueue-failed', reason: 'state-failure' }); }
    options.audit?.({ event: 'state-failure', reason: 'store-preflight-failed' });
    return { attempted: false, outcome: 'state-failure' };
  };
  let store: SqliteSelfHealEpisodeStore;
  try { store = new SqliteSelfHealEpisodeStore(path.join(options.stateDir, 'state', 'self-heal-gate.db')); }
  catch { return stateFailure(); }
  const makeContext = (): HealContext => ({ inspection: inspectFeedbackFactoryGeneratedDefaults(options.stateDir, options.developmentAgent), fence: options.currentFence() });
  const gate = new SelfHealGate<HealContext>({
    id: 'feedback-factory-generated-defaults-heal', controllerResource: 'hardware-bound', episodeAuthority: 'durable-machine-local', classId: 'feedback-generated-defaults',
    severity: (ctx) => ctx.inspection.posture === 'unsafe' ? 'unknown' : 'recoverable', dedupeKey: () => 'generated-defaults',
    eligible: () => { const fence = options.currentFence(); return { eligible: fence !== null, fence }; },
    remediation: () => {
      const before = inspectFeedbackFactoryGeneratedDefaults(options.stateDir, options.developmentAgent);
      if (before.posture === 'unsafe') return { outcome: 'not-healed', evidence: before.reason };
      if (before.posture === 'healthy') return { outcome: 'healed', evidence: 'already-healthy' };
      const result = ensureFeedbackFactoryGeneratedDefaults(options.stateDir, options.developmentAgent);
      const after = inspectFeedbackFactoryGeneratedDefaults(options.stateDir, options.developmentAgent);
      if (after.posture !== 'healthy') return { outcome: 'not-healed', evidence: 'verification-failed' };
      return result.changed ? { outcome: 'pending-restart', evidence: 'repaired' } : { outcome: 'healed', evidence: 'already-healthy' };
    },
    restartVerified: (ctx) => ctx.inspection.posture === 'healthy', maxAttempts: 3, maxWallClockMs: 10 * 60_000,
    backoffMs: (attempt) => [0, 30_000, 120_000][Math.max(0, attempt - 1)] ?? 120_000, notificationLatencyCeilingMs: 2 * 60_000,
    flap: { maxRecoveries: 3, windowMs: 24 * 60 * 60_000 }, remediationActions: { operation: 'generated-defaults-repair', idempotencyGuard: 'exclusive-temp-atomic-rename', compensation: 'destination-unchanged-before-rename' },
  }, {
    admit: (target, admitOptions) => feedbackDefaultsGovernor.admit(deriveTargetKey(target), admitOptions), consumeToken: consumeAdmissionToken, notify: options.notify,
    audit: (event) => options.audit?.({ event: event.event, reason: event.reason, elapsedMs: event.elapsedMs }), episodeStore: store,
    bootId: options.bootId, requestRestart: (id) => requestSelfHealRestart(options.stateDir, id),
  });
  const ctx = makeContext();
  if (ctx.inspection.posture === 'fleet-dark') { store.close(); return { attempted: false, outcome: 'fleet-dark' }; }
  let restartVerificationRequired: boolean;
  try { restartVerificationRequired = gate.needsRestartVerification(ctx); }
  catch { store.close(); return stateFailure(); }
  if (ctx.inspection.posture === 'healthy' && !restartVerificationRequired) { store.close(); return { attempted: false, outcome: 'healthy' }; }
  const result = await gate.attempt(ctx);
  // Keep the store alive for an enforce-mode governor queue continuation.
  return { attempted: true, outcome: result.outcome };
}
