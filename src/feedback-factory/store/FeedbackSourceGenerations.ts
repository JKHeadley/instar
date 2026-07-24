import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';

export interface FeedbackSourceHandoff {
  fromGenerationId: string;
  fromFile: string;
  finalOffset: number;
  finalChecksum: string;
  toGenerationId: string;
  toFile: string;
  startOffset: number;
  startChecksum: string;
  publishedAt: number;
}

interface ManifestPayload {
  schemaVersion: 1;
  currentGenerationId: string;
  currentFile: string;
  handoffs: FeedbackSourceHandoff[];
}

interface Manifest extends ManifestPayload { checksum: string; }

export interface FeedbackSourceGeneration {
  generationId: string;
  filePath: string;
  handoffToNext?: FeedbackSourceHandoff;
}

const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const checksumPayload = (payload: ManifestPayload): string => sha(JSON.stringify(payload));

/**
 * Cross-process append/compaction authority for feedback.jsonl. The tiny lock is
 * deliberately exclusive for BOTH writers and compaction: publishing a new
 * generation while a legacy writer appends would otherwise lose the append at
 * the handoff boundary.
 */
export class FeedbackSourceGenerations {
  private readonly manifestPath: string;
  private readonly generationDir: string;
  private readonly lockPath: string;
  private manifestCache: { size: number; mtimeMs: number; value: Manifest } | null = null;

  constructor(private readonly dir: string) {
    this.manifestPath = path.join(dir, 'feedback-generations.json');
    this.generationDir = path.join(dir, 'feedback-generations');
    this.lockPath = path.join(dir, '.feedback-generation.lock');
    fs.mkdirSync(dir, { recursive: true });
  }

  current(): FeedbackSourceGeneration {
    const manifest = this.readManifest();
    if (!manifest) return { generationId: 'canonical-feedback-v1', filePath: path.join(this.dir, 'feedback.jsonl') };
    return {
      generationId: manifest.currentGenerationId,
      filePath: path.join(this.dir, manifest.currentFile),
    };
  }

  planFrom(generationId?: string | null): FeedbackSourceGeneration[] {
    const manifest = this.readManifest();
    if (!manifest) return [this.current()];
    const generations = new Map<string, FeedbackSourceGeneration>();
    for (const handoff of manifest.handoffs) {
      generations.set(handoff.fromGenerationId, {
        generationId: handoff.fromGenerationId,
        filePath: path.join(this.dir, handoff.fromFile),
        handoffToNext: handoff,
      });
    }
    generations.set(manifest.currentGenerationId, {
      generationId: manifest.currentGenerationId,
      filePath: path.join(this.dir, manifest.currentFile),
    });
    const start = generationId ?? manifest.handoffs[0]?.fromGenerationId ?? manifest.currentGenerationId;
    const out: FeedbackSourceGeneration[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = start;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const source = generations.get(cursor);
      if (!source) throw new Error(`feedback source generation ${cursor} is missing from the validated manifest`);
      out.push(source);
      cursor = source.handoffToNext?.toGenerationId;
    }
    if (out.at(-1)?.generationId !== manifest.currentGenerationId) throw new Error('feedback source handoff chain does not reach the current generation');
    return out;
  }

  append(record: Record<string, unknown>, crashPoint?: 'before-append' | 'after-append' | 'after-append-fsync'): void {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        this.withLock(() => {
          const current = this.current();
          const durable = { ...record };
          if (typeof durable.sourceRecordId !== 'string' || !durable.sourceRecordId) durable.sourceRecordId = `feedback-source:${randomUUID()}`;
          if (crashPoint === 'before-append') throw new Error('injected crash before source append');
          const fd = fs.openSync(current.filePath, 'a', 0o600);
          try {
            fs.writeFileSync(fd, `${JSON.stringify(durable)}\n`, 'utf8');
            if (crashPoint === 'after-append') throw new Error('injected crash after source append');
            fs.fsyncSync(fd);
            if (crashPoint === 'after-append-fsync') throw new Error('injected crash after source append fsync');
          }
          finally { fs.closeSync(fd); }
        });
        return;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('busy') || attempt === 99) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
  }

  compact(now = Date.now(), crashPoint?: 'after-generation-fsync' | 'after-manifest-fsync' | 'after-manifest-publish'): FeedbackSourceHandoff | null {
    return this.withLock(() => {
      const current = this.current();
      if (!fs.existsSync(current.filePath)) return null;
      const bytes = fs.readFileSync(current.filePath);
      if (bytes.length === 0) return null;
      const complete = bytes.toString('utf8').split('\n').filter(Boolean);
      const latest = new Map<string, { row: Record<string, unknown>; raw: string }>();
      for (const raw of complete) {
        const row = JSON.parse(raw) as Record<string, unknown>;
        const id = String(row.feedbackId ?? row.feedback_id ?? row.id ?? '');
        if (!id) throw new Error('cannot compact feedback source row without a stable feedback id');
        latest.set(id, { row, raw });
      }
      const nextBytes = Buffer.from([...latest.values()].map(({ raw }) => raw).join('\n') + (latest.size ? '\n' : ''));
      const nextId = `feedback-${now}-${sha(nextBytes).slice(0, 12)}`;
      fs.mkdirSync(this.generationDir, { recursive: true });
      const relative = path.join('feedback-generations', `${nextId}.jsonl`);
      const target = path.join(this.dir, relative);
      const tmp = `${target}.${process.pid}.tmp`;
      if (!fs.existsSync(target)) {
        if (fs.existsSync(tmp)) SafeFsExecutor.safeUnlinkSync(tmp, { operation: 'feedback source generation temp recovery' });
        const fd = fs.openSync(tmp, 'wx', 0o600);
        try { fs.writeFileSync(fd, nextBytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(tmp, target);
      } else if (!fs.readFileSync(target).equals(nextBytes)) {
        throw new Error('orphan feedback generation conflicts with deterministic compaction output');
      }
      this.fsyncDirectory(this.generationDir);
      if (crashPoint === 'after-generation-fsync') throw new Error('injected crash after generation fsync');

      const previousManifest = this.readManifest();
      const handoff: FeedbackSourceHandoff = {
        fromGenerationId: current.generationId,
        fromFile: path.relative(this.dir, current.filePath),
        finalOffset: bytes.length,
        finalChecksum: sha(bytes),
        toGenerationId: nextId,
        toFile: relative,
        startOffset: nextBytes.length,
        startChecksum: sha(nextBytes),
        publishedAt: now,
      };
      const payload: ManifestPayload = {
        schemaVersion: 1,
        currentGenerationId: nextId,
        currentFile: relative,
        handoffs: [...(previousManifest?.handoffs ?? []), handoff],
      };
      const envelope: Manifest = { ...payload, checksum: checksumPayload(payload) };
      const manifestTmp = `${this.manifestPath}.${process.pid}.tmp`;
      if (fs.existsSync(manifestTmp)) SafeFsExecutor.safeUnlinkSync(manifestTmp, { operation: 'feedback handoff manifest temp recovery' });
      const manifestFd = fs.openSync(manifestTmp, 'wx', 0o600);
      try { fs.writeFileSync(manifestFd, `${JSON.stringify(envelope, null, 2)}\n`); fs.fsyncSync(manifestFd); } finally { fs.closeSync(manifestFd); }
      if (crashPoint === 'after-manifest-fsync') throw new Error('injected crash after handoff manifest fsync');
      fs.renameSync(manifestTmp, this.manifestPath);
      this.fsyncDirectory(this.dir);
      this.manifestCache = null;
      if (crashPoint === 'after-manifest-publish') throw new Error('injected crash after handoff manifest publish');
      return handoff;
    });
  }

  private readManifest(): Manifest | null {
    if (!fs.existsSync(this.manifestPath)) return null;
    const stat = fs.statSync(this.manifestPath);
    if (this.manifestCache?.size === stat.size && this.manifestCache.mtimeMs === stat.mtimeMs) return this.manifestCache.value;
    const parsed = JSON.parse(fs.readFileSync(this.manifestPath, 'utf8')) as Manifest;
    const payload: ManifestPayload = {
      schemaVersion: parsed.schemaVersion,
      currentGenerationId: parsed.currentGenerationId,
      currentFile: parsed.currentFile,
      handoffs: parsed.handoffs,
    };
    if (parsed.schemaVersion !== 1 || parsed.checksum !== checksumPayload(payload)) throw new Error('feedback source generation manifest checksum is invalid');
    for (const handoff of parsed.handoffs) {
      const from = path.join(this.dir, handoff.fromFile);
      const to = path.join(this.dir, handoff.toFile);
      if (!fs.existsSync(from) || !fs.existsSync(to)) throw new Error('feedback source generation referenced by manifest is missing');
      const fromBytes = fs.readFileSync(from);
      const toBytes = fs.readFileSync(to);
      if (fromBytes.length !== handoff.finalOffset || sha(fromBytes) !== handoff.finalChecksum ||
          toBytes.length < handoff.startOffset || sha(toBytes.subarray(0, handoff.startOffset)) !== handoff.startChecksum) {
        throw new Error('feedback source generation handoff boundary is invalid');
      }
    }
    this.manifestCache = { size: stat.size, mtimeMs: stat.mtimeMs, value: parsed };
    return parsed;
  }

  private withLock<T>(fn: () => T): T {
    let fd: number;
    try { fd = this.acquireLock(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('feedback source generation is busy; retry later');
      throw error;
    }
    try {
      fs.writeFileSync(fd, `${process.pid}\n`, 'utf8');
      fs.fsyncSync(fd);
      return fn();
    }
    finally { fs.closeSync(fd); try { SafeFsExecutor.safeUnlinkSync(this.lockPath, { operation: 'feedback source generation lock release' }); } catch { /* stale lock recovery is explicit */ } }
  }

  private acquireLock(): number {
    try { return fs.openSync(this.lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner = 0;
      try { owner = Number(fs.readFileSync(this.lockPath, 'utf8').trim()); } catch { /* invalid lock is stale */ }
      let alive = false;
      if (Number.isSafeInteger(owner) && owner > 0) {
        try { process.kill(owner, 0); alive = true; }
        catch (probe) { alive = (probe as NodeJS.ErrnoException).code === 'EPERM'; }
      } else {
        // The creator writes its PID immediately after O_EXCL creation. Treat an
        // empty/partial fresh file as live so a contender cannot unlink it in
        // that tiny publication window. Truly corrupt locks age out explicitly.
        try { alive = Date.now() - fs.statSync(this.lockPath).mtimeMs < 30_000; } catch { alive = true; }
      }
      if (alive) throw error;
      try { SafeFsExecutor.safeUnlinkSync(this.lockPath, { operation: 'feedback source generation stale lock recovery' }); } catch { throw error; }
      return fs.openSync(this.lockPath, 'wx', 0o600);
    }
  }

  private fsyncDirectory(dir: string): void {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
}
