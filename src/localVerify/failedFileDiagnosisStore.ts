/** Durable, coordinator-local one-attempt journal for advisory failed-file diagnosis. */
import fs from 'node:fs';
import path from 'node:path';
import { ATTEMPT_ID_RE } from './record.js';
import { classifyTestPath } from './inventory.js';
import { classifyComparisonSet, diagnosisKey, type DiagnosisClass, type DiagnosisFileComparison, type DiagnosisIdentity } from './failedFileDiagnosis.js';

export const DIAGNOSIS_LIMITS = Object.freeze({ maxAgeMs: 14 * 24 * 60 * 60_000, maxTerminal: 200, maxRunMs: 15 * 60_000 });

export interface DiagnosisMarker {
  key: string;
  identity: DiagnosisIdentity;
  attemptId: string;
  peerMachineId: string;
  leaseEpoch: number | null;
  state: 'reserved' | 'running' | 'done';
  createdAt: number;
  updatedAt: number;
  result?: { classification: DiagnosisClass; files: DiagnosisFileComparison[]; reason?: string; machineMinutes: number };
}

function validMarker(x: unknown): x is DiagnosisMarker {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const m = x as DiagnosisMarker;
  const i = m.identity;
  if (!i || typeof i !== 'object' || !Array.isArray(i.failedFiles) || i.failedFiles.length < 1 || i.failedFiles.length > 3
    || !i.failedFiles.every((f) => typeof f === 'string' && f.length <= 300
      && /^[A-Za-z0-9_./-]+\.test\.ts$/.test(f)
      && !f.split('/').some((part) => part === '' || part === '.' || part === '..')
      && classifyTestPath(f).kind === 'laned')
    || new Set(i.failedFiles).size !== i.failedFiles.length
    || [...i.failedFiles].sort().some((f, n) => f !== i.failedFiles[n])
    || typeof i.repo !== 'string' || !Number.isSafeInteger(i.pr) || i.pr <= 0
    || ![i.headSha, i.baseSha].every((s) => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s))
    || typeof i.baseRefName !== 'string' || typeof i.verifierVersion !== 'string' || typeof i.policyHash !== 'string') return false;
  return typeof m.key === 'string' && m.key === diagnosisKey(i)
    && typeof m.attemptId === 'string' && ATTEMPT_ID_RE.test(m.attemptId)
    && typeof m.peerMachineId === 'string' && !!m.peerMachineId && m.peerMachineId.length <= 200
    && (m.leaseEpoch === null || Number.isSafeInteger(m.leaseEpoch) && m.leaseEpoch >= 0)
    && ['reserved', 'running', 'done'].includes(m.state)
    && Number.isFinite(m.createdAt) && Number.isFinite(m.updatedAt)
    && m.createdAt <= m.updatedAt
    && (m.state !== 'done' || !!m.result && ['pr-reproducible', 'machine-or-flake', 'base-or-shared', 'inconclusive'].includes(m.result.classification)
      && Array.isArray(m.result.files) && m.result.files.length <= i.failedFiles.length
      && m.result.files.every((r) => !!r && i.failedFiles.includes(r.file) && r.originalPr === 'assertion-fail'
        && ['pass', 'assertion-fail', 'unknown'].includes(r.peerPr)
        && ['pass', 'assertion-fail', 'unknown'].includes(r.peerBase)
        && (r.sameAssertion === undefined || typeof r.sameAssertion === 'boolean')
        && (r.latestMainOnOrigin === undefined || ['pass', 'assertion-fail', 'unknown'].includes(r.latestMainOnOrigin)))
      && (m.result.classification === 'inconclusive'
        || classifyComparisonSet(m.result.files, i.failedFiles) === m.result.classification)
      && Number.isFinite(m.result.machineMinutes) && m.result.machineMinutes >= 0 && m.result.machineMinutes <= 15
      && (m.result.reason === undefined || typeof m.result.reason === 'string' && m.result.reason.length <= 160));
}

export class FailedFileDiagnosisStore {
  readonly file: string;
  private markers = new Map<string, DiagnosisMarker>();

  constructor(stateDir: string) {
    this.file = path.join(stateDir, 'state', 'local-verify', 'failed-file-diagnoses.json');
    if (!fs.existsSync(this.file)) return;
    let doc: { v?: number; markers?: unknown };
    try { doc = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as typeof doc; }
    catch { throw new Error('failed-file diagnosis state is unreadable'); }
    if (doc.v !== 1 || !Array.isArray(doc.markers) || !doc.markers.every(validMarker)) throw new Error('failed-file diagnosis state is unreadable');
    this.markers = new Map(doc.markers.map((m) => [m.key, m]));
  }

  get(key: string): DiagnosisMarker | null { return this.markers.get(key) ?? null; }
  list(): DiagnosisMarker[] { return [...this.markers.values()]; }

  /** Persist BEFORE contacting a peer. An existing key never dispatches again. */
  reserve(identity: DiagnosisIdentity, attemptId: string, peerMachineId: string, leaseEpoch: number | null, now: number): DiagnosisMarker | null {
    const key = diagnosisKey(identity);
    if (this.markers.has(key)) return null;
    const marker: DiagnosisMarker = { key, identity, attemptId, peerMachineId, leaseEpoch,
      state: 'reserved', createdAt: now, updatedAt: now };
    if (!validMarker(marker)) throw new Error('invalid failed-file diagnosis reservation');
    this.markers.set(key, marker);
    try { this.persist(now); } catch (e) { this.markers.delete(key); throw e; }
    return marker;
  }

  accepted(key: string, attemptId: string, now: number): boolean {
    const m = this.markers.get(key);
    if (!m || m.attemptId !== attemptId || m.state !== 'reserved') return false;
    const next = { ...m, state: 'running' as const, updatedAt: now };
    this.markers.set(key, next);
    try { this.persist(now); } catch (e) { this.markers.set(key, m); throw e; }
    return true;
  }

  finish(key: string, attemptId: string, result: NonNullable<DiagnosisMarker['result']>, now: number): boolean {
    const m = this.markers.get(key);
    if (!m || m.attemptId !== attemptId || m.state === 'done') return false;
    const next = { ...m, state: 'done' as const, updatedAt: now, result };
    if (!validMarker(next)) throw new Error('invalid failed-file diagnosis result');
    this.markers.set(key, next);
    try { this.persist(now); } catch (e) { this.markers.set(key, m); throw e; }
    return true;
  }

  /** Unknown, timeout, lease loss and transport errors are terminal observations. */
  inconclusive(key: string, attemptId: string, reason: string, now: number): boolean {
    const m = this.markers.get(key);
    if (!m || m.attemptId !== attemptId) return false;
    const machineMinutes = m.state === 'running' ? Math.min(15, Math.max(0, now - m.updatedAt) / 60_000) : 0;
    return this.finish(key, attemptId, { classification: 'inconclusive', files: [], reason: reason.slice(0, 160), machineMinutes }, now);
  }

  /** A restart may poll a still-running peer, but never creates a second attempt. */
  expire(now: number): number {
    let expired = 0;
    for (const m of this.markers.values()) if (m.state !== 'done' && now - m.createdAt > DIAGNOSIS_LIMITS.maxRunMs) {
      if (this.inconclusive(m.key, m.attemptId, 'deadline', now)) expired++;
    }
    return expired;
  }

  private persist(now: number): void {
    const terminal = [...this.markers.values()].filter((m) => m.state === 'done')
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const keep = new Set(terminal.filter((m) => now - m.updatedAt <= DIAGNOSIS_LIMITS.maxAgeMs)
      .slice(0, DIAGNOSIS_LIMITS.maxTerminal).map((m) => m.key));
    for (const m of terminal) if (!keep.has(m.key)) this.markers.delete(m.key);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, markers: [...this.markers.values()] }), { mode: 0o600 }); /* state-registry: local-verify-failed-file-diagnoses */
    fs.renameSync(tmp, this.file);
  }
}
