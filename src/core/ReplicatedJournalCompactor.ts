import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import type { JournalEntry, JournalKind } from './CoherenceJournal.js';
import { HybridLogicalClock, type HlcTimestamp } from './HybridLogicalClock.js';
import { validateReplicatedEnvelope, type ReplicatedKindRegistry } from './ReplicatedRecordEnvelope.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';

const CHUNK_BYTES = 64 * 1024;
const NOOP_COUNTERS = { bumpSchemaReject: () => {}, bumpDroppedField: () => {}, bumpJailReject: () => {} };

export interface ReplicatedJournalCompactionResult {
  enabled: boolean;
  dryRun: boolean;
  originalRecords: number;
  compactedRecords: number;
  filesCompacted: number;
  bytesBefore: number;
  bytesAfter: number;
}

export interface ReplicatedJournalCompactorOptions {
  stateDir: string;
  registry: ReplicatedKindRegistry;
  enabled?: boolean;
  dryRun?: boolean;
  logger?: (message: string) => void;
  /** Fault-injection seam: runs after temp fsync and before the atomic rename. */
  beforeRename?: (source: string, temp: string) => void;
}

interface Winner { hlc: HlcTimestamp; line: string }

/** One-shot, explicit compactor for registered replicated-record JSONL streams. */
export class ReplicatedJournalCompactor {
  constructor(private readonly options: ReplicatedJournalCompactorOptions) {}

  run(): ReplicatedJournalCompactionResult {
    const enabled = this.options.enabled === true;
    const dryRun = this.options.dryRun ?? true;
    const result: ReplicatedJournalCompactionResult = {
      enabled, dryRun, originalRecords: 0, compactedRecords: 0,
      filesCompacted: 0, bytesBefore: 0, bytesAfter: 0,
    };
    if (!enabled) return result;

    for (const file of this.registeredStreamFiles()) this.compactFile(file, result);
    const verb = dryRun ? 'would compact' : 'compacted';
    this.options.logger?.(`[replicated-journal-compaction] ${verb} ${result.originalRecords} records -> ${result.compactedRecords} across ${result.filesCompacted} files`);
    return result;
  }

  private compactFile(file: string, total: ReplicatedJournalCompactionResult): void {
    const parsed = this.registrationForFile(file);
    if (!parsed) return;
    // Bounded by live `(origin, recordKey)` cardinality, never historical rows.
    const winners = new Map<string, Winner>();
    const beforeWitness = new Map<string, HlcTimestamp>();
    const passthrough: Winner[] = [];
    let originalRecords = 0;
    this.forEachLine(file, (line, entry) => {
      originalRecords++;
      const validated = this.validEnvelope(parsed.store, parsed.kind, entry);
      if (!validated) {
        passthrough.push({ hlc: { physical: 0, logical: 0, node: '' }, line });
        return;
      }
      const priorWitness = beforeWitness.get(validated.recordKey);
      if (!priorWitness || HybridLogicalClock.compare(validated.hlc, priorWitness) > 0) {
        beforeWitness.set(validated.recordKey, validated.hlc);
      }
      const key = `${validated.origin}\u0000${validated.recordKey}`;
      const prior = winners.get(key);
      if (!prior || HybridLogicalClock.compare(validated.hlc, prior.hlc) > 0) winners.set(key, { hlc: validated.hlc, line });
    });
    if (originalRecords === 0 || winners.size + passthrough.length === originalRecords) return;

    const ordered = [...winners.values(), ...passthrough].sort((a, b) => {
      const ae = JSON.parse(a.line) as JournalEntry;
      const be = JSON.parse(b.line) as JournalEntry;
      return ae.seq - be.seq;
    });
    const afterWitness = this.witnessMap(ordered);
    if (!this.witnessMapsEqual(beforeWitness, afterWitness)) {
      throw new Error(`replicated journal compaction parity failed for ${file}`);
    }

    const bytesBefore = fs.statSync(file).size;
    const bytesAfter = ordered.reduce((n, winner) => n + Buffer.byteLength(winner.line) + 1, 0);
    total.originalRecords += originalRecords;
    total.compactedRecords += ordered.length;
    total.filesCompacted++;
    total.bytesBefore += bytesBefore;
    total.bytesAfter += bytesAfter;
    if (this.options.dryRun ?? true) return;

    const temp = `${file}.compact-${process.pid}-${Date.now()}.tmp`;
    let fd: number | undefined;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      for (const winner of ordered) fs.writeSync(fd, `${winner.line}\n`);
      fs.fdatasyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      // Correctness gate: rebuild from the actual compacted bytes, not from the
      // winner plan. The temp stream must answer every witness exactly as the
      // original stream before rename is permitted to become the commit point.
      const rebuiltFromTemp = this.witnessMapFromFile(temp, parsed.store, parsed.kind);
      if (!this.witnessMapsEqual(beforeWitness, rebuiltFromTemp)) {
        throw new Error(`replicated journal compaction parity failed for ${file}`);
      }
      this.options.beforeRename?.(file, temp);
      fs.renameSync(temp, file);
      const dirFd = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch (error) {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* best effort */ } }
      try { SafeFsExecutor.safeUnlinkSync(temp, { operation: 'ReplicatedJournalCompactor.cleanup-temp' }); } catch { /* absent temp is fine */ }
      throw error;
    }
  }

  private registeredStreamFiles(): string[] {
    const root = path.join(this.options.stateDir, 'state', 'coherence-journal');
    const dirs = [root, path.join(root, 'peers')];
    const files: string[] = [];
    for (const dir of dirs) {
      let names: string[];
      try { names = fs.readdirSync(dir); } catch { /* @silent-fallback-ok: an absent journal/peers directory means there are no replicated streams to compact. */ continue; }
      for (const name of names) {
        if (!name.endsWith('.jsonl') || name.includes('.quarantine.')) continue;
        const file = path.join(dir, name);
        if (this.registrationForFile(file)) files.push(file);
      }
    }
    return files;
  }

  private registrationForFile(file: string): { store: string; kind: JournalKind } | null {
    const name = path.basename(file);
    for (const store of this.options.registry.stores()) {
      const reg = this.options.registry.getByStore(store);
      if (!reg) continue;
      const marker = `.${reg.kind}`;
      if (name.includes(marker) && /\.jsonl$/.test(name)) return { store, kind: reg.kind as JournalKind };
    }
    return null;
  }

  private validEnvelope(store: string, kind: JournalKind, entry: JournalEntry): { origin: string; recordKey: string; hlc: HlcTimestamp } | null {
    if (entry.kind !== kind || !entry.data || typeof entry.data !== 'object') return null;
    const reg = this.options.registry.getByStore(store);
    if (!reg) return null;
    const result = validateReplicatedEnvelope(entry.data as Record<string, unknown>, reg.schema, NOOP_COUNTERS);
    return result.ok ? { origin: result.envelope.origin, recordKey: result.envelope.recordKey, hlc: result.envelope.hlc } : null;
  }

  private witnessMap(values: Iterable<Winner>): Map<string, HlcTimestamp> {
    const out = new Map<string, HlcTimestamp>();
    for (const winner of values) {
      const entry = JSON.parse(winner.line) as JournalEntry;
      const parsed = this.registrationForFileKind(entry.kind);
      if (!parsed) continue;
      const v = this.validEnvelope(parsed.store, parsed.kind, entry);
      if (!v) continue;
      const prior = out.get(v.recordKey);
      if (!prior || HybridLogicalClock.compare(v.hlc, prior) > 0) out.set(v.recordKey, v.hlc);
    }
    return out;
  }

  private registrationForFileKind(kind: string): { store: string; kind: JournalKind } | null {
    const reg = this.options.registry.getByKind(kind as JournalKind);
    return reg ? { store: reg.store, kind: kind as JournalKind } : null;
  }

  private witnessMapsEqual(a: Map<string, HlcTimestamp>, b: Map<string, HlcTimestamp>): boolean {
    if (a.size !== b.size) return false;
    for (const [key, value] of a) {
      const other = b.get(key);
      if (!other || HybridLogicalClock.compare(value, other) !== 0) return false;
    }
    return true;
  }

  private witnessMapFromFile(file: string, store: string, kind: JournalKind): Map<string, HlcTimestamp> {
    const out = new Map<string, HlcTimestamp>();
    this.forEachLine(file, (_line, entry) => {
      const value = this.validEnvelope(store, kind, entry);
      if (!value) return;
      const prior = out.get(value.recordKey);
      if (!prior || HybridLogicalClock.compare(value.hlc, prior) > 0) out.set(value.recordKey, value.hlc);
    });
    return out;
  }

  private forEachLine(file: string, visit: (line: string, entry: JournalEntry) => void): void {
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(CHUNK_BYTES);
    const decoder = new StringDecoder('utf8');
    let carry = '';
    try {
      for (;;) {
        const count = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (count === 0) break;
        carry += decoder.write(buffer.subarray(0, count));
        let newline: number;
        while ((newline = carry.indexOf('\n')) >= 0) {
          const line = carry.slice(0, newline); carry = carry.slice(newline + 1);
          this.parseLine(line, visit);
        }
      }
      carry += decoder.end();
      this.parseLine(carry, visit);
    } finally { fs.closeSync(fd); }
  }

  private parseLine(line: string, visit: (line: string, entry: JournalEntry) => void): void {
    if (!line) return;
    try { visit(line, JSON.parse(line) as JournalEntry); } catch { /* tolerant journal semantics */ }
  }
}
