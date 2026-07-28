import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export interface CodexTaskContinuationConfig {
  enabled?: boolean;
  maxDurationSeconds?: number;
  maxContinuations?: number;
  auditRetentionDays?: number;
  auditMaxRows?: number;
}

export interface ContinuationLedger {
  version: 1;
  active: boolean;
  topicId: string;
  sessionId: string;
  generation: number;
  generationId: string;
  startedAt: string;
  durationSeconds: number;
  continuationCount: number;
  maxContinuations: number;
  updatedAt: string;
  bodyDigest: string;
  body: string;
}

const FIRST_STOP_BIND = '__bind_on_first_stop__';

export type ContinuationReason =
  | 'disabled'
  | 'operator-stop'
  | 'no-ledger'
  | 'ownership-mismatch'
  | 'invalid-state'
  | 'duration-expired'
  | 'continuation-ceiling'
  | 'no-task-structure'
  | 'all-tasks-complete'
  | 'renewed'
  | 'open-tasks'
  | 'audit-failed'
  | 'lock-unavailable';

export interface ContinuationDecision {
  decision: 'continue' | 'allow' | 'deactivate';
  reason: ContinuationReason;
  openTaskCount: number | null;
  continuationCount: number | null;
  reasonText?: string;
}

const DEFAULTS: Required<CodexTaskContinuationConfig> = {
  enabled: false,
  maxDurationSeconds: 14_400,
  maxContinuations: 40,
  auditRetentionDays: 14,
  auditMaxRows: 5_000,
};

const MAX_BODY_BYTES = 64 * 1024;
const MAX_LEDGER_FILES = 1_000;

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function digest(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

export function normalizeTaskBody(body: string): string {
  return body.replace(/\r\n?/g, '\n');
}

/** Exact v1 authority grammar from the approved spec. */
export function parseContinuationTasks(body: string): Array<{ open: boolean; line: number }> {
  const normalized = normalizeTaskBody(body);
  if (Buffer.byteLength(normalized, 'utf8') > MAX_BODY_BYTES) return [];
  const tasks: Array<{ open: boolean; line: number }> = [];
  let fenced = false;
  let inComment = false;
  normalized.split('\n').forEach((line, index) => {
    if (/^[ ]{0,3}(```|~~~)/.test(line)) { fenced = !fenced; return; }
    if (fenced) return;
    let visible = line;
    if (inComment) {
      const end = visible.indexOf('-->');
      if (end < 0) return;
      visible = visible.slice(end + 3);
      inComment = false;
    }
    const comment = visible.indexOf('<!--');
    if (comment >= 0) {
      const end = visible.indexOf('-->', comment + 4);
      if (end < 0) inComment = true;
      visible = visible.slice(0, comment);
    }
    if (/^[ ]{0,3}>/.test(visible)) return;
    const match = visible.match(/^[ ]{0,3}- \[([ xX])\] \S/);
    if (match) tasks.push({ open: match[1] === ' ', line: index });
  });
  return tasks;
}

export class CodexTaskContinuationStore {
  private readonly cfg: Required<CodexTaskContinuationConfig>;
  private readonly root: string;

  constructor(stateDir: string, config: CodexTaskContinuationConfig = {}) {
    this.root = path.join(stateDir, 'continuation');
    this.cfg = { ...DEFAULTS, ...config };
  }

  get enabled(): boolean { return this.cfg.enabled; }

  start(input: {
    topicId: string;
    sessionId?: string;
    tasks: string[];
    durationSeconds?: number;
    maxContinuations?: number;
  }): ContinuationLedger {
    if (!this.cfg.enabled) throw new Error('continuation-disabled');
    if (!/^\d+$/.test(input.topicId)) throw new Error('invalid-owner');
    return this.withNamedLock('maintenance', () => {
      this.pruneInactiveLedgers();
      return this.withLock(input.topicId, () => {
      if (!this.read(input.topicId) && this.list().length >= MAX_LEDGER_FILES) throw new Error('continuation-capacity');
      const taskLines = input.tasks.map((t) => `- [ ] ${String(t).replace(/[\r\n]+/g, ' ').trim()}`).filter((t) => t.length > 6);
      if (taskLines.length === 0) throw new Error('empty-task-list');
      const body = normalizeTaskBody(`${taskLines.join('\n')}\n`);
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw new Error('task-list-too-large');
      const prior = this.read(input.topicId);
      const tombstone = this.readTombstone(input.topicId);
      const generationBase = Math.max(prior?.generation ?? 0, tombstone, this.readGlobalTombstone());
      if (!Number.isSafeInteger(generationBase) || generationBase >= Number.MAX_SAFE_INTEGER) throw new Error('operator-stop');
      const generation = generationBase + 1;
      const now = new Date().toISOString();
      const ledger: ContinuationLedger = {
        version: 1, active: true, topicId: input.topicId,
        sessionId: input.sessionId?.trim() || FIRST_STOP_BIND,
        generation, generationId: randomUUID(), startedAt: now,
        durationSeconds: Math.max(1, Math.min(input.durationSeconds ?? this.cfg.maxDurationSeconds, this.cfg.maxDurationSeconds)),
        continuationCount: 0,
        maxContinuations: Math.max(1, Math.min(input.maxContinuations ?? this.cfg.maxContinuations, this.cfg.maxContinuations)),
        updatedAt: now, bodyDigest: digest(body), body,
      };
      this.write(ledger);
      try { this.audit(ledger, 'allow', 'open-tasks', parseContinuationTasks(body).length, 0); }
      catch (err) { ledger.active = false; this.write(ledger); throw err; }
      return ledger;
      });
    });
  }

  /** Explicitly mint a fresh bounded generation for the existing task body.
   * This is the supported recovery path after a duration expiry; callers must
   * never hand-edit startedAt because that bypasses generation/audit ordering. */
  renew(topicId: string, input: {
    sessionId?: string;
    durationSeconds?: number;
    maxContinuations?: number;
  } = {}): ContinuationLedger {
    if (!this.cfg.enabled) throw new Error('continuation-disabled');
    if (!/^\d+$/.test(topicId)) throw new Error('invalid-owner');
    return this.withNamedLock('maintenance', () => this.withLock(topicId, () => {
      const prior = this.requireValid(topicId);
      const tasks = parseContinuationTasks(prior.body);
      if (tasks.length === 0 || tasks.every((task) => !task.open)) throw new Error('no-open-tasks');
      const tombstone = this.readTombstone(topicId);
      const generationBase = Math.max(prior.generation, tombstone, this.readGlobalTombstone());
      if (!Number.isSafeInteger(generationBase) || generationBase >= Number.MAX_SAFE_INTEGER) throw new Error('operator-stop');
      const now = new Date().toISOString();
      const ledger: ContinuationLedger = {
        ...prior,
        active: true,
        sessionId: input.sessionId?.trim() || FIRST_STOP_BIND,
        generation: generationBase + 1,
        generationId: randomUUID(),
        startedAt: now,
        durationSeconds: Math.max(1, Math.min(input.durationSeconds ?? this.cfg.maxDurationSeconds, this.cfg.maxDurationSeconds)),
        continuationCount: 0,
        maxContinuations: Math.max(1, Math.min(input.maxContinuations ?? this.cfg.maxContinuations, this.cfg.maxContinuations)),
        updatedAt: now,
      };
      this.write(ledger);
      try { this.audit(ledger, 'allow', 'renewed', tasks.filter((task) => task.open).length, 0); }
      catch (err) { ledger.active = false; this.write(ledger); throw err; }
      return ledger;
    }));
  }

  read(topicId: string): ContinuationLedger | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.ledgerPath(topicId), 'utf8')) as ContinuationLedger;
      return parsed;
    } catch { return null; }
  }

  complete(topicId: string, ordinal: number): ContinuationLedger {
    return this.withLock(topicId, () => {
      const ledger = this.requireValid(topicId);
      if (!ledger.active || this.readTombstone(topicId) > ledger.generation || this.readGlobalTombstone() > ledger.generation) {
        throw new Error('operator-stop');
      }
      const tasks = parseContinuationTasks(ledger.body);
      const task = tasks[ordinal - 1];
      if (!task) throw new Error('task-not-found');
      const lines = ledger.body.split('\n');
      lines[task.line] = lines[task.line].replace('- [ ] ', '- [x] ');
      ledger.body = normalizeTaskBody(lines.join('\n'));
      ledger.bodyDigest = digest(ledger.body);
      ledger.updatedAt = new Date().toISOString();
      this.write(ledger);
      return ledger;
    });
  }

  stop(topicId: string): boolean {
    return this.withLock(topicId, () => {
      const ledger = this.read(topicId);
      const generation = Math.max(ledger?.generation ?? 0, this.readTombstone(topicId)) + 1;
      atomicWrite(this.tombstonePath(topicId), `${generation}\n`);
      if (ledger) {
        ledger.active = false;
        ledger.updatedAt = new Date().toISOString();
        this.write(ledger);
        this.audit(ledger, 'deactivate', 'operator-stop', null, ledger.continuationCount);
      }
      return !!ledger;
    });
  }

  stopAll(): number {
    return this.withNamedLock('maintenance', () => {
      const ledgers = this.list();
      const next = Math.max(this.readGlobalTombstone(), ...ledgers.map((l) => l.generation), 0) + 1;
      atomicWrite(path.join(this.root, 'operator-stop-all.local'), `${next}\n`);
      let stopped = 0;
      for (const ledger of ledgers) if (this.stop(ledger.topicId)) stopped++;
      return stopped;
    });
  }

  decide(topicId: string, sessionId: string): ContinuationDecision {
    if (!this.cfg.enabled) return this.recordAllow(null, topicId, sessionId, 'disabled');
    try {
      // Share the maintenance ordering lock with stopAll(): once a global
      // tombstone is published, no decision that observed the prior
      // generation can commit a continuation afterward.
      return this.withNamedLock('maintenance', () => this.withLock(topicId, () => {
        const ledger = this.read(topicId);
        if (!ledger) return this.recordAllow(null, topicId, sessionId, 'no-ledger');
        if (!this.isStructurallyValid(ledger)) return this.deactivate(ledger, 'invalid-state');
        if (this.readTombstone(topicId) > ledger.generation || this.readGlobalTombstone() > ledger.generation) {
          return this.deactivate(ledger, 'operator-stop');
        }
        if (!ledger.active) return this.recordAllow(ledger, topicId, sessionId, 'no-ledger');
        // Initial binding only: the explicit start created this fresh generation,
        // and the first Stop hook serving the same topic claims it. This is not
        // restart adoption; once bound, every mismatch fails open.
        if (ledger.sessionId === FIRST_STOP_BIND && ledger.topicId === topicId && sessionId) {
          ledger.sessionId = sessionId;
          ledger.updatedAt = new Date().toISOString();
          this.write(ledger);
        }
        if (ledger.topicId !== topicId || ledger.sessionId !== sessionId) return this.recordAllow(ledger, topicId, sessionId, 'ownership-mismatch');
        const elapsed = Date.now() - Date.parse(ledger.startedAt);
        if (!Number.isFinite(elapsed) || elapsed >= ledger.durationSeconds * 1000) return this.deactivate(ledger, 'duration-expired');
        if (ledger.continuationCount >= ledger.maxContinuations) return this.deactivate(ledger, 'continuation-ceiling');
        const tasks = parseContinuationTasks(ledger.body);
        if (tasks.length === 0) return this.deactivate(ledger, 'no-task-structure');
        const open = tasks.filter((t) => t.open).length;
        if (open === 0) return this.deactivate(ledger, 'all-tasks-complete');
        ledger.continuationCount++;
        ledger.updatedAt = new Date().toISOString();
        this.write(ledger);
        try { this.audit(ledger, 'continue', 'open-tasks', open, ledger.continuationCount); }
        catch { /* @silent-fallback-ok: audit failure is a typed fail-open stop decision, never an unreported continuation */
          return this.deactivate(ledger, 'audit-failed', false);
        }
        return {
          decision: 'continue', reason: 'open-tasks', openTaskCount: open,
          continuationCount: ledger.continuationCount,
          reasonText: `Continue the current assignment. ${open} explicit task(s) remain. Re-read the continuation ledger and proceed with the first open item; do not invent additional work.`,
        };
      }));
    } catch (err) { // @silent-fallback-ok: every failure becomes an enumerated allow reason; self-continuation must fail open
      if (err instanceof Error && err.message === 'lock-unavailable') return this.recordAllow(null, topicId, sessionId, 'lock-unavailable');
      return this.recordAllow(null, topicId, sessionId, 'invalid-state');
    }
  }

  list(): ContinuationLedger[] {
    try {
      return fs.readdirSync(this.root).filter((f) => /^\d+\.local\.json$/.test(f))
        .map((f) => this.readStrict(f.replace(/\.local\.json$/, '')));
    } catch (err) {
      // @silent-fallback-ok: an absent directory is the legitimate fresh-store
      // state. Other enumeration failures must stay loud: treating EACCES/I/O
      // as empty could weaken stopAll generation ordering or the capacity cap.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  private deactivate(ledger: ContinuationLedger, reason: ContinuationReason, writeAudit = true): ContinuationDecision {
    ledger.active = false;
    ledger.updatedAt = new Date().toISOString();
    this.write(ledger);
    if (writeAudit) {
      try { this.audit(ledger, 'deactivate', reason, null, ledger.continuationCount); } catch { /* already stopping */ }
    }
    return { decision: 'deactivate', reason, openTaskCount: null, continuationCount: ledger.continuationCount };
  }

  private recordAllow(ledger: ContinuationLedger | null, topicId: string, sessionId: string, reason: ContinuationReason): ContinuationDecision {
    try { this.audit(ledger ?? { topicId, sessionId, generationId: '', continuationCount: 0 } as ContinuationLedger, 'allow', reason, null, ledger?.continuationCount ?? null); } catch { /* allow remains safe */ }
    return { decision: 'allow', reason, openTaskCount: null, continuationCount: ledger?.continuationCount ?? null };
  }

  private requireValid(topicId: string): ContinuationLedger {
    const ledger = this.read(topicId);
    if (!ledger || !this.isStructurallyValid(ledger)) throw new Error('invalid-state');
    return ledger;
  }

  /** Enumeration consumers drive global generation/capacity decisions, so a
   * discovered file must never be silently omitted on read, parse, or schema
   * failure. Direct point reads remain tolerant for fail-open Stop decisions. */
  private readStrict(topicId: string): ContinuationLedger {
    const parsed = JSON.parse(fs.readFileSync(this.ledgerPath(topicId), 'utf8')) as ContinuationLedger;
    if (!this.isStructurallyValid(parsed)) throw new Error('invalid-state');
    return parsed;
  }

  private isStructurallyValid(v: ContinuationLedger): boolean {
    return v.version === 1 && /^\d+$/.test(v.topicId) && !!v.sessionId && Number.isInteger(v.generation) && v.generation > 0
      && Number.isInteger(v.continuationCount) && v.continuationCount >= 0
      && Number.isInteger(v.maxContinuations) && v.maxContinuations > 0 && v.maxContinuations <= this.cfg.maxContinuations
      && Number.isInteger(v.durationSeconds) && v.durationSeconds > 0 && v.durationSeconds <= this.cfg.maxDurationSeconds
      && Buffer.byteLength(v.body, 'utf8') <= MAX_BODY_BYTES && digest(normalizeTaskBody(v.body)) === v.bodyDigest;
  }

  private audit(ledger: ContinuationLedger, decision: 'continue' | 'allow' | 'deactivate', reason: ContinuationReason, openTaskCount: number | null, continuationCount: number | null): void {
    this.withNamedLock('audit', () => {
      fs.mkdirSync(this.root, { recursive: true });
      const file = path.join(this.root, 'audit.local.jsonl');
      const row = JSON.stringify({
        ts: new Date().toISOString(), topicId: ledger.topicId ?? null,
        sessionIdHash: ledger.sessionId ? digest(ledger.sessionId).slice(0, 16) : null,
        ledgerGeneration: ledger.generationId || null, decision, reason, openTaskCount, continuationCount,
      });
      fs.appendFileSync(file, `${row}\n`, { mode: 0o600 });
      this.pruneAudit(file);
    });
  }

  private pruneAudit(file: string): void {
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    const cutoff = Date.now() - this.cfg.auditRetentionDays * 86_400_000;
    const kept = rows.filter((row) => {
      try { return Date.parse(JSON.parse(row).ts) >= cutoff; } catch { /* @silent-fallback-ok: malformed audit rows are rejected during bounded retention compaction */ return false; }
    }).slice(-this.cfg.auditMaxRows);
    atomicWrite(file, kept.length ? `${kept.join('\n')}\n` : '');
  }

  private pruneInactiveLedgers(): void {
    const cutoff = Date.now() - this.cfg.auditRetentionDays * 86_400_000;
    for (const ledger of this.list()) {
      if (ledger.active || Date.parse(ledger.updatedAt) >= cutoff) continue;
      try { SafeFsExecutor.safeUnlinkSync(this.ledgerPath(ledger.topicId), { operation: 'CodexTaskContinuationStore.pruneInactiveLedger' }); } catch { /* best effort; capacity gate remains */ }
      try { SafeFsExecutor.safeUnlinkSync(this.tombstonePath(ledger.topicId), { operation: 'CodexTaskContinuationStore.pruneInactiveTombstone' }); } catch { /* absent is fine after ledger removal */ }
    }
  }

  private withLock<T>(topicId: string, fn: () => T): T {
    return this.withNamedLock(topicId, fn);
  }

  private withNamedLock<T>(name: string, fn: () => T): T {
    fs.mkdirSync(this.root, { recursive: true });
    const lock = path.join(this.root, `${name}.lock`);
    try { fs.mkdirSync(lock); } catch { throw new Error('lock-unavailable'); }
    try { return fn(); } finally {
      try { SafeFsExecutor.safeRmSync(lock, { recursive: true, force: true, operation: 'CodexTaskContinuationStore.releaseLock' }); }
      catch { /* next call fails open */ }
    }
  }

  private write(ledger: ContinuationLedger): void { atomicWrite(this.ledgerPath(ledger.topicId), `${JSON.stringify(ledger, null, 2)}\n`); }
  private ledgerPath(topicId: string): string { return path.join(this.root, `${topicId}.local.json`); }
  private tombstonePath(topicId: string): string { return path.join(this.root, `${topicId}.operator-stop.local`); }
  private readTombstone(topicId: string): number { return this.readGeneration(this.tombstonePath(topicId)); }
  private readGlobalTombstone(): number { return this.readGeneration(path.join(this.root, 'operator-stop-all.local')); }
  private readGeneration(file: string): number {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      const n = Number(raw);
      // A present marker is operator authority. Corruption or an unreadable
      // marker must outrank every ledger rather than silently erasing a stop.
      return raw !== '' && Number.isSafeInteger(n) && n >= 0 ? n : Number.MAX_SAFE_INTEGER;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : Number.MAX_SAFE_INTEGER;
    }
  }
}
