/** Read-only local loader evidence. Call only from an isolated preview worker.
 *  This slice does not materialize manifests, inspect the scheduler, or expose an API.
 */
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { validateManifest } from './AgentMdJobLoader.js';
import { validateJob } from './JobLoader.js';
import type { JobDefinition } from '../core/types.js';

const LIMITS = { files: 1_000, legacyRows: 10_000, fileBytes: 1_048_576, inputBytes: 8_388_608, visibleRows: 250 };
const UNRESOLVED = 'unresolved' as const;

type Component = 'legacy' | 'portable-journal' | 'manifest-inventory';
type Status = 'complete' | 'invalid' | 'unchecked';
type Stat = { kind: 'file' | 'directory' | 'other'; contents: string };
type Row = {
  source: 'legacy' | 'manifest';
  disposition: 'loader-effective' | 'suppressed' | 'unknown' | 'invalid';
  slug?: string;
  enabled?: boolean;
  executor?: 'prompt' | 'skill' | 'script' | 'agentmd';
  reason?: 'portable-owned' | 'portable-invalid' | 'manifest-unverified' | 'incomplete';
  ownership: typeof UNRESOLVED;
  mapping: typeof UNRESOLVED;
};

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
  private readonly observed = new Map<string, Stat | null>();
  private bytes = 0;
  constructor(private readonly root: string, private readonly signal: AbortSignal) {}

  private async observe(file: string): Promise<Stat | null> {
    this.signal.throwIfAborted();
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
        if (names.length === LIMITS.files) throw new Error('file-count-limit');
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
      return buffer.toString('utf8');
    } finally {
      await fd.close();
    }
  }

  async stable(): Promise<boolean> {
    for (const [file, observed] of this.observed) {
      this.signal.throwIfAborted();
      if (!unchanged(observed, await tryStat(file))) return false;
    }
    return true;
  }
}

function entry(row: Omit<Row, 'ownership' | 'mapping'>): Row {
  return { ...row, ownership: UNRESOLVED, mapping: UNRESOLVED };
}

/** A bounded catalog observation. Scheduler generation and execution parity remain unknown. */
export async function readLocalJobDefinitionPreview(jobsFile: string, signal: AbortSignal) {
  const coverage: Record<Component, Status> = { legacy: 'unchecked', 'portable-journal': 'unchecked', 'manifest-inventory': 'unchecked' };
  const rows: Row[] = [];
  const file = path.resolve(jobsFile);
  let stable = false;
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

    let portable: Record<string, unknown> = {};
    try {
      const source = await inputs.text(path.join(root, 'state', 'job-portable-import-journal.json'));
      const parsed = source === null ? { version: 1, jobs: {} } : JSON.parse(source);
      if (parsed?.version === 1 && parsed.jobs && typeof parsed.jobs === 'object') {
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
      for (const name of await inputs.names(dir)) {
        if (!name.endsWith('.json')) continue;
        let text: string | null;
        try {
          text = await inputs.text(path.join(dir, name));
          if (text === null) throw new Error('source-changed');
        } catch {
          coverage['manifest-inventory'] = 'unchecked';
          continue;
        }
        try {
          const manifest = validateManifest(JSON.parse(text));
          manifestSlugs.add(manifest.slug);
          rows.push(entry({ source: 'manifest', disposition: 'unknown', slug: manifest.slug,
            enabled: manifest.enabled, executor: manifest.execute.type, reason: 'manifest-unverified' }));
        } catch {
          rows.push(entry({ source: 'manifest', disposition: 'invalid' }));
        }
      }
    } catch {
      coverage['manifest-inventory'] = 'unchecked';
    }

    const sourceComplete = Object.values(coverage).every(value => value === 'complete');
    for (const [index, value] of legacy.entries()) {
      try {
        validateJob(value, index);
      } catch {
        rows.push(entry({ source: 'legacy', disposition: 'invalid' }));
        continue;
      }
      const { slug, enabled, execute } = value as JobDefinition;
      const fields = { source: 'legacy' as const, slug, enabled, executor: execute.type };
      // Preserve the loader's distinction between absent journal and a present
      // journal whose normal property lookup suppresses this legacy definition.
      if (coverage['portable-journal'] === 'invalid') rows.push(entry({ ...fields, disposition: 'suppressed', reason: 'portable-invalid' }));
      else if (coverage['portable-journal'] === 'complete' && Object.hasOwn(portable, slug) && portable[slug]) {
        rows.push(entry({ ...fields, disposition: 'suppressed', reason: 'portable-owned' }));
      } else if (!sourceComplete || slug in Object.prototype || manifestSlugs.has(slug)) {
        rows.push(entry({ ...fields, disposition: 'unknown', reason: sourceComplete ? 'manifest-unverified' : 'incomplete' }));
      } else rows.push(entry({ ...fields, disposition: 'loader-effective' }));
    }
    stable = await inputs.stable();
  } catch {
    // The caller receives only a bounded, redacted observation, never I/O errors.
  }
  if (!stable || signal.aborted) {
    coverage.legacy = coverage['portable-journal'] = coverage['manifest-inventory'] = 'unchecked';
    rows.length = 0;
  }
  rows.sort((a, b) => a.disposition.localeCompare(b.disposition) || (a.slug ?? '').localeCompare(b.slug ?? '') || a.source.localeCompare(b.source));
  return {
    coverage, scheduler: 'unknown' as const, pool: 'unchecked' as const,
    truncated: rows.length > LIMITS.visibleRows, rows: rows.slice(0, LIMITS.visibleRows),
  };
}
