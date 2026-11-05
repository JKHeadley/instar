/**
 * Signed, metadata-only job catalog observations for lease handoff coverage.
 * A peer's catalog is evidence, never authority to install or execute work.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { JobDefinition } from './types.js';
import { sign, verify } from './MachineIdentity.js';

export interface JobCoverageEntry {
  slug: string;
  schedule: string;
  enabled: boolean;
  machines?: string[];
  catchUpPolicy?: 'skip' | 'run-once' | 'ask';
  dependencyCount?: number;
}
export interface JobCoveragePayload {
  version: 1;
  machineId: string;
  generation: string;
  complete: boolean;
  jobs: JobCoverageEntry[];
}
export interface SignedJobCoverage extends JobCoveragePayload {
  nonce: string;
  signature: string;
}
export interface JobCoverageObservation {
  payload: JobCoveragePayload;
  observedAt: string;
  status: 'fresh' | 'stale' | 'unavailable' | 'incomplete';
  error?: string;
}
export interface JobCoverageDifference {
  slug: string;
  sourceMachineId: string;
  reason: 'missing' | 'disabled' | 'pinned' | 'dependency' | 'conflict';
  observedAt: string;
  stale: boolean;
}
const MAX_JOBS = 500;
const MAX_BYTES = 256 * 1024;
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const STALE_MS = 24 * 60 * 60 * 1000;
const SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

/** A deterministic, secret-free projection. Incomplete catalogs cannot prove health. */
export function projectJobCoverage(machineId: string, jobs: JobDefinition[], complete = true): JobCoveragePayload {
  const rows = jobs.slice(0, MAX_JOBS).map((job): JobCoverageEntry => ({
    slug: job.slug,
    schedule: job.schedule,
    enabled: job.enabled !== false,
    ...(job.machines?.length ? { machines: [...job.machines] } : {}),
    ...(job.catchUpPolicy ? { catchUpPolicy: job.catchUpPolicy } : {}),
    ...(job.requiredPaths?.length ? { dependencyCount: job.requiredPaths.length } : {}),
  })).sort((a, b) => a.slug.localeCompare(b.slug));
  const digest = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  const generation = `000000000001:${digest}`;
  return { version: 1, machineId, generation, complete: complete && jobs.length <= MAX_JOBS, jobs: rows };
}

export function jobCoverageMessage(payload: JobCoveragePayload, nonce: string): string {
  return `instar-job-coverage-v1|${nonce}|${JSON.stringify(payload)}`;
}
export function signJobCoverage(payload: JobCoveragePayload, nonce: string, privateKey: string): SignedJobCoverage {
  return { ...payload, nonce, signature: sign(jobCoverageMessage(payload, nonce), privateKey) };
}
export function acceptJobCoverage(wire: unknown, expectedMachineId: string, nonce: string, publicKey: string): JobCoveragePayload | null {
  if (!wire || typeof wire !== 'object') return null;
  const row = wire as Partial<SignedJobCoverage>;
  if (row.version !== 1 || row.machineId !== expectedMachineId || row.nonce !== nonce || typeof row.signature !== 'string'
    || typeof row.generation !== 'string' || !/^[a-f0-9]{12}:[a-f0-9]{64}$/.test(row.generation)
    || typeof row.complete !== 'boolean' || !Array.isArray(row.jobs) || row.jobs.length > MAX_JOBS) return null;
  const slugs = new Set<string>();
  for (const candidate of row.jobs) {
    if (!candidate || typeof candidate !== 'object') return null;
    const job = candidate as JobCoverageEntry;
    if (typeof job.slug !== 'string' || !SLUG.test(job.slug) || slugs.has(job.slug)
      || typeof job.schedule !== 'string' || job.schedule.length > 128
      || typeof job.enabled !== 'boolean'
      || (job.dependencyCount !== undefined && (!Number.isSafeInteger(job.dependencyCount) || job.dependencyCount < 0 || job.dependencyCount > 32))
      || (job.catchUpPolicy !== undefined && !['skip', 'run-once', 'ask'].includes(job.catchUpPolicy))
      || (job.machines !== undefined && (!Array.isArray(job.machines)
        || job.machines.length > 16 || job.machines.some(m => typeof m !== 'string' || m.length > 128)))) return null;
    slugs.add(job.slug);
  }
  const payload: JobCoveragePayload = { version: 1, machineId: row.machineId, generation: row.generation,
    complete: row.complete, jobs: row.jobs as JobCoverageEntry[] };
  if (JSON.stringify(wire).length > MAX_BYTES) return null;
  if (!verify(jobCoverageMessage(payload, nonce), row.signature, publicKey)) return null;
  const canonical = createHash('sha256').update(JSON.stringify([...payload.jobs].sort((a, b) => a.slug.localeCompare(b.slug)))).digest('hex');
  return canonical === payload.generation.split(':')[1] ? payload : null;
}

/** Persist a source-local monotonic version for every distinct metadata catalog. */
export function assignJobCoverageGeneration(payload: JobCoveragePayload, stateDir: string): JobCoveragePayload {
  const file = path.join(stateDir, 'state', 'job-coverage-generation.json');
  const digest = payload.generation.split(':')[1];
  let previous: { counter: number; digest: string } | null = null;
  try {
    previous = JSON.parse(fs.readFileSync(file, 'utf8')) as { counter: number; digest: string };
    if (!Number.isSafeInteger(previous.counter) || previous.counter < 1 || !/^[a-f0-9]{64}$/.test(previous.digest)) {
      throw new Error('invalid-job-coverage-generation');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const counter = previous?.digest === digest ? previous.counter : (previous?.counter ?? 0) + 1;
  if (counter > 0xffffffffffff) throw new Error('job-coverage-generation-exhausted');
  if (!previous || previous.counter !== counter || previous.digest !== digest) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ counter, digest }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  return { ...payload, generation: `${counter.toString(16).padStart(12, '0')}:${digest}` };
}

/** Machine-local replica of signed peer observations. Failed reads never erase the last good record. */
export class JobCoverageStore {
  private readonly file: string;
  constructor(stateDir: string) { this.file = path.join(stateDir, 'state', 'job-coverage.json'); }
  read(): Record<string, JobCoverageObservation> {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      if (raw.length > MAX_STORE_BYTES) return {};
      const parsed = JSON.parse(raw) as { version?: number; peers?: Record<string, JobCoverageObservation> };
      return parsed.version === 1 && parsed.peers && typeof parsed.peers === 'object' ? parsed.peers : {};
    } catch { return {}; }
  }
  record(payload: JobCoveragePayload, now = new Date()): void {
    const peers = this.read();
    const prior = peers[payload.machineId];
    const nextNumber = parseInt(payload.generation.split(':')[0], 16);
    const priorNumber = prior ? parseInt(prior.payload.generation.split(':')[0], 16) : -1;
    if (prior && (nextNumber < priorNumber
      || (nextNumber === priorNumber && payload.generation !== prior.payload.generation))) {
      peers[payload.machineId] = { ...prior, status: 'unavailable', error: 'catalog-generation-rollback' };
      this.write(peers);
      return;
    }
    if (!payload.complete && prior?.payload.complete) {
      peers[payload.machineId] = { ...prior, status: 'incomplete', error: 'source-catalog-incomplete' };
    } else {
      peers[payload.machineId] = { payload, observedAt: now.toISOString(), status: payload.complete ? 'fresh' : 'incomplete' };
    }
    this.write(peers);
  }
  markUnavailable(machineId: string, error: string): void {
    const peers = this.read();
    const old = peers[machineId];
    peers[machineId] = old
      ? { ...old, status: 'unavailable', error: error.slice(0, 160) }
      : { payload: { version: 1, machineId, generation: `000000000000:${'0'.repeat(64)}`,
          complete: false, jobs: [] }, observedAt: new Date().toISOString(),
        status: 'unavailable', error: error.slice(0, 160) };
    this.write(peers);
  }
  list(now = Date.now()): Record<string, JobCoverageObservation> {
    const peers = this.read();
    for (const row of Object.values(peers)) {
      if (row.status === 'fresh' && now - Date.parse(row.observedAt) > STALE_MS) row.status = 'stale';
    }
    return peers;
  }
  private write(peers: Record<string, JobCoverageObservation>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const serialized = JSON.stringify({ version: 1, peers });
    if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) throw new Error('job-coverage-store-full');
    fs.writeFileSync(tmp, serialized, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

export function compareJobCoverage(
  local: JobCoverageEntry[], observations: Record<string, JobCoverageObservation>,
  ownMachineId: string, ownMachineName?: string,
): JobCoverageDifference[] {
  const current = new Map(local.map(j => [j.slug, j]));
  const sources = new Map<string, Array<{ machineId: string; row: JobCoverageEntry; observation: JobCoverageObservation }>>();
  for (const [machineId, observation] of Object.entries(observations)) {
    if (machineId === ownMachineId || !observation.payload.complete) continue;
    for (const row of observation.payload.jobs) {
      const list = sources.get(row.slug) ?? [];
      list.push({ machineId, row, observation });
      sources.set(row.slug, list);
    }
  }
  const out: JobCoverageDifference[] = [];
  for (const [slug, candidates] of sources) {
    const first = candidates[0];
    const signature = (row: JobCoverageEntry) => JSON.stringify({ schedule: row.schedule, enabled: row.enabled,
      machines: [...(row.machines ?? [])].sort(), catchUpPolicy: row.catchUpPolicy ?? null,
      dependencyCount: row.dependencyCount ?? 0 });
    if (candidates.some(candidate => signature(candidate.row) !== signature(first.row))) {
      out.push({ slug, sourceMachineId: candidates.map(c => c.machineId).join(','), reason: 'conflict',
        observedAt: first.observation.observedAt, stale: candidates.some(c => c.observation.status !== 'fresh') });
      continue;
    }
    if (!first.row.enabled) continue;
    const actual = current.get(slug);
    const reason = !actual ? 'missing' : !actual.enabled ? 'disabled'
      : actual.schedule !== first.row.schedule || (actual.catchUpPolicy ?? null) !== (first.row.catchUpPolicy ?? null)
        || (actual.dependencyCount ?? 0) !== (first.row.dependencyCount ?? 0) ? 'conflict'
      : actual.machines?.length && !actual.machines.some(m => m.toLowerCase() === ownMachineId.toLowerCase()
        || m.toLowerCase() === ownMachineName?.toLowerCase()) ? 'pinned' : null;
    if (reason) out.push({ slug, sourceMachineId: first.machineId, reason,
      observedAt: first.observation.observedAt, stale: first.observation.status !== 'fresh' });
  }
  return out;
}
