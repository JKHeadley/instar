/** Coordinator-owned durable replay obligation for an enforced preflight red. */
import fs from 'node:fs';
import path from 'node:path';
import type { LocalVerifyRecord } from './record.js';

export type ReplayState = 'pending' | 'running' | 'retryable-error' | 'completed' | 'blocked';
export interface PreflightReplay {
  key: string;
  repo: string;
  pr: number;
  headSha: string;
  baseRefName: string;
  policyHash: string;
  verifierVersion: string;
  redBaseSha: string;
  createdAt: number;
  updatedAt: number;
  state: ReplayState;
  nextAdmissionAt: number;
  admissionAttempts: number;
  executionAttempts: number;
  rearmed: boolean;
  blockedReason?: string;
}

export const REPLAY_ADMISSION_MAX = 12;
export const REPLAY_LIFETIME_MS = 24 * 60 * 60_000;
export const REPLAY_EXECUTION_MAX = 3;
export const REPLAY_BACKOFF_MIN_MS = 5 * 60_000;
export const REPLAY_BACKOFF_MAX_MS = 60 * 60_000;
const MAX_ENTRIES = 500;

export function replayKey(r: Pick<LocalVerifyRecord, 'repo' | 'pr' | 'headSha' | 'baseRefName' | 'policyHash'>): string {
  return `${r.repo}\0${r.pr}\0${r.headSha}\0${r.baseRefName}\0${r.policyHash}`;
}

function valid(x: unknown): x is PreflightReplay {
  if (!x || typeof x !== 'object') return false;
  const r = x as PreflightReplay;
  return typeof r.key === 'string' && r.key === replayKey(r)
    && typeof r.repo === 'string' && Number.isSafeInteger(r.pr) && r.pr > 0
    && /^[a-f0-9]{40}$/i.test(r.headSha) && /^[a-f0-9]{40}$/i.test(r.redBaseSha)
    && typeof r.baseRefName === 'string' && typeof r.policyHash === 'string'
    && typeof r.verifierVersion === 'string' && r.verifierVersion.length > 0
    && ['pending', 'running', 'retryable-error', 'completed', 'blocked'].includes(r.state)
    && [r.createdAt, r.updatedAt, r.nextAdmissionAt, r.admissionAttempts, r.executionAttempts].every((n) => Number.isSafeInteger(n) && n >= 0)
    && r.admissionAttempts <= REPLAY_ADMISSION_MAX && r.executionAttempts <= REPLAY_EXECUTION_MAX
    && typeof r.rearmed === 'boolean';
}

/** One-process writer. Atomic replace means a torn write cannot silently erase obligations. */
export class PreflightReplayStore {
  private readonly file: string;
  private readonly entries = new Map<string, PreflightReplay>();
  constructor(stateDir: string) {
    this.file = path.join(stateDir, 'local-verify', 'preflight-replays.json');
    let raw: string;
    try { raw = fs.readFileSync(this.file, 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    const parsed = JSON.parse(raw) as { v?: unknown; entries?: unknown };
    if (parsed.v !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length > MAX_ENTRIES || !parsed.entries.every(valid)) {
      throw new Error('preflight replay store is malformed; enforcement must remain off');
    }
    for (const entry of parsed.entries) {
      if (this.entries.has(entry.key)) throw new Error('duplicate preflight replay key; enforcement must remain off');
      this.entries.set(entry.key, entry);
    }
  }
  get(key: string): PreflightReplay | null { return this.entries.get(key) ?? null; }
  list(): PreflightReplay[] { return [...this.entries.values()]; }
  private write(): void {
    if (this.entries.size > MAX_ENTRIES) throw new Error('preflight replay store full');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, entries: this.list() }), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  private put(r: PreflightReplay): PreflightReplay {
    const before = this.entries.get(r.key);
    this.entries.set(r.key, r);
    try { this.write(); }
    catch (e) { if (before) this.entries.set(r.key, before); else this.entries.delete(r.key); throw e; }
    return r;
  }
  ensureRed(record: LocalVerifyRecord, now: number): PreflightReplay {
    if (record.outcome !== 'failure' || record.preflight?.mode !== 'enforce' || record.preflight.outcome !== 'red'
      || record.preflight.reason !== 'preflight-red' || record.lanes.length !== 0) throw new Error('not an enforced preflight red');
    const key = replayKey(record);
    const existing = this.get(key);
    if (existing) return existing;
    return this.put({
      key, repo: record.repo, pr: record.pr, headSha: record.headSha, baseRefName: record.baseRefName,
      policyHash: record.policyHash, verifierVersion: record.verifierVersion, redBaseSha: record.baseSha, createdAt: now, updatedAt: now,
      state: 'pending', nextAdmissionAt: now, admissionAttempts: 0, executionAttempts: 0, rearmed: false,
    });
  }
  admissionFailed(key: string, now: number, reason: string): PreflightReplay {
    const old = this.get(key);
    if (!old || old.state !== 'pending' && old.state !== 'retryable-error') throw new Error('replay not pending');
    const attempts = old.admissionAttempts + 1;
    const exhausted = attempts >= REPLAY_ADMISSION_MAX || now - old.createdAt >= REPLAY_LIFETIME_MS;
    return this.put({ ...old, state: exhausted ? 'blocked' : old.state, admissionAttempts: attempts,
      nextAdmissionAt: now + Math.min(REPLAY_BACKOFF_MAX_MS, REPLAY_BACKOFF_MIN_MS * 2 ** (attempts - 1)),
      blockedReason: exhausted ? reason : undefined, updatedAt: now });
  }
  blockIfExpired(key: string, now: number): PreflightReplay | null {
    const old = this.get(key);
    if (!old || old.state === 'completed' || old.state === 'blocked') return old;
    if (now - old.createdAt < REPLAY_LIFETIME_MS && old.admissionAttempts < REPLAY_ADMISSION_MAX) return old;
    return this.put({ ...old, state: 'blocked', blockedReason: 'admission-lifetime-exhausted', updatedAt: now });
  }
  completeFromJournal(key: string, now: number): PreflightReplay | null {
    const old = this.get(key);
    if (!old || old.state === 'completed') return old;
    return this.put({ ...old, state: 'completed', updatedAt: now, blockedReason: undefined });
  }
  admitted(key: string, now: number): PreflightReplay {
    const old = this.get(key);
    if (!old || old.state !== 'pending' && old.state !== 'retryable-error') throw new Error('replay not pending');
    return this.put({ ...old, state: 'running', executionAttempts: old.executionAttempts + 1, updatedAt: now });
  }
  finished(key: string, now: number, outcome: 'success' | 'failure' | 'error'): PreflightReplay {
    const old = this.get(key);
    if (!old || old.state !== 'running') throw new Error('replay not running');
    if (outcome !== 'error') return this.put({ ...old, state: 'completed', updatedAt: now, blockedReason: undefined });
    const exhausted = old.executionAttempts >= REPLAY_EXECUTION_MAX;
    return this.put({ ...old, state: exhausted ? 'blocked' : 'retryable-error', updatedAt: now,
      nextAdmissionAt: now + REPLAY_BACKOFF_MIN_MS, blockedReason: exhausted ? 'execution-errors' : undefined });
  }
  releasedForCapacity(key: string, now: number): PreflightReplay | null {
    const old = this.get(key);
    if (!old || old.state !== 'running') return old;
    return this.put({ ...old, state: 'pending', executionAttempts: Math.max(0, old.executionAttempts - 1),
      nextAdmissionAt: now, updatedAt: now });
  }
  recoverInterrupted(key: string, now: number): PreflightReplay | null {
    const old = this.get(key);
    if (!old || old.state !== 'running') return old;
    const exhausted = old.executionAttempts >= REPLAY_EXECUTION_MAX;
    return this.put({ ...old, state: exhausted ? 'blocked' : 'retryable-error', updatedAt: now,
      nextAdmissionAt: now + REPLAY_BACKOFF_MIN_MS, blockedReason: exhausted ? 'interrupted' : undefined });
  }
  rearmOnce(key: string, now: number): PreflightReplay | null {
    const old = this.get(key);
    if (!old || old.state !== 'blocked' || old.rearmed) return null;
    return this.put({ ...old, state: 'pending', rearmed: true, createdAt: now, admissionAttempts: 0, executionAttempts: 0,
      nextAdmissionAt: now, updatedAt: now, blockedReason: undefined });
  }
  cancel(key: string): void {
    const old = this.entries.get(key);
    if (!old) return;
    this.entries.delete(key);
    try { this.write(); } catch (e) { this.entries.set(key, old); throw e; }
  }
}
