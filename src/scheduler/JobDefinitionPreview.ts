/** Read-only local loader evidence. Call only from an isolated preview worker.
 *  This slice does not materialize manifests, inspect the scheduler, or expose an API.
 */
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { validateManifest } from './AgentMdJobLoader.js';
import { validateJob } from './JobLoader.js';
import type { JobDefinition } from '../core/types.js';

const LIMITS = { files: 1_000, legacyRows: 10_000, fileBytes: 1_048_576, inputBytes: 8_388_608, visibleRows: 250 };
const UNRESOLVED = 'unresolved' as const;

type Component = 'legacy' | 'portable-journal' | 'manifest-inventory';
type Status = 'complete' | 'invalid' | 'unchecked';
type Stat = { kind: 'file' | 'directory' | 'other'; contents: string };
export type JobDefinitionPreviewRow = {
  source: 'legacy' | 'manifest';
  disposition: 'loader-effective' | 'suppressed' | 'unknown' | 'invalid';
  slug?: string;
  enabled?: boolean;
  executor?: 'prompt' | 'skill' | 'script' | 'agentmd';
  reason?: 'portable-owned' | 'portable-invalid' | 'manifest-unverified' | 'incomplete';
  ownership: typeof UNRESOLVED;
  mapping: typeof UNRESOLVED;
};

type Occurrence = { source: 'legacy'; ordinal: number }
  | { source: 'manifest'; relativePath: string; ordinal: number };
type SnapshotRow = JobDefinitionPreviewRow & { occurrence: Occurrence };

export interface LocalJobDefinitionPreviewSnapshot {
  complete: boolean;
  /** Internal only. Expose only inside an authenticated, encrypted cursor. */
  fingerprint: string | null;
  coverage: Record<Component, Status>;
  scheduler: 'unknown';
  pool: 'unchecked';
  /** Internal order and coordinates. Strip occurrence before serializing a row. */
  rows: SnapshotRow[];
}

function compare(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

function fingerprint(stats: BigIntStats): Stat {
  return {
    kind: stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other',
    contents: [stats.dev, stats.ino, stats.mode, stats.size, stats.mtimeNs, stats.ctimeNs].join(':'),
  };
}

async function tryStat(file: string): Promise<Stat | null> {
  try {
    return fingerprint(await lstat(file, { bigint: true }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function unchanged(a: Stat | null, b: Stat | null): boolean {
  return a?.kind === b?.kind && a?.contents === b?.contents;
}

/** Holds proof of both positive and negative observations until the caller can compare them. */
class LocalInputs {
  private readonly encountered = new Set<string>();
  private readonly observed = new Map<string, Stat | null>();
  private readonly readDigests = new Map<string, string>();
  private bytes = 0;
  constructor(private readonly root: string, private readonly signal: AbortSignal) {}

  private count(file: string): void {
    if (this.encountered.has(file)) return;
    if (this.encountered.size === LIMITS.files) throw new Error('file-count-limit');
    this.encountered.add(file);
  }

  private async observe(file: string): Promise<Stat | null> {
    this.signal.throwIfAborted();
    this.count(file);
    const result = await tryStat(file);
    if (this.observed.has(file) && !unchanged(this.observed.get(file) ?? null, result)) throw new Error('source-changed');
    this.observed.set(file, result);
    return result;
  }

  private async parentIsConfined(parent: string): Promise<boolean> {
    const relative = path.relative(this.root, parent);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('outside-root');
    let current = this.root;
    for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
      current = path.join(current, segment);
      const dir = await this.observe(current);
      if (dir === null) return false;
      if (dir.kind !== 'directory' || await realpath(current) !== current) throw new Error('unsafe-directory');
    }
    return true;
  }

  async names(dir: string): Promise<string[]> {
    if (!await this.parentIsConfined(dir)) return [];
    const names: string[] = [];
    const directory = await opendir(dir);
    try {
      for (let entry = await directory.read(); entry; entry = await directory.read()) {
        this.signal.throwIfAborted();
        this.count(path.join(dir, entry.name));
        names.push(entry.name);
      }
    } finally {
      await directory.close();
    }
    await this.parentIsConfined(dir);
    return names.sort();
  }

  async text(file: string): Promise<string | null> {
    if (!await this.parentIsConfined(path.dirname(file))) return null;
    const initial = await this.observe(file);
    if (initial === null) return null;
    if (initial.kind !== 'file' || !constants.O_NOFOLLOW || !constants.O_NONBLOCK) throw new Error('unsafe-file');
    const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await fd.stat({ bigint: true });
      if (!unchanged(initial, fingerprint(stat)) || !await this.parentIsConfined(path.dirname(file))) throw new Error('source-changed');
      await this.observe(file);
      if (stat.size > BigInt(Math.min(LIMITS.fileBytes, LIMITS.inputBytes - this.bytes))) throw new Error('input-limit');
      this.bytes += Number(stat.size);
      const buffer = Buffer.alloc(Number(stat.size));
      let offset = 0;
      while (offset < buffer.length) {
        this.signal.throwIfAborted();
        const read = await fd.read(buffer, offset, buffer.length - offset, offset);
        if (!read.bytesRead) throw new Error('source-changed');
        offset += read.bytesRead;
      }
      if (!unchanged(initial, fingerprint(await fd.stat({ bigint: true })))) throw new Error('source-changed');
      this.readDigests.set(file, createHash('sha256').update(buffer).digest('hex'));
      return buffer.toString('utf8');
    } finally {
      await fd.close();
    }
  }

  /** Track a declared, confined dependency without parsing or claiming its validity. */
  async track(file: string): Promise<void> {
    if (!await this.parentIsConfined(path.dirname(file))) return;
    const observation = await this.observe(file);
    if (observation !== null && observation.kind !== 'file') throw new Error('unsafe-dependency');
  }

  async stable(): Promise<boolean> {
    for (const [file, observed] of this.observed) {
      this.signal.throwIfAborted();
      if (!unchanged(observed, await tryStat(file))) return false;
    }
    return true;
  }

  digest(rows: SnapshotRow[]): string {
    const hash = createHash('sha256').update('local-job-definition-preview-v1\n');
    for (const file of [...this.observed.keys()].sort(compare)) {
      hash.update(JSON.stringify([path.relative(this.root, file), this.observed.get(file), this.readDigests.get(file)]));
      hash.update('\n');
    }
    for (const row of rows) hash.update(JSON.stringify(row)).update('\n');
    return hash.digest('hex');
  }
}

function entry(occurrence: Occurrence, row: Omit<JobDefinitionPreviewRow, 'ownership' | 'mapping'>): SnapshotRow {
  return { ...row, ownership: UNRESOLVED, mapping: UNRESOLVED, occurrence };
}

function compareRows(a: SnapshotRow, b: SnapshotRow): number {
  const aPath = a.occurrence.source === 'manifest' ? a.occurrence.relativePath : '';
  const bPath = b.occurrence.source === 'manifest' ? b.occurrence.relativePath : '';
  return compare(a.disposition, b.disposition) || compare(a.slug?.toLowerCase() ?? '', b.slug?.toLowerCase() ?? '')
    || compare(a.source, b.source) || compare(aPath, bPath) || a.occurrence.ordinal - b.occurrence.ordinal;
}

/** A bounded catalog observation. Scheduler generation and execution parity remain unknown. */
export async function readLocalJobDefinitionPreviewSnapshot(
  jobsFile: string, signal: AbortSignal,
): Promise<LocalJobDefinitionPreviewSnapshot> {
  const coverage: Record<Component, Status> = { legacy: 'unchecked', 'portable-journal': 'unchecked', 'manifest-inventory': 'unchecked' };
  const rows: SnapshotRow[] = [];
  const file = path.resolve(jobsFile);
  let stable = false;
  let digest: string | null = null;
  try {
    const root = path.dirname(file);
    // Require the configured catalog root to already be canonical on this host.
    if (await realpath(root) !== root) throw new Error('unsafe-root');
    const inputs = new LocalInputs(root, signal);
    let legacy: unknown[] = [];
    try {
      const text = await inputs.text(file);
      const parsed: unknown = text === null ? [] : JSON.parse(text);
      if (!Array.isArray(parsed)) coverage.legacy = 'invalid';
      else {
        legacy = parsed.slice(0, LIMITS.legacyRows);
        if (parsed.length <= LIMITS.legacyRows) coverage.legacy = 'complete';
      }
    } catch (error) {
      if (error instanceof SyntaxError) coverage.legacy = 'invalid';
    }

    let portable: Record<string, unknown> | null = null;
    try {
      const source = await inputs.text(path.join(root, 'state', 'job-portable-import-journal.json'));
      const parsed = source === null ? null : JSON.parse(source);
      if (source === null) coverage['portable-journal'] = 'complete';
      else if (parsed?.version === 1 && parsed.jobs && typeof parsed.jobs === 'object') {
        portable = parsed.jobs;
        coverage['portable-journal'] = 'complete';
      } else coverage['portable-journal'] = 'invalid';
    } catch (error) {
      if (error instanceof SyntaxError) coverage['portable-journal'] = 'invalid';
    }

    const manifestSlugs = new Set<string>();
    try {
      const dir = path.join(root, 'jobs', 'schedule');
      coverage['manifest-inventory'] = 'complete';
      const names = await inputs.names(dir);
      if (names.some(name => name.endsWith('.json'))) {
        try {
          await inputs.track(path.join(root, 'jobs', 'instar.lock.json'));
          if (portable !== null) {
            await inputs.track(path.join(root, 'state', 'job-portable-disarmed.json'));
            await inputs.track(path.join(root, 'state', 'job-portable-activate-approval.json'));
          }
        } catch {
          coverage['manifest-inventory'] = 'unchecked';
        }
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const occurrence = { source: 'manifest' as const, relativePath: path.posix.join('jobs', 'schedule', name), ordinal: 0 };
        let text: string | null;
        try {
          text = await inputs.text(path.join(dir, name));
          if (text === null) throw new Error('source-changed');
        } catch {
          coverage['manifest-inventory'] = 'unchecked';
          continue;
        }
        if (portable !== null && Object.hasOwn(portable, name.slice(0, -5))) {
          try {
            await inputs.track(path.join(root, 'state', 'job-portable-pending', name));
          } catch {
            coverage['manifest-inventory'] = 'unchecked';
          }
        }
        try {
          const manifest = validateManifest(JSON.parse(text));
          manifestSlugs.add(manifest.slug);
          rows.push(entry(occurrence, { source: 'manifest', disposition: 'unknown', slug: manifest.slug,
            enabled: manifest.enabled, executor: manifest.execute.type, reason: 'manifest-unverified' }));
          if (manifest.enabled && (manifest.execute.type === 'agentmd' || (manifest.origin === 'instar' && manifest.execute.type === 'script'))) {
            try {
              await inputs.track(path.join(root, 'jobs', manifest.origin, `${manifest.slug}.md`));
            } catch {
              coverage['manifest-inventory'] = 'unchecked';
            }
          }
        } catch {
          rows.push(entry(occurrence, { source: 'manifest', disposition: 'invalid' }));
        }
      }
    } catch {
      coverage['manifest-inventory'] = 'unchecked';
    }

    const sourceComplete = Object.values(coverage).every(value => value === 'complete');
    for (const [index, value] of legacy.entries()) {
      signal.throwIfAborted();
      const occurrence = { source: 'legacy' as const, ordinal: index };
      try {
        validateJob(value, index);
      } catch {
        rows.push(entry(occurrence, { source: 'legacy', disposition: 'invalid' }));
        continue;
      }
      const { slug, enabled, execute } = value as JobDefinition;
      const fields = { source: 'legacy' as const, slug, enabled, executor: execute.type };
      // Preserve the loader's distinction between absent journal and a present
      // journal whose normal property lookup suppresses this legacy definition.
      if (coverage['portable-journal'] === 'invalid') rows.push(entry(occurrence, { ...fields, disposition: 'suppressed', reason: 'portable-invalid' }));
      else if (portable !== null && portable[slug]) rows.push(entry(occurrence, { ...fields, disposition: 'suppressed', reason: 'portable-owned' }));
      else if (!sourceComplete || manifestSlugs.has(slug)) {
        rows.push(entry(occurrence, { ...fields, disposition: 'unknown', reason: sourceComplete ? 'manifest-unverified' : 'incomplete' }));
      } else rows.push(entry(occurrence, { ...fields, disposition: 'loader-effective' }));
    }
    rows.sort(compareRows);
    stable = await inputs.stable();
    if (stable && sourceComplete && !signal.aborted) digest = inputs.digest(rows);
  } catch {
    // The caller receives only a bounded, redacted observation, never I/O errors.
  }
  if (!stable || signal.aborted) {
    coverage.legacy = coverage['portable-journal'] = coverage['manifest-inventory'] = 'unchecked';
    rows.length = 0;
  }
  return { complete: digest !== null, fingerprint: digest, coverage, scheduler: 'unknown', pool: 'unchecked', rows };
}

/** The original capped observation, without internal identity or cursor material. */
export async function readLocalJobDefinitionPreview(jobsFile: string, signal: AbortSignal) {
  const { coverage, scheduler, pool, rows } = await readLocalJobDefinitionPreviewSnapshot(jobsFile, signal);
  return {
    coverage, scheduler, pool, truncated: rows.length > LIMITS.visibleRows,
    rows: rows.slice(0, LIMITS.visibleRows).map(({ occurrence: _occurrence, ...row }) => row),
  };
}
