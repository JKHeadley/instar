/**
 * ReplicatedPeerStreamReader — materializes a replicated store's per-origin records
 * from the coherence-journal streams on disk (WS2 send-side, the union-read half).
 *
 * Spec: docs/specs/WS2-SEND-SIDE-EMISSION-SPEC.md §3.3 + §3.4; the substrate is
 * docs/specs/multi-machine-replicated-store-foundation.md §7.1 (namespaced per-origin
 * storage), §7.2 (the union the reader merges).
 *
 * THE GAP THIS CLOSES: `ReplicatedStoreReader.loadOriginRecords` returned only the OWN
 * origin, so even a correctly-received peer record (durably written by
 * JournalSyncApplier to `peers/<M>.<kind>.jsonl`) was invisible to a read. This reader
 * is the seam that makes the union real: it reads the OWN stream
 * (`<self>.<kind>.jsonl` + archives) AND every peer replica stream
 * (`peers/<M>.<kind>.jsonl` + archives; quarantine + meta excluded), validates each
 * line through the SAME `validateReplicatedEnvelope` + store schema the writer used,
 * and folds to the LATEST record per `(origin, recordKey)` by HLC-max. A delete is a
 * tombstone (kept) so the union's delete-resolution + resurrection guard work.
 *
 * It supplies three seams to the rest of the system:
 *   - `loadOriginRecords(store, recordKey)` + `listRecordKeys(store)` — the
 *     ReplicatedStoreReader seams (the no-clobber union's per-origin input).
 *   - `loadWitness(store, recordKey)` — the emitter's `observed` source (the MAX HLC
 *     over every origin record held for the key — own prior + applied peers).
 *   - `loadOwnEntries(store, origin)` — the snapshot-serve seam (raw OWN entries by
 *     kind), replacing the `loadOwnEntries: () => ({})` stub.
 *
 * PURE-ish: all I/O is the injected `fsImpl` (defaults to node:fs); no Date, no
 * network. Bounded — replicated memory stores are small (per-kind retention caps), and
 * the read ceiling mirrors the applier's SERVE_READ_BYTE_CEILING.
 */

import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import {
  type JournalFs,
  type JournalEntry,
  type JournalKind,
  sanitizeMachineId,
  readTailTolerant,
} from './CoherenceJournal.js';
import { HybridLogicalClock, type HlcTimestamp } from './HybridLogicalClock.js';
import {
  validateReplicatedEnvelope,
  type ReplicatedKindRegistry,
  type EnvelopeValidationCounters,
  type StoreFieldSchema,
} from './ReplicatedRecordEnvelope.js';
import type { OriginRecord } from './UnionReader.js';
import type { RawJournalEntry } from './StoreSnapshot.js';

/** The byte ceiling for one stream read (mirrors JournalSyncApplier.SERVE_READ_BYTE_CEILING). */
const READ_BYTE_CEILING = 64 * 1024 * 1024;

/** A counters bag that ignores every bump — the reader surfaces nothing per-field
 *  (a malformed replica line is simply dropped from the union, the safe direction). */
const NOOP_COUNTERS: EnvelopeValidationCounters = {
  bumpSchemaReject: () => {},
  bumpDroppedField: () => {},
  bumpJailReject: () => {},
};

const STREAM_CHUNK_BYTES = 64 * 1024;
const WITNESS_KEY_SEPARATOR = '\u0000';

interface WitnessIndexEntry {
  hlc: HlcTimestamp;
}

interface RegisteredStreamRecord {
  store: string;
  recordKey: string;
  origin: string;
  hlc: HlcTimestamp;
}

export interface ReplicatedPeerStreamReaderConfig {
  /** Absolute path to the agent's `.instar/` directory (the stateDir). */
  stateDir: string;
  /** The replicated-kind registry — resolves store → kind + the store schema. */
  registry: ReplicatedKindRegistry;
  /** This machine's id (the OWN origin). */
  selfMachineId: string;
  /** Optional fs seam for fault-injection tests. Defaults to node:fs. */
  fsImpl?: JournalFs;
  /** Optional logger for parity/index degradation. */
  logger?: (msg: string) => void;
  /** Control seam for non-server consumers. The server starts rebuild after listen. */
  autoRebuild?: boolean;
}

function realFs(): JournalFs {
  return {
    openSync: fs.openSync,
    writeSync: fs.writeSync,
    fdatasyncSync: fs.fdatasyncSync,
    closeSync: fs.closeSync,
    existsSync: fs.existsSync,
    statSync: fs.statSync,
    renameSync: fs.renameSync,
    writeFileSync: fs.writeFileSync,
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
    truncateSync: fs.truncateSync,
    mkdirSync: fs.mkdirSync,
    readSync: fs.readSync,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// RULE 3: EXEMPT — this is NOT a state-detector. ReplicatedPeerStreamReader reads
// the agent's OWN coherence-journal stream files (a fixed, self-authored JSONL format)
// and validates each line through validateReplicatedEnvelope. It does not parse
// provider/CLI output, does not detect external/environment state, and has no
// signature-matching that could drift across providers — it deterministically folds
// in-house journal entries by HLC. The "*Reader" name matches the Rule-3 pattern
// heuristic but the substance is an internal-format reader (mirrors the same exemption
// on ReplicatedStoreReader).
export class ReplicatedPeerStreamReader {
  private readonly stateDir: string;
  private readonly registry: ReplicatedKindRegistry;
  private readonly selfMachineId: string;
  private readonly io: JournalFs;
  private readonly logger?: (msg: string) => void;
  private witnessIndexTrusted = false;
  private readonly witnessIndex = new Map<string, WitnessIndexEntry>();
  private loggedWitnessParityMismatch = false;
  private witnessGeneration = 0;
  private rebuildRunning = false;

  constructor(config: ReplicatedPeerStreamReaderConfig) {
    if (!config) throw new Error('ReplicatedPeerStreamReader: config required');
    if (!config.registry) throw new Error('ReplicatedPeerStreamReader: registry required (not null)');
    if (typeof config.selfMachineId !== 'string' || config.selfMachineId.length === 0) {
      throw new Error('ReplicatedPeerStreamReader: selfMachineId must be a non-empty string');
    }
    this.stateDir = config.stateDir;
    this.registry = config.registry;
    this.selfMachineId = config.selfMachineId;
    this.io = config.fsImpl ?? realFs();
    this.logger = config.logger;
    // Boot-critical invariant: constructor performs NO journal scan. Until the
    // cooperative rebuild + parity pass completes, loadWitness serves the
    // legacy path. Production starts this explicitly only after server.listen.
    if (config.autoRebuild === true) setImmediate(() => { void this.rebuildWitnessIndexAsync(); });
  }

  // ── The ReplicatedStoreReader seams ────────────────────────────────────────

  /**
   * Every origin's CURRENT record for (store, recordKey) — the own stream + each peer
   * replica namespace, ONE record per origin (the latest by HLC, a delete kept as a
   * tombstone). The union reader merges these via the no-clobber rule. A single-machine
   * install returns only the own origin (so the union is a strict no-op = that record).
   */
  loadOriginRecords(store: string, recordKey: string): OriginRecord[] {
    const byOrigin = this.materialize(store).get(recordKey);
    return byOrigin ? [...byOrigin.values()] : [];
  }

  /** Every recordKey the store currently holds across ALL origins (for readAll). */
  listRecordKeys(store: string): string[] {
    return [...this.materialize(store).keys()];
  }

  // ── The emitter `observed`-witness seam (§7.2) ─────────────────────────────

  /**
   * The MAX HLC over every origin record this machine currently holds for
   * (store, recordKey) — own prior + applied peers. The author stamps this as the
   * record's `observed` witness. Returns undefined when none is held (first write of
   * the key) ⇒ the author omits `observed` ⇒ flag-on-conflict (the safe direction).
   * Sound: it only witnesses a version provably on disk, so a not-yet-pulled peer
   * version is absent here and the merge flags concurrent rather than silently
   * resolving (§7.2 err-toward-flag).
   */
  loadWitness(store: string, recordKey: string): HlcTimestamp | undefined {
    if (this.witnessIndexTrusted) {
      return this.witnessIndex.get(this.witnessKey(store, recordKey))?.hlc;
    }
    // Parity safety valve: if the derived index ever disagrees with a legacy
    // scan during rebuild, serve the old full-scan answer until a later rebuild
    // restores parity.
    const records = this.loadOriginRecords(store, recordKey);
    let max: HlcTimestamp | undefined;
    for (const r of records) {
      if (max === undefined || HybridLogicalClock.compare(r.envelope.hlc, max) > 0) {
        max = r.envelope.hlc;
      }
    }
    return max;
  }

  /**
   * Incrementally update the DERIVED witness index after replicated entries have
   * crossed a durability boundary. The journal/replica streams remain the source
   * of truth; crash/loss simply rebuilds this map from disk.
   */
  observeCommittedEntries(kind: JournalKind, entries: JournalEntry[]): void {
    const reg = this.registry.getByKind(kind);
    if (!reg || entries.length === 0) return;
    for (const entry of entries) {
      const rec = this.validRegisteredRecord(reg.store, reg.schema, kind, entry);
      if (!rec) continue;
      this.putWitness(rec.store, rec.recordKey, rec.hlc, this.witnessIndex);
    }
    this.witnessGeneration++;
  }

  /** Rebuild the derived witness index from the journal streams and parity-check it. */
  rebuildWitnessIndex(): void {
    const next = new Map<string, WitnessIndexEntry>();
    this.scanRegisteredStreams((rec) => {
      this.putWitness(rec.store, rec.recordKey, rec.hlc, next);
    });

    const legacy = this.scanWitnessesLegacy();
    if (!this.witnessMapsEqual(next, legacy)) {
      this.witnessIndexTrusted = false;
      this.witnessIndex.clear();
      for (const [k, v] of next.entries()) this.witnessIndex.set(k, v);
      if (!this.loggedWitnessParityMismatch) {
        this.loggedWitnessParityMismatch = true;
        this.logger?.('[replicated-peer-stream-reader] witness index parity mismatch; falling back to legacy scan until rebuild parity is restored');
      }
      return;
    }

    this.witnessIndexTrusted = true;
    this.witnessIndex.clear();
    for (const [k, v] of next.entries()) this.witnessIndex.set(k, v);
  }

  /**
   * Cooperative post-boot rebuild. Each filesystem read is one fixed chunk and
   * yields before the next, so journal size cannot monopolize boot/the event loop.
   * The candidate map is never served until a separate cooperative legacy pass
   * agrees. A durable append during either pass invalidates publication and queues
   * a fresh rebuild, preventing a half-built/stale index from becoming trusted.
   */
  async rebuildWitnessIndexAsync(): Promise<void> {
    if (this.rebuildRunning) return;
    this.rebuildRunning = true;
    const generation = this.witnessGeneration;
    try {
      const next = new Map<string, WitnessIndexEntry>();
      await this.scanRegisteredStreamsAsync((rec) => this.putWitness(rec.store, rec.recordKey, rec.hlc, next));
      const legacy = await this.scanWitnessesLegacyAsync();
      if (generation !== this.witnessGeneration) {
        setImmediate(() => { void this.rebuildWitnessIndexAsync(); });
        return;
      }
      if (!this.witnessMapsEqual(next, legacy)) {
        this.witnessIndexTrusted = false;
        if (!this.loggedWitnessParityMismatch) {
          this.loggedWitnessParityMismatch = true;
          this.logger?.('[replicated-peer-stream-reader] witness index parity mismatch; falling back to legacy scan until rebuild parity is restored');
        }
        return;
      }
      this.witnessIndex.clear();
      for (const [key, value] of next) this.witnessIndex.set(key, value);
      this.witnessIndexTrusted = true;
    } catch { /* @silent-fallback-ok: derived optimization only; legacy witness scanning remains authoritative while an async rebuild fails. */
      this.witnessIndexTrusted = false;
    } finally {
      this.rebuildRunning = false;
    }
  }

  // ── The snapshot-serve seam (replaces loadOwnEntries: () => ({})) ──────────

  /**
   * The OWN-stream raw entries for `store`, keyed by contributing journal kind — the
   * single-origin snapshot input (§6). `origin` MUST be this machine (single-origin,
   * §6.1); a request for any other origin returns `{}` (we only serve what we
   * authored). Reads the own current + archive streams; returns ALL entries (the
   * materializer folds to the latest per recordKey and computes the seq watermark).
   */
  loadOwnEntries(store: string, origin: string): Record<string, RawJournalEntry[]> {
    const reg = this.registry.getByStore(store);
    if (!reg) return {};
    // Single-origin: only serve OUR OWN authored stream.
    if (origin !== this.selfMachineId) return {};
    const kind = reg.kind as JournalKind;
    const entries = this.readKindEntries(this.ownStreamFiles(origin, kind));
    if (entries.length === 0) return {};
    const raw: RawJournalEntry[] = entries.map((e) => ({
      seq: e.seq,
      ts: e.ts,
      machine: e.machine,
      kind: e.kind,
      data: e.data,
    }));
    return { [kind]: raw };
  }

  // ── Materialization (own + peer streams → latest per (origin, recordKey)) ──

  /**
   * Build `recordKey → (origin → latest OriginRecord)` for a store by reading the own
   * stream + every peer replica stream and folding by HLC-max per (origin, recordKey).
   * Read FRESH each call (no cache) so a write-then-read is always consistent — the
   * stores are small + bounded, so the scan is cheap.
   */
  private materialize(store: string): Map<string, Map<string, OriginRecord>> {
    const out = new Map<string, Map<string, OriginRecord>>();
    const reg = this.registry.getByStore(store);
    if (!reg) return out;
    const kind = reg.kind as JournalKind;
    const schema = reg.schema;

    const files = [
      ...this.ownStreamFiles(this.selfMachineId, kind),
      ...this.peerStreamFiles(kind),
    ];
    for (const file of files) {
      const entries = this.readKindEntries([file]);
      for (const entry of entries) {
        if (entry.kind !== kind) continue;
        const data = entry.data;
        if (!data || typeof data !== 'object') continue;
        const result = validateReplicatedEnvelope(data as Record<string, unknown>, schema, NOOP_COUNTERS);
        if (!result.ok) continue;
        const origin = result.envelope.origin;
        const recordKey = result.envelope.recordKey;
        const rec: OriginRecord = { origin, envelope: result.envelope, data: result.storeFields };
        let byOrigin = out.get(recordKey);
        if (!byOrigin) {
          byOrigin = new Map<string, OriginRecord>();
          out.set(recordKey, byOrigin);
        }
        const prior = byOrigin.get(origin);
        // Keep the LATEST record per (origin, recordKey) by HLC-max (a delete is a
        // tombstone — kept, so the union resolves delete↔put deterministically).
        if (!prior || HybridLogicalClock.compare(rec.envelope.hlc, prior.envelope.hlc) > 0) {
          byOrigin.set(origin, rec);
        }
      }
    }
    return out;
  }

  /** Read + tolerant-parse every JournalEntry from the given stream files. */
  private readKindEntries(files: string[]): JournalEntry[] {
    const out: JournalEntry[] = [];
    for (const f of files) {
      const read = readTailTolerant(this.io, f, Number.MAX_SAFE_INTEGER, READ_BYTE_CEILING);
      for (const e of read.entries) out.push(e);
    }
    return out;
  }

  private scanRegisteredStreams(visit: (record: RegisteredStreamRecord) => void): void {
    for (const store of this.registry.stores()) {
      const reg = this.registry.getByStore(store);
      if (!reg) continue;
      const kind = reg.kind as JournalKind;
      const files = [
        ...this.ownStreamFiles(this.selfMachineId, kind),
        ...this.peerStreamFiles(kind),
      ];
      for (const file of files) {
        this.forEachJournalEntryInFile(file, (entry) => {
          const rec = this.validRegisteredRecord(store, reg.schema, kind, entry);
          if (rec) visit(rec);
        });
      }
    }
  }

  private async scanRegisteredStreamsAsync(visit: (record: RegisteredStreamRecord) => void): Promise<void> {
    for (const store of this.registry.stores()) {
      const reg = this.registry.getByStore(store);
      if (!reg) continue;
      const kind = reg.kind as JournalKind;
      const files = [...this.ownStreamFiles(this.selfMachineId, kind), ...this.peerStreamFiles(kind)];
      for (const file of files) {
        await this.forEachJournalEntryInFileAsync(file, (entry) => {
          const rec = this.validRegisteredRecord(store, reg.schema, kind, entry);
          if (rec) visit(rec);
        });
      }
    }
  }

  /**
   * Legacy witness answer used only for parity mode. This intentionally uses the
   * pre-index materializer so an attribution bug in the derived index is caught
   * before the index is trusted.
   */
  private scanWitnessesLegacy(): Map<string, WitnessIndexEntry> {
    const out = new Map<string, WitnessIndexEntry>();
    for (const store of this.registry.stores()) {
      for (const recordKey of this.materialize(store).keys()) {
        const records = this.loadOriginRecords(store, recordKey);
        for (const r of records) {
          this.putWitness(store, recordKey, r.envelope.hlc, out);
        }
      }
    }
    return out;
  }

  /** Separate parity fold: latest per (store, key, origin), then max by key. */
  private async scanWitnessesLegacyAsync(): Promise<Map<string, WitnessIndexEntry>> {
    const byOrigin = new Map<string, RegisteredStreamRecord>();
    await this.scanRegisteredStreamsAsync((rec) => {
      const key = `${rec.store}${WITNESS_KEY_SEPARATOR}${rec.recordKey}${WITNESS_KEY_SEPARATOR}${rec.origin}`;
      const prior = byOrigin.get(key);
      if (!prior || HybridLogicalClock.compare(rec.hlc, prior.hlc) > 0) byOrigin.set(key, rec);
    });
    const out = new Map<string, WitnessIndexEntry>();
    for (const rec of byOrigin.values()) this.putWitness(rec.store, rec.recordKey, rec.hlc, out);
    return out;
  }

  private validRegisteredRecord(
    store: string,
    schema: StoreFieldSchema,
    kind: JournalKind,
    entry: JournalEntry,
  ): RegisteredStreamRecord | null {
    if (entry.kind !== kind) return null;
    const data = entry.data;
    if (!data || typeof data !== 'object') return null;
    const result = validateReplicatedEnvelope(data as Record<string, unknown>, schema, NOOP_COUNTERS);
    if (!result.ok) return null;
    return {
      store,
      recordKey: result.envelope.recordKey,
      origin: result.envelope.origin,
      hlc: result.envelope.hlc,
    };
  }

  private putWitness(store: string, recordKey: string, hlc: HlcTimestamp, target: Map<string, WitnessIndexEntry>): void {
    const key = this.witnessKey(store, recordKey);
    const prior = target.get(key);
    if (!prior || HybridLogicalClock.compare(hlc, prior.hlc) > 0) {
      target.set(key, { hlc });
    }
  }

  private witnessKey(store: string, recordKey: string): string {
    return `${store}${WITNESS_KEY_SEPARATOR}${recordKey}`;
  }

  private witnessMapsEqual(a: Map<string, WitnessIndexEntry>, b: Map<string, WitnessIndexEntry>): boolean {
    if (a.size !== b.size) return false;
    for (const [key, av] of a.entries()) {
      const bv = b.get(key);
      if (!bv || HybridLogicalClock.compare(av.hlc, bv.hlc) !== 0) return false;
    }
    return true;
  }

  /** Stream a JSONL file forward in fixed chunks. Never materializes the file. */
  private forEachJournalEntryInFile(filePath: string, visit: (entry: JournalEntry) => void): void {
    if (!this.io.existsSync(filePath)) return;
    let fd: number | null = null;
    try {
      fd = this.io.openSync(filePath, 'r');
      const buf = Buffer.alloc(STREAM_CHUNK_BYTES);
      const decoder = new StringDecoder('utf8');
      let carry = '';
      for (;;) {
        const read = this.io.readSync(fd, buf, 0, buf.length, null);
        if (read <= 0) break;
        carry += decoder.write(buf.subarray(0, read));
        let nl: number;
        while ((nl = carry.indexOf('\n')) >= 0) {
          const line = carry.slice(0, nl);
          carry = carry.slice(nl + 1);
          this.parseJournalLine(line, visit);
        }
      }
      carry += decoder.end();
      this.parseJournalLine(carry, visit);
    } catch { /* @silent-fallback-ok: witness index is derived/rebuildable; unreadable streams are treated like absent witness and parity fallback can use the legacy scan. */
      return;
    } finally {
      if (fd !== null) {
        try {
          this.io.closeSync(fd);
        } catch { /* @silent-fallback-ok: closing a derived-index read descriptor is best-effort; the authoritative journal remains intact. */
        }
      }
    }
  }

  /** Fixed-chunk cooperative reader: at most one 64 KiB sync read per turn. */
  private async forEachJournalEntryInFileAsync(filePath: string, visit: (entry: JournalEntry) => void): Promise<void> {
    if (!this.io.existsSync(filePath)) return;
    let fd: number | null = null;
    try {
      fd = this.io.openSync(filePath, 'r');
      const buf = Buffer.alloc(STREAM_CHUNK_BYTES);
      const decoder = new StringDecoder('utf8');
      let carry = '';
      for (;;) {
        const read = this.io.readSync(fd, buf, 0, buf.length, null);
        if (read <= 0) break;
        carry += decoder.write(buf.subarray(0, read));
        let nl: number;
        while ((nl = carry.indexOf('\n')) >= 0) {
          const line = carry.slice(0, nl);
          carry = carry.slice(nl + 1);
          this.parseJournalLine(line, visit);
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      carry += decoder.end();
      this.parseJournalLine(carry, visit);
    } finally {
      if (fd !== null) {
        try { this.io.closeSync(fd); } catch { /* @silent-fallback-ok: closing a derived-index read descriptor is best-effort; legacy reads remain authoritative. */ }
      }
    }
  }

  private parseJournalLine(line: string, visit: (entry: JournalEntry) => void): void {
    if (!line) return;
    try {
      const obj = JSON.parse(line) as JournalEntry;
      if (typeof obj.seq === 'number' && typeof obj.kind === 'string') visit(obj);
    } catch { /* @silent-fallback-ok: tolerant journal readers skip corrupt/torn lines; authoritative repair happens at the journal layer. */
    }
  }

  // ── Path enumeration ───────────────────────────────────────────────────────

  private journalDir(): string {
    return path.join(this.stateDir, 'state', 'coherence-journal');
  }

  private peersDir(): string {
    return path.join(this.journalDir(), 'peers');
  }

  /** Own current + archive stream files for (origin, kind), newest-first by stamp. */
  private ownStreamFiles(origin: string, kind: JournalKind): string[] {
    const safe = sanitizeMachineId(origin);
    const dir = this.journalDir();
    const current = path.join(dir, `${safe}.${kind}.jsonl`);
    const out: string[] = [];
    if (this.io.existsSync(current)) out.push(current);
    out.push(...this.archivesFor(dir, safe, kind));
    return out;
  }

  /** Every peer replica current + archive stream file for `kind` (quarantine excluded). */
  private peerStreamFiles(kind: JournalKind): string[] {
    const dir = this.peersDir();
    let names: string[];
    try {
      names = this.io.readdirSync(dir) as string[];
    } catch { /* @silent-fallback-ok: peers dir absent = no peers yet (single-machine / fresh) — an empty union, never an error. */
      return [];
    }
    const k = escapeRegExp(kind);
    // `<id>.<kind>.jsonl` (current) OR `<id>.<kind>.<digits>.jsonl` (archive). The
    // `<id>` is greedy (`.+`) and may itself contain dots. Quarantine files
    // (`<id>.<kind>.quarantine.<digits>.jsonl`) are EXCLUDED — they are a fenced
    // old incarnation, never part of the live union.
    const re = new RegExp(`^(.+)\\.${k}(?:\\.\\d+)?\\.jsonl$`);
    const out: string[] = [];
    for (const n of names) {
      if (n.includes('.quarantine.')) continue;
      if (re.test(n)) out.push(path.join(dir, n));
    }
    return out;
  }

  /** Archive files `<safe>.<kind>.<stamp>.jsonl` in `dir`, newest-first. */
  private archivesFor(dir: string, safe: string, kind: JournalKind): string[] {
    let names: string[];
    try {
      names = this.io.readdirSync(dir) as string[];
    } catch { /* @silent-fallback-ok: dir absent = nothing to read — empty, never an error. */
      return [];
    }
    const re = new RegExp(`^${escapeRegExp(`${safe}.${kind}.`)}(\\d+)\\.jsonl$`);
    const archives: { file: string; stamp: number }[] = [];
    for (const n of names) {
      const m = re.exec(n);
      if (m) archives.push({ file: path.join(dir, n), stamp: Number(m[1]) });
    }
    archives.sort((a, b) => b.stamp - a.stamp);
    return archives.map((a) => a.file);
  }
}
