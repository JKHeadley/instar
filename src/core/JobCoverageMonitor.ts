/** Peer observation and promotion comparison for scheduler coverage. */
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { JobDefinition } from './types.js';
import type { MachineIdentityManager } from './MachineIdentity.js';
import { isRegistryEntryActive } from './MachineIdentity.js';
import { isPeerUrlAllowedForCredentials, type PeerEndpointKind } from '../server/peerUrlGuard.js';
import { poolPeerFetch, type PoolPeerTarget, type RopeResultRecorder } from '../server/poolPeerFetch.js';
import { loadJobsDetailed } from '../scheduler/JobLoader.js';
import { reconcileLegacyDefaultJobs } from '../scheduler/JobCatalogReconcile.js';
import { jobDependencyExists } from './JobDependency.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';
import { JobCoverageStore, type JobCoverageEntry, acceptJobCoverage, assignJobCoverageGeneration, compareJobCoverage, projectJobCoverage, signJobCoverage } from './JobCoverage.js';

export interface JobCoverageMonitorOptions {
  stateDir: string;
  jobsFile: string;
  projectDir: string;
  port: number;
  onCatalogRepair?: () => void;
  reconcileDefaults?: (jobsFile: string, port: number) => string[];
  authToken: string;
  identityManager: MachineIdentityManager;
  isAwake: () => boolean;
  peerUrls: () => Array<PoolPeerTarget & { kind: PeerEndpointKind }>;
  recordRopeResult?: RopeResultRecorder;
  onPortableCandidate?: (peer: PoolPeerTarget & { kind: PeerEndpointKind }, job: JobCoverageEntry, generation: string) => Promise<void>;
  portableGaps?: () => string[];
  alert: (conditionKey: string, title: string, summary: string) => Promise<void>;
  clearAlert?: (conditionKey: string) => void;
  now?: () => number;
}

/** Reads only the installed catalog. Scheduler-less standby still has a catalog. */
export function readJobCoverageCatalog(jobsFile: string): { jobs: JobDefinition[]; complete: boolean } {
  try {
    if (!fs.existsSync(jobsFile) && !fs.existsSync(path.join(path.dirname(jobsFile), 'jobs', 'schedule'))) {
      return { jobs: [], complete: false };
    }
    const loaded = loadJobsDetailed(jobsFile, { quiet: true });
    return { jobs: loaded.jobs, complete: loaded.problems.length === 0 && loaded.bodyFailures.length === 0
      && !loaded.diagnostics.some(d => d.level === 'error') };
  } catch {
    return { jobs: [], complete: false };
  }
}

async function readBoundedJson(response: Response, maxBytes = 256 * 1024): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty-body');
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error('oversized-snapshot');
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const merged = new Uint8Array(length);
  let at = 0;
  for (const part of parts) { merged.set(part, at); at += part.byteLength; }
  return JSON.parse(new TextDecoder().decode(merged));
}

export class JobCoverageMonitor {
  readonly store: JobCoverageStore;
  private readonly options: JobCoverageMonitorOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private stopped = false;
  private failures = new Map<string, { count: number; nextEligibleAt: number }>();
  private readonly failureFile: string;
  private readonly portableCursorFile: string;
  private portableCursors: Record<string, number> = {};
  private readonly auditFile: string;
  private readonly alertFile: string;
  private reconciled = false;
  constructor(options: JobCoverageMonitorOptions) {
    this.options = options;
    this.store = new JobCoverageStore(options.stateDir);
    this.alertFile = path.join(options.stateDir, 'state', 'job-coverage-alert.json');
    this.failureFile = path.join(options.stateDir, 'state', 'job-coverage-poll.json');
    this.portableCursorFile = path.join(options.stateDir, 'state', 'job-portable-cursors.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(this.portableCursorFile, 'utf8'));
      if (parsed.version === 1 && parsed.cursors && typeof parsed.cursors === 'object') this.portableCursors = parsed.cursors;
    } catch { /* first observation starts at the first portable job */ }
    this.auditFile = path.join(options.stateDir, 'state', 'job-coverage-audit.jsonl');
    this.failures = this.readFailures();
  }
  localSnapshot(nonce: string) {
    const identity = this.options.identityManager.loadIdentity();
    const catalog = readJobCoverageCatalog(this.options.jobsFile);
    const payload = assignJobCoverageGeneration(projectJobCoverage(identity.machineId, catalog.jobs, catalog.complete), this.options.stateDir);
    return signJobCoverage(payload, nonce, this.options.identityManager.loadSigningKey());
  }
  start(): void {
    if (this.timer || this.stopped) return;
    const tick = () => { void this.poll().then(() => this.checkPromotionCoverage())
      .catch(error => { /* @silent-fallback-ok — the next bounded tick retries; the error is logged */ console.warn('[job-coverage] tick failed:', error); }); };
    this.firstTimer = setTimeout(tick, 2000);
    this.firstTimer.unref?.();
    this.timer = setInterval(tick, 5 * 60_000);
    this.timer.unref?.();
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.timer = null;
    this.firstTimer = null;
  }
  async poll(): Promise<void> {
    if (this.inFlight || this.stopped) return;
    this.inFlight = true;
    try {
      const identity = this.options.identityManager.loadIdentity();
      const registered = Object.entries(this.options.identityManager.loadRegistry().machines)
        .filter(([id, entry]) => id !== identity.machineId && isRegistryEntryActive(entry));
      const urls = new Map(this.options.peerUrls().map(p => [p.machineId, p]));
      // Two requests at a time, no overlapping ticks.
      for (let i = 0; i < registered.length; i += 2) {
        await Promise.all(registered.slice(i, i + 2).map(async ([id]) => {
          const peer = urls.get(id);
          const now = this.options.now?.() ?? Date.now();
          if (now < (this.failures.get(id)?.nextEligibleAt ?? 0)) return;
          if (!peer) { this.markPeerFailure(id, 'no-reachable-url', now); return; }
          if (!isPeerUrlAllowedForCredentials({ url: peer.url, kind: peer.kind }).ok) {
            this.markPeerFailure(id, 'url-refused', now); return;
          }
          const publicKey = this.options.identityManager.getSigningPublicKeyPem(id);
          if (!publicKey) { this.markPeerFailure(id, 'identity-unverifiable', now); return; }
          let lastError: unknown = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            const nonce = randomBytes(32).toString('hex');
            try {
              const response = await poolPeerFetch(this.options.recordRopeResult, peer,
                `/jobs/coverage-snapshot?nonce=${nonce}`, { headers: { Authorization: `Bearer ${this.options.authToken}` },
                  signal: AbortSignal.timeout(3000), redirect: 'manual' });
              if (!response.ok) throw new Error(`http-${response.status}`);
              const payload = acceptJobCoverage(await readBoundedJson(response), id, nonce, publicKey);
              if (!payload) throw new Error('invalid-signed-snapshot');
              this.store.record(payload, new Date(now));
              if (this.options.onPortableCandidate) {
                // A bounded transfer attempt follows a verified advertisement; failure is
                // logged as a portability gap and never reclassifies signed metadata as bad.
                const candidates = payload.jobs.filter(row => row.portable === true);
                const start = (this.portableCursors[id] ?? 0) % Math.max(1, candidates.length);
                const selected = candidates.length > 20
                  ? Array.from({ length: 20 }, (_, n) => candidates[(start + n) % candidates.length])
                  : candidates;
                this.portableCursors[id] = candidates.length ? (start + selected.length) % candidates.length : 0;
                fs.mkdirSync(path.dirname(this.portableCursorFile), { recursive: true });
                const cursorTmp = `${this.portableCursorFile}.${process.pid}.tmp`;
                fs.writeFileSync(cursorTmp, JSON.stringify({ version: 1, cursors: this.portableCursors }), { mode: 0o600 });
                fs.renameSync(cursorTmp, this.portableCursorFile);
                for (const job of selected) {
                  try { await this.options.onPortableCandidate(peer, job, payload.generation); }
                  catch (error) {
                    featureEvidence.record('multiMachine.jobDefinitionSync', { kind: 'error',
                      reason: 'portable transfer unavailable', context: { source: id, slug: job.slug } });
                    console.warn(`[job-coverage] portable transfer unavailable for ${job.slug}:`, error);
                  }
                }
              }
              this.failures.delete(id);
              this.writeFailures();
              this.audit('peer-observed', id);
              lastError = null;
              break;
            } catch (error) { lastError = error; }
          }
          if (lastError) {
            const message = lastError instanceof Error ? lastError.message : '';
            const failureClass = /^(?:http-[0-9]{3}|invalid-signed-snapshot|oversized-snapshot|empty-body)$/.test(message)
              ? message : 'fetch-failed';
            this.markPeerFailure(id, failureClass, now);
          }
        }));
      }
    } catch (error) {
      console.warn('[job-coverage] poll failed:', error);
    } finally { this.inFlight = false; }
  }
  async checkPromotionCoverage(): Promise<void> {
    if (!this.options.isAwake() || this.stopped) return;
    const identity = this.options.identityManager.loadIdentity();
    if (!this.reconciled) {
      try {
        const installed = (this.options.reconcileDefaults ?? reconcileLegacyDefaultJobs)(this.options.jobsFile, this.options.port);
        if (installed.length > 0) {
          this.options.onCatalogRepair?.();
          this.audit('catalog-repaired', identity.machineId, String(installed.length));
        }
        this.reconciled = true;
      } catch (error) { console.warn('[job-coverage] safe catalog repair failed:', error); }
    }
    const local = readJobCoverageCatalog(this.options.jobsFile);
    const own = projectJobCoverage(identity.machineId, local.jobs, local.complete);
    const observations = this.store.list(this.options.now?.() ?? Date.now());
    const registered = Object.entries(this.options.identityManager.loadRegistry().machines)
      .filter(([id, entry]) => id !== identity.machineId && isRegistryEntryActive(entry));
    const active = Object.fromEntries(Object.entries(observations)
      .filter(([id]) => registered.some(([registeredId]) => registeredId === id)));
    const differences = compareJobCoverage(own.jobs, active, identity.machineId, identity.name);
    for (const job of local.jobs) {
      if (!job.enabled || !job.requiredPaths?.length) continue;
      if (job.requiredPaths.some(dependency => !jobDependencyExists(this.options.projectDir, dependency))) {
        differences.push({ slug: job.slug, sourceMachineId: identity.machineId,
          reason: 'dependency', observedAt: new Date().toISOString(), stale: false });
      }
    }
    const unknown = registered.filter(([id]) => !observations[id] || observations[id].status !== 'fresh').map(([id]) => id);
    const portableGaps = this.options.portableGaps?.() ?? [];
    if (differences.length === 0 && unknown.length === 0 && portableGaps.length === 0 && local.complete) {
      if (fs.existsSync(this.alertFile)) {
        try {
          this.options.clearAlert?.('lease-job-coverage');
          SafeFsExecutor.safeRmSync(this.alertFile, { force: true, operation: 'JobCoverageMonitor.closeRecoveredEpisode' });
          this.audit('coverage-recovered', identity.machineId);
        } catch (error) { console.warn('[job-coverage] could not close recovered alert:', error); }
      }
      return;
    }
    const summary = [
      ...(!local.complete ? ['Local job catalog is incomplete; coverage cannot be proven'] : []),
      ...differences.slice(0, 20).map(d => `${d.slug}: ${d.reason} (seen on ${d.sourceMachineId}${d.stale ? ', stale' : ''})`),
      ...portableGaps.slice(0, 20),
      ...(unknown.length ? [`Coverage uncertain for ${unknown.length} peer(s): ${unknown.slice(0, 5).join(', ')}`] : []),
    ].join('\n');
    const conditionKey = 'lease-job-coverage';
    const now = this.options.now?.() ?? Date.now();
    const fingerprint = createHash('sha256').update(summary).digest('hex');
    const prior = this.readAlertState();
    if (prior?.fingerprint === fingerprint) {
      const floor = prior.deliveredAt ? 24 * 60 * 60_000 : 60 * 60_000;
      if (now - prior.at < floor) return;
    }
    this.writeAlertState({ fingerprint, at: now, deliveredAt: null });
    try {
      await this.options.alert(conditionKey, 'Scheduled jobs need review after lease handoff', summary);
      this.writeAlertState({ fingerprint, at: now, deliveredAt: now });
      this.audit('coverage-alert-delivered', identity.machineId);
    } catch (error) { console.warn('[job-coverage] alert delivery failed:', error); }
  }
  private markPeerFailure(machineId: string, reason: string, now: number): void {
    const count = (this.failures.get(machineId)?.count ?? 0) + 1;
    this.failures.set(machineId, { count, nextEligibleAt: now + Math.min(30 * 60_000,
      count >= 3 ? 15 * 60_000 : 5 * 60_000 * 2 ** (count - 1)) });
    this.writeFailures();
    this.store.markUnavailable(machineId, reason);
    this.audit('peer-unavailable', machineId, reason);
  }
  private readFailures(): Map<string, { count: number; nextEligibleAt: number }> {
    try {
      const raw = fs.readFileSync(this.failureFile, 'utf8');
      if (raw.length > 32 * 1024) return new Map();
      const rows = JSON.parse(raw) as Record<string, { count: number; nextEligibleAt: number }>;
      return new Map(Object.entries(rows).filter(([id, row]) => /^[a-zA-Z0-9_-]{1,128}$/.test(id)
        && Number.isSafeInteger(row?.count) && row.count > 0 && row.count <= 100000
        && Number.isFinite(row.nextEligibleAt)));
    } catch { return new Map(); }
  }
  private writeFailures(): void {
    fs.mkdirSync(path.dirname(this.failureFile), { recursive: true });
    const tmp = `${this.failureFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.failures)), { mode: 0o600 });
    fs.renameSync(tmp, this.failureFile);
  }
  private audit(event: string, machineId: string, reason?: string): void {
    try {
      fs.mkdirSync(path.dirname(this.auditFile), { recursive: true });
      if (fs.existsSync(this.auditFile) && fs.statSync(this.auditFile).size > 1024 * 1024) {
        const rotated = `${this.auditFile}.1`;
        SafeFsExecutor.safeRmSync(rotated, { force: true, operation: 'JobCoverageMonitor.rotateAudit' });
        fs.renameSync(this.auditFile, rotated);
      }
      fs.appendFileSync(this.auditFile, JSON.stringify({ at: new Date(this.options.now?.() ?? Date.now()).toISOString(),
        event, machineId, ...(reason ? { reason: reason.slice(0, 100) } : {}) }) + '\n', { mode: 0o600 });
    } catch (error) { /* @silent-fallback-ok — audit loss is logged; coverage state remains authoritative */ console.warn('[job-coverage] audit write failed:', error); }
  }
  private readAlertState(): { fingerprint: string; at: number; deliveredAt: number | null } | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.alertFile, 'utf8')) as
        { fingerprint?: unknown; at?: unknown; deliveredAt?: unknown };
      if (typeof raw.fingerprint === 'string' && typeof raw.at === 'number') {
        return { fingerprint: raw.fingerprint, at: raw.at,
          deliveredAt: typeof raw.deliveredAt === 'number' ? raw.deliveredAt : null };
      }
    } catch { /* @silent-fallback-ok — no prior episode is normal */ }
    return null;
  }
  private writeAlertState(state: { fingerprint: string; at: number; deliveredAt: number | null }): void {
    fs.mkdirSync(path.dirname(this.alertFile), { recursive: true });
    const tmp = `${this.alertFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, this.alertFile);
  }
  view() {
    const identity = this.options.identityManager.loadIdentity();
    const local = readJobCoverageCatalog(this.options.jobsFile);
    const observations = this.store.list(this.options.now?.() ?? Date.now());
    const registered = Object.entries(this.options.identityManager.loadRegistry().machines)
      .filter(([id, entry]) => id !== identity.machineId && isRegistryEntryActive(entry));
    const peers = registered.map(([machineId]) => {
      const row = observations[machineId];
      const failureCount = this.failures.get(machineId)?.count ?? 0;
      return row ? { machineId, status: row.status, observedAt: row.observedAt,
        ageMs: Math.max(0, (this.options.now?.() ?? Date.now()) - Date.parse(row.observedAt)),
        jobCount: row.payload.jobs.length, complete: row.payload.complete, failureCount,
        reason: row.error ?? null }
        : { machineId, status: failureCount ? 'unavailable' : 'unknown', observedAt: null,
          ageMs: null, jobCount: null, complete: false, failureCount,
          reason: failureCount ? 'poll-failed' : null };
    });
    const active = Object.fromEntries(Object.entries(observations)
      .filter(([id]) => registered.some(([registeredId]) => registeredId === id)));
    const differences = compareJobCoverage(projectJobCoverage(identity.machineId, local.jobs, local.complete).jobs,
      active, identity.machineId, identity.name);
    for (const job of local.jobs) {
      if (job.enabled && job.requiredPaths?.some(dependency => !jobDependencyExists(this.options.projectDir, dependency))) {
        differences.push({ slug: job.slug, sourceMachineId: identity.machineId,
          reason: 'dependency', observedAt: new Date().toISOString(), stale: false });
      }
    }
    return { selfMachineId: identity.machineId, localComplete: local.complete, peers, differences };
  }
}
