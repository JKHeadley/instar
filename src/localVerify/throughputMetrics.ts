/** Machine-local, bounded observation only. Never participates in admission or verdicts. */
import fs from 'node:fs';
import path from 'node:path';
import { isValidBaseRef, isValidPr, isValidSha, type LocalVerifyRecord } from './record.js';

export const THROUGHPUT_METRICS_LIMITS = { rows: 2000, attempts: 8, ageMs: 30 * 86_400_000, bytes: 4_000_000 } as const;
export interface TimingKey { repo: string; pr: number; headSha: string; baseSha: string; baseRefName: string }
export interface TimingVerdict { at: number; runStartedAt: number; runFinishedAt: number; outcome: LocalVerifyRecord['outcome']; source: 'run' | 'peer' | 'derived'; inventory: 'complete' | 'incomplete' | 'unknown' }
export interface TimingRow extends TimingKey {
  /** First confirmed PR head observation, NOT GitHub publication. Latency from here is a lower bound. */
  firstObservedPublishedHeadAt?: number;
  requestedAt?: number;
  admittedAt?: number;
  dispatchedAt?: number;
  lastObservedAt: number;
  verdicts: TimingVerdict[];
}
const validKey = (k: TimingKey) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(k.repo) && k.repo.length <= 200
  && isValidPr(k.pr) && isValidSha(k.headSha) && isValidSha(k.baseSha) && isValidBaseRef(k.baseRefName);
const keyOf = (k: TimingKey) => JSON.stringify([k.repo, k.pr, k.headSha, k.baseSha, k.baseRefName]);
const timestamp = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;

/** Strict metadata allowlist: stored inputs never carry titles, bodies, paths, test names or logs. */
function parseRow(x: unknown): TimingRow | null {
  if (!x || typeof x !== 'object') return null;
  const r = x as TimingRow;
  if (!validKey(r) || (r.firstObservedPublishedHeadAt !== undefined && !timestamp(r.firstObservedPublishedHeadAt)) || !timestamp(r.lastObservedAt) || !Array.isArray(r.verdicts)) return null;
  const row: TimingRow = { repo: r.repo, pr: r.pr, headSha: r.headSha, baseSha: r.baseSha, baseRefName: r.baseRefName,
    ...(r.firstObservedPublishedHeadAt !== undefined ? { firstObservedPublishedHeadAt: r.firstObservedPublishedHeadAt } : {}), lastObservedAt: r.lastObservedAt, verdicts: [] };
  for (const field of ['requestedAt', 'admittedAt', 'dispatchedAt'] as const) if (timestamp(r[field])) row[field] = r[field];
  row.verdicts = r.verdicts.filter((v) => v && timestamp(v.at) && timestamp(v.runStartedAt) && timestamp(v.runFinishedAt)
    && ['success', 'failure', 'error'].includes(v.outcome) && ['run', 'peer', 'derived'].includes(v.source)
    && ['complete', 'incomplete', 'unknown'].includes(v.inventory)).slice(-THROUGHPUT_METRICS_LIMITS.attempts)
    .map((v) => ({ at: v.at, runStartedAt: v.runStartedAt, runFinishedAt: v.runFinishedAt, outcome: v.outcome, source: v.source, inventory: v.inventory }));
  return row;
}

export class ThroughputMetrics {
  private readonly rows = new Map<string, TimingRow>();
  private loaded = false;
  constructor(private readonly file: string, private readonly now: () => number, private readonly signal: (event: Record<string, unknown>) => void) {}

  observe(k: TimingKey, phase: 'requestedAt' | 'admittedAt' | 'dispatchedAt'): void {
    this.update(k, (row, now) => { row[phase] ??= now; if (phase === 'requestedAt') row.firstObservedPublishedHeadAt ??= now; });
  }

  verdict(record: LocalVerifyRecord, source: TimingVerdict['source']): void {
    if (record.kind === 'main') return;
    this.update(record, (row, now) => {
      const runStartedAt = Date.parse(record.startedAt), runFinishedAt = Date.parse(record.finishedAt);
      if (!timestamp(runStartedAt) || !timestamp(runFinishedAt)) return;
      const coverage = record.inventoryCoverage;
      const usable = coverage && Number.isSafeInteger(coverage.expectedFiles) && coverage.expectedFiles > 0
        && Number.isSafeInteger(coverage.reportedFiles) && coverage.reportedFiles >= 0 && typeof coverage.complete === 'boolean'
        && (!coverage.complete || coverage.expectedFiles === coverage.reportedFiles);
      const inventory = usable ? (coverage.complete ? 'complete' : 'incomplete') : !coverage && record.outcome === 'success' ? 'complete' : 'unknown';
      // Idempotent replay of the same journal result is not another verdict.
      if (!row.verdicts.some((v) => v.runStartedAt === runStartedAt && v.runFinishedAt === runFinishedAt && v.source === source)) {
        row.verdicts.push({ at: now, runStartedAt, runFinishedAt, outcome: record.outcome, source, inventory });
        row.verdicts = row.verdicts.slice(-THROUGHPUT_METRICS_LIMITS.attempts);
      }
    });
  }

  private update(k: TimingKey, mutate: (row: TimingRow, now: number) => void): void {
    try {
      if (!validKey(k)) return;
      const now = this.now();
      if (!timestamp(now)) return;
      if (!this.loaded) {
        if (fs.existsSync(this.file)) {
          if (fs.statSync(this.file).size > THROUGHPUT_METRICS_LIMITS.bytes) throw new Error('metrics-size-bound');
          const saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { v?: unknown; rows?: unknown };
          if (saved.v !== 1 || !Array.isArray(saved.rows) || saved.rows.length > THROUGHPUT_METRICS_LIMITS.rows) throw new Error('metrics-format');
          for (const raw of saved.rows) { const row = parseRow(raw); if (row) this.rows.set(keyOf(row), row); }
        }
        this.loaded = true;
      }
      const key = keyOf(k);
      const row = this.rows.get(key) ?? { repo: k.repo, pr: k.pr, headSha: k.headSha, baseSha: k.baseSha, baseRefName: k.baseRefName,
        lastObservedAt: now, verdicts: [] };
      // Clock rollback must not make the end-to-end lower bound negative.
      row.lastObservedAt = Math.max(row.lastObservedAt, now);
      mutate(row, now);
      this.rows.set(key, row);
      const kept = [...this.rows.values()].filter((r) => r.lastObservedAt >= now - THROUGHPUT_METRICS_LIMITS.ageMs)
        .sort((a, b) => b.lastObservedAt - a.lastObservedAt).slice(0, THROUGHPUT_METRICS_LIMITS.rows);
      this.rows.clear(); for (const r of kept) this.rows.set(keyOf(r), r);
      const json = JSON.stringify({ v: 1, publicationTime: 'unavailable', latencyBasis: 'first-observed-published-head-lower-bound', rows: kept });
      if (Buffer.byteLength(json) > THROUGHPUT_METRICS_LIMITS.bytes) throw new Error('metrics-size-bound');
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.tmp`;
      fs.writeFileSync(temp, json + '\n', { mode: 0o600 }); /* state-registry: local-verify-throughput-metrics */
      fs.renameSync(temp, this.file);
    } catch {
      // Observability must fail open. Even an audit callback is never allowed to alter a gate.
      try { this.signal({ event: 'throughput-metrics-unavailable' }); } catch { /* @silent-fallback-ok: telemetry cannot acquire gate authority */ }
    }
  }
}
