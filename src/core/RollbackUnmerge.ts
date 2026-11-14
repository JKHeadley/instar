/**
 * RollbackUnmerge — deterministic origin-drop un-merge with no dangling references
 * (WS2 replicated-store foundation, Component 6 / §7.4).
 *
 * Spec: docs/specs/multi-machine-replicated-store-foundation.md §7.4 (disabling
 * stateSync.<store> for a peer atomically DROPS that origin's foreign namespace —
 * a real un-merge, not a flag; the union recomputes live; the dropped streams +
 * per-peer meta + snapshot cache are QUARANTINED-ASIDE, reversible + auditable,
 * NEVER a destructive delete; no dangling references; a conflictId whose
 * version-pair referenced the dropped origin auto-RESOLVES + its attention item
 * closes), §11 (machine-local-by-design — a machine un-merges ITS OWN copy of a
 * peer's namespace, never reaches into the peer).
 *
 * THE LIVE-RECOMPUTE INVARIANT (why this is a real un-merge, §7.4 step 1+3).
 * Because records are keyed by (recordKey, origin) and the union reader computes
 * the union LIVE from the per-origin namespaces, REMOVING an origin from the set
 * of participating namespaces instantly removes its contribution — no rewrite of
 * any surviving record is needed. A key whose winning value came from the dropped
 * origin reverts to the HLC-latest among the REMAINING origins (or to "no record"
 * if none remains). The DroppedOriginRegistry is the live exclusion set the
 * union reader consults; the quarantine-aside is the durability/reversibility leg.
 *
 * QUARANTINE-ASIDE (§7.4 step 2 — NEVER a destructive delete). The dropped
 * origin's replica streams + per-peer meta + snapshot-cache entries are RENAMED
 * aside (rename is non-destructive: node:fs renameSync, mirroring
 * JournalSyncApplier.quarantineReplica) into a bounded-retain ring; the ONLY
 * actual deletion — pruning the oldest retained un-merge past the ring bound —
 * goes through SafeFsExecutor.safeRmSync (the destructive-fs funnel + audit
 * trail). A re-merge restores from the ring (reversibility).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

import { SafeFsExecutor } from './SafeFsExecutor.js';
import { sanitizeMachineId } from './CoherenceJournal.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

/** How many un-merge quarantine sets to retain per (store, origin) before the
 *  oldest is pruned (mirrors JournalSyncApplier.MAX_QUARANTINE_PER_STREAM). */
export const MAX_UNMERGE_RETAIN = 2;

/** Persistent record of which (store, origin) pairs are currently un-merged. The
 *  union reader consults this so a dropped origin is excluded LIVE — the
 *  un-merge survives restarts. */
export interface DroppedOriginEntry {
  store: string;
  origin: string;
  droppedAt: string;
}

interface DroppedDoc {
  version: 1;
  dropped: DroppedOriginEntry[];
}

/** Health of the durable dropped-origins file as read at construction. */
export interface DroppedOriginRegistryHealth {
  /** `healthy`: absent or fully valid. `damaged`: the file could not be read,
   *  did not parse, failed the schema, or held entries that had to be filtered
   *  out — the full exclusion set is UNKNOWN and mutation is refused. */
  status: 'healthy' | 'damaged';
  /** Why the file was judged damaged (absent when healthy). */
  reason?: string;
  /** Where the damaged bytes were copied aside (null when the copy failed or
   *  the file could not be read at all). */
  preservedAt?: string | null;
  /** How many entries were recovered from the damaged file and are still
   *  treated as excluded. */
  salvagedCount?: number;
}

/** Thrown by add()/remove() when the registry loaded from a damaged file: a
 *  write would replace the damaged file with a partial list and permanently
 *  erase every exclusion that could not be recovered. */
export class DroppedOriginRegistryDamagedError extends Error {
  readonly health: DroppedOriginRegistryHealth;
  constructor(op: 'add' | 'remove', health: DroppedOriginRegistryHealth) {
    super(
      `dropped-origin registry is damaged (${health.reason ?? 'unknown'}); refusing to ${op} — ` +
        'writing now would overwrite the damaged file with a partial list and erase the exclusions it could not recover',
    );
    this.name = 'DroppedOriginRegistryDamagedError';
    this.health = health;
  }
}

function isEntry(d: unknown): d is DroppedOriginEntry {
  return (
    !!d &&
    typeof d === 'object' &&
    typeof (d as DroppedOriginEntry).store === 'string' &&
    typeof (d as DroppedOriginEntry).origin === 'string' &&
    (d as DroppedOriginEntry).store.length > 0 &&
    (d as DroppedOriginEntry).origin.length > 0
  );
}

/** Best-effort recovery of `{ "store": ..., "origin": ... }` pairs from text
 *  that does not parse as JSON (the usual shape of damage is a truncated
 *  write). Only objects that themselves parse are kept. */
function salvageEntries(raw: string): DroppedOriginEntry[] {
  const out: DroppedOriginEntry[] = [];
  const re = /\{[^{}]*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    try {
      const obj = JSON.parse(m[0]) as unknown;
      if (isEntry(obj)) {
        out.push({
          store: obj.store,
          origin: obj.origin,
          droppedAt: typeof obj.droppedAt === 'string' ? obj.droppedAt : '',
        });
      }
    } catch {
      // @silent-fallback-ok: an unparseable fragment is simply not recoverable;
      // the registry is already marked damaged and the degradation is reported.
    }
  }
  return out;
}

/** The durable set of un-merged (store, origin) pairs. Consulted by the union
 *  reader's participating-namespace filter (§7.4).
 *
 *  FAIL-SAFE ON DAMAGE. If the file exists but cannot be fully trusted (read
 *  error, bad JSON, wrong shape/version, or any entry that had to be filtered
 *  out) the registry:
 *   - keeps every entry it CAN recover as excluded (a revoked/dropped origin
 *     must not silently come back),
 *   - copies the damaged bytes aside (non-destructive, idempotent by content
 *     hash) and leaves the original in place, so the next restart still sees
 *     the damage instead of a falsely healthy file,
 *   - refuses add()/remove() with DroppedOriginRegistryDamagedError rather than
 *     overwrite the file with the partial list (add() still applies the new
 *     exclusion in memory — the safe direction — but does not write it),
 *   - reports one degradation naming the preserved copy and the repair.
 *  Entries from other machines are never ignored here: an exclusion is kept
 *  whatever origin it names. */
export class DroppedOriginRegistry {
  private readonly stateDir: string;
  private readonly readFileSync: (p: string) => string;
  private readonly existsSync: (p: string) => boolean;
  private readonly copyFileSync: (from: string, to: string) => void;
  private readonly reportDegradation: (detail: { reason: string; preservedAt: string | null; salvagedCount: number; path: string }) => void;
  private healthState: DroppedOriginRegistryHealth = { status: 'healthy' };
  private doc: DroppedDoc;
  private readonly physicalRoot: {path:string;device:bigint;inode:bigint}|null;

  constructor(seams: {
    stateDir: string;
    readFileSync?: (p: string) => string;
    existsSync?: (p: string) => boolean;
    copyFileSync?: (from: string, to: string) => void;
    reportDegradation?: (detail: { reason: string; preservedAt: string | null; salvagedCount: number; path: string }) => void;
  }) {
    this.stateDir = seams.stateDir;
    try {const root=fs.realpathSync(seams.stateDir),stat=fs.statSync(root,{bigint:true});this.physicalRoot=stat.isDirectory()?{path:root,device:stat.dev,inode:stat.ino}:null;}
    catch { /* @silent-fallback-ok: generic injected registries remain supported; the new physical proof API refuses them. */ this.physicalRoot=null; }
    this.readFileSync = seams.readFileSync ?? ((p) => fs.readFileSync(p, 'utf-8'));
    this.existsSync = seams.existsSync ?? ((p) => fs.existsSync(p));
    this.copyFileSync = seams.copyFileSync ?? ((from, to) => fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL));
    this.reportDegradation = seams.reportDegradation ?? defaultReportDegradation;
    this.doc = this.load();
  }

  /** Narrow physical evidence API. Does not refresh or rewrite generic live
   * registry semantics: stale/injected/corrupt physical state refuses proof. */
  physicalSnapshot(expectedRoot:string):string {
    const root=this.physicalRoot;if(!root||root.path!==expectedRoot||fs.realpathSync(this.stateDir)!==root.path)throw new Error('dropped-origin-physical-root-mismatch');
    const stat=fs.statSync(root.path,{bigint:true});if(!stat.isDirectory()||stat.dev!==root.device||stat.ino!==root.inode)throw new Error('dropped-origin-physical-root-changed');
    const file=path.join(root.path,'state','state-sync','dropped-origins.json');
    let missing=false;for(const component of [path.join(root.path,'state'),path.dirname(file)]){try{const entry=fs.lstatSync(component);if(!entry.isDirectory()||entry.isSymbolicLink())throw new Error('dropped-origin-physical-path-invalid');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;missing=true;break;}}
    let disk:unknown={version:1,dropped:[]};if(!missing){let fd:number|undefined;try{fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));const entry=fs.fstatSync(fd);if(!entry.isFile()||entry.size>4*1024*1024)throw new Error('dropped-origin-physical-file-invalid');disk=JSON.parse(fs.readFileSync(fd,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}finally{if(fd!==undefined)fs.closeSync(fd);}}
    const normalize=(value:unknown):string=>{const raw=value as DroppedDoc;if(!raw||typeof raw!=='object'||Object.keys(raw).sort().join(',')!=='dropped,version'||raw.version!==1||!Array.isArray(raw.dropped)||raw.dropped.length>20000)throw new Error('dropped-origin-physical-document-invalid');const seen=new Set<string>();const rows=raw.dropped.map(row=>{if(!row||typeof row!=='object'||Object.keys(row).sort().join(',')!=='droppedAt,origin,store'||typeof row.store!=='string'||typeof row.origin!=='string'||typeof row.droppedAt!=='string')throw new Error('dropped-origin-physical-entry-invalid');const key=JSON.stringify([row.store,row.origin]);if(seen.has(key))throw new Error('dropped-origin-physical-duplicate');seen.add(key);return [row.store,row.origin,row.droppedAt];}).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));return JSON.stringify(rows);};
    const physical=normalize(disk);if(physical!==normalize(this.doc))throw new Error('dropped-origin-physical-state-changed');return createHash('sha256').update(physical).digest('hex');
  }

  private docPath(): string {
    return path.join(this.stateDir, 'state', 'state-sync', 'dropped-origins.json');
  }

  private load(): DroppedDoc {
    const p = this.docPath();
    if (!this.existsSync(p)) return { version: 1, dropped: [] };
    let text: string;
    try {
      text = this.readFileSync(p);
    } catch (e) {
      return this.markDamaged(`unreadable: ${(e as Error)?.message ?? String(e)}`, null, []);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return this.markDamaged('not valid JSON', text, salvageEntries(text));
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return this.markDamaged('not a JSON object', text, []);
    }
    const docRaw = raw as { version?: unknown; dropped?: unknown };
    if (!Array.isArray(docRaw.dropped)) {
      return this.markDamaged('"dropped" is not a list', text, []);
    }
    const valid = docRaw.dropped.filter(isEntry).map((d) => ({
      store: d.store,
      origin: d.origin,
      droppedAt: typeof d.droppedAt === 'string' ? d.droppedAt : '',
    }));
    if (docRaw.version !== 1) {
      return this.markDamaged(`unknown version ${JSON.stringify(docRaw.version)}`, text, valid);
    }
    if (valid.length !== docRaw.dropped.length) {
      return this.markDamaged(`${docRaw.dropped.length - valid.length} malformed entr${docRaw.dropped.length - valid.length === 1 ? 'y' : 'ies'}`, text, valid);
    }
    return { version: 1, dropped: valid };
  }

  /** Record the damage, preserve the bytes aside, report once, and return the
   *  salvaged (still-excluded) entries. Never writes to the original file. */
  private markDamaged(reason: string, text: string | null, salvaged: DroppedOriginEntry[]): DroppedDoc {
    const p = this.docPath();
    let preservedAt: string | null = null;
    if (text !== null) {
      const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
      const aside = `${p}.damaged-${hash}`;
      try {
        if (this.existsSync(aside)) preservedAt = aside;
        else {
          this.copyFileSync(p, aside);
          preservedAt = aside;
        }
      } catch {
        // @silent-fallback-ok: the original file is left untouched either way;
        // the degradation below reports that no aside copy could be made.
        preservedAt = null;
      }
    }
    // De-duplicate salvaged entries (a damaged file may repeat a pair).
    const seen = new Set<string>();
    const dropped = salvaged.filter((d) => {
      const k = `${d.store}\u0000${d.origin}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    this.healthState = { status: 'damaged', reason, preservedAt, salvagedCount: dropped.length };
    try {
      this.reportDegradation({ reason, preservedAt, salvagedCount: dropped.length, path: p });
    } catch {
      // @silent-fallback-ok: reporting is signal-only; the damaged status is
      // still visible through health() and GET /state/quarantine.
    }
    return { version: 1, dropped };
  }

  private persist(): void {
    SafeFsExecutor.atomicWriteJsonSync(this.docPath(), this.doc, { operation: 'dropped-origin-registry:persist' });
  }

  /** Whether the on-disk file was fully trusted at load (see class doc). */
  health(): DroppedOriginRegistryHealth {
    return { ...this.healthState };
  }

  /** Is (store, origin) currently un-merged (excluded from the union)? */
  isDropped(store: string, origin: string): boolean {
    return this.doc.dropped.some((d) => d.store === store && d.origin === origin);
  }

  /** The set of dropped origins for a store (for the reader's namespace filter). */
  droppedOrigins(store: string): Set<string> {
    return new Set(this.doc.dropped.filter((d) => d.store === store).map((d) => d.origin));
  }

  add(store: string, origin: string, at: string): void {
    if (this.isDropped(store, origin)) return;
    this.doc.dropped.push({ store, origin, droppedAt: at });
    // Damaged: the new exclusion takes effect live (more exclusion is the safe
    // direction) but is NOT written — persisting would replace the damaged file
    // with this partial list.
    if (this.healthState.status === 'damaged') throw new DroppedOriginRegistryDamagedError('add', this.health());
    this.persist();
  }

  remove(store: string, origin: string): void {
    // Damaged: refuse entirely. Un-dropping lets an origin back in, and writing
    // would erase the exclusions that could not be recovered.
    if (this.healthState.status === 'damaged') throw new DroppedOriginRegistryDamagedError('remove', this.health());
    const before = this.doc.dropped.length;
    this.doc.dropped = this.doc.dropped.filter((d) => !(d.store === store && d.origin === origin));
    if (this.doc.dropped.length !== before) this.persist();
  }

  list(): DroppedOriginEntry[] {
    return [...this.doc.dropped];
  }
}

function defaultReportDegradation(detail: { reason: string; preservedAt: string | null; salvagedCount: number; path: string }): void {
  DegradationReporter.getInstance().report({
    feature: 'DroppedOriginRegistry',
    primary: 'Read the list of machines whose replicated data is excluded (dropped or revoked origins)',
    fallback: `Kept the ${detail.salvagedCount} exclusion(s) that could be recovered; adding or removing exclusions is refused so the damaged file is never overwritten`,
    reason: `The excluded-machines file ${detail.path} is damaged (${detail.reason})`,
    impact:
      'Exclusions that could not be recovered are not applied until the file is repaired. ' +
      (detail.preservedAt
        ? `The damaged file is preserved at ${detail.preservedAt}. `
        : 'No copy of the damaged file could be made; the original is left untouched. ') +
      'Repair: restore a good copy of the file (or rewrite it from the recovered list plus any known drops), then restart the server.',
  });
}

/** The seams RollbackUnmerge needs from the journal/applier (DI'd for testability). */
export interface RollbackUnmergeSeams {
  /** Absolute path to the peers/ replica directory
   *  (`<stateDir>/state/coherence-journal/peers`). */
  peersDir: () => string;
  /** The journal kinds a store rides (so we move every replica stream for it). */
  kindsForStore: (store: string) => string[];
  /** Injected wall clock. */
  now: () => Date;
  /** Drop every snapshot-cache entry for the origin (§7.4 step 2 — the cache leg).
   *  Wired to SnapshotCache.dropOrigin. */
  dropSnapshotCacheForOrigin: (origin: string) => void;
  /** Auto-resolve conflicts referencing the dropped origin (§7.4) — returns the
   *  closed conflictIds. Wired to ConflictStore.autoResolveForDroppedOrigin. */
  autoResolveConflicts: (origin: string) => string[];
  /** Close an attention item for a conflictId (signal-only; idempotent). */
  closeAttention?: (conflictId: string) => void;
  /** Optional fs seams (tests); default node:fs. */
  existsSync?: (p: string) => boolean;
  readdirSync?: (p: string) => string[];
  renameSync?: (from: string, to: string) => void;
  /** Optional structured logger (default no-op). */
  log?: (event: string, detail: Record<string, unknown>) => void;
}

/** Result of an un-merge (§7.4) — auditable. */
export interface UnmergeResult {
  store: string;
  origin: string;
  /** Replica stream files quarantined-aside. */
  movedStreams: number;
  /** Per-peer meta files quarantined-aside. */
  movedMeta: number;
  /** Conflict ids auto-resolved because they referenced the dropped origin. */
  closedConflicts: string[];
  at: string;
}

/**
 * RollbackUnmerge — drops a (store, origin) from the union deterministically
 * (§7.4). The order matters:
 *  1. Register the drop in DroppedOriginRegistry FIRST — the union recomputes
 *     live, so from this instant every read excludes the origin (no dangling refs).
 *  2. Quarantine-aside the replica streams + per-peer meta + snapshot cache
 *     (rename + bounded-retain; reversible, auditable; the prune leg through
 *     SafeFsExecutor).
 *  3. Auto-resolve every conflict that referenced the dropped origin + close its
 *     attention item.
 * Reversible: reMerge() restores the registry entry + the most-recent quarantined
 * streams.
 */
export class RollbackUnmerge {
  private readonly registry: DroppedOriginRegistry;
  private readonly seams: RollbackUnmergeSeams;
  private readonly existsSync: (p: string) => boolean;
  private readonly readdirSync: (p: string) => string[];
  private readonly renameSync: (from: string, to: string) => void;
  private readonly log: (event: string, detail: Record<string, unknown>) => void;

  constructor(registry: DroppedOriginRegistry, seams: RollbackUnmergeSeams) {
    this.registry = registry;
    this.seams = seams;
    this.existsSync = seams.existsSync ?? ((p) => fs.existsSync(p));
    this.readdirSync = seams.readdirSync ?? ((p) => fs.readdirSync(p) as string[]);
    this.renameSync = seams.renameSync ?? ((from, to) => fs.renameSync(from, to));
    this.log = seams.log ?? (() => {});
  }

  /** Un-merge (store, origin) — §7.4. Idempotent: a re-call after the drop is a
   *  no-op for the registry but still re-attempts any leftover quarantine. */
  unmergeOrigin(store: string, origin: string): UnmergeResult {
    const at = this.seams.now().toISOString();
    // (1) Register the drop FIRST — the live union excludes the origin instantly.
    //     A damaged registry applies the exclusion live but throws
    //     DroppedOriginRegistryDamagedError (nothing written, nothing moved).
    this.registry.add(store, origin, at);

    const stamp = this.seams.now().getTime();
    const peers = this.seams.peersDir();
    const safe = sanitizeMachineId(origin);
    let movedStreams = 0;
    let movedMeta = 0;

    if (this.existsSync(peers)) {
      let names: string[] = [];
      try {
        names = this.readdirSync(peers);
      } catch {
        names = [];
      }
      const kinds = new Set(this.seams.kindsForStore(store));
      for (const name of names) {
        // Replica stream for this origin + one of the store's kinds:
        //   <safe>.<kind>.jsonl   (NOT a .quarantine. or numbered-archive file)
        const streamMatch = /^(.+)\.([^.]+)\.jsonl$/.exec(name);
        if (streamMatch && streamMatch[1] === safe && kinds.has(streamMatch[2]) && !name.includes('.quarantine.')) {
          const from = path.join(peers, name);
          const to = path.join(peers, `${name}.unmerge.${stamp}`);
          try {
            this.renameSync(from, to);
            movedStreams++;
          } catch (e) {
            this.log('unmerge-rename-failed', { name, error: (e as Error)?.message });
          }
          continue;
        }
        // Per-peer meta for this origin: <safe>.meta.json
        if (name === `${safe}.meta.json`) {
          const from = path.join(peers, name);
          const to = path.join(peers, `${name}.unmerge.${stamp}`);
          try {
            this.renameSync(from, to);
            movedMeta++;
          } catch (e) {
            this.log('unmerge-meta-rename-failed', { name, error: (e as Error)?.message });
          }
        }
      }
      this.pruneRetained(peers, safe);
    }

    // (2 cont.) drop the snapshot-cache entries for the origin.
    try {
      this.seams.dropSnapshotCacheForOrigin(origin);
    } catch (e) {
      this.log('unmerge-cache-drop-failed', { origin, error: (e as Error)?.message });
    }

    // (3) Auto-resolve conflicts referencing the dropped origin + close attention.
    let closedConflicts: string[] = [];
    try {
      closedConflicts = this.seams.autoResolveConflicts(origin);
      for (const id of closedConflicts) this.seams.closeAttention?.(id);
    } catch (e) {
      this.log('unmerge-conflict-resolve-failed', { origin, error: (e as Error)?.message });
    }

    this.log('unmerge', { store, origin, movedStreams, movedMeta, closedConflicts: closedConflicts.length });
    return { store, origin, movedStreams, movedMeta, closedConflicts, at };
  }

  /** Re-merge (reversibility, §7.4): remove the drop + restore the MOST RECENT
   *  quarantined streams/meta for (store, origin). Returns the count restored. */
  reMerge(store: string, origin: string): { restored: number } {
    // A damaged registry throws here, before any stream is restored.
    this.registry.remove(store, origin);
    const peers = this.seams.peersDir();
    if (!this.existsSync(peers)) return { restored: 0 };
    const safe = sanitizeMachineId(origin);
    let names: string[] = [];
    try {
      names = this.readdirSync(peers);
    } catch {
      return { restored: 0 };
    }
    // Group quarantined files by their base name; restore the newest stamp.
    const re = new RegExp(`^(${escapeRegExp(safe)}\\..+)\\.unmerge\\.(\\d+)$`);
    const byBase = new Map<string, { stamp: number; file: string }>();
    for (const name of names) {
      const m = re.exec(name);
      if (!m) continue;
      const base = m[1];
      const stamp = Number(m[2]);
      const prev = byBase.get(base);
      if (!prev || stamp > prev.stamp) byBase.set(base, { stamp, file: name });
    }
    let restored = 0;
    for (const [base, { file }] of byBase) {
      // Only restore if the live file isn't already present (a re-merge after a
      // fresh tail must not clobber newer data — leave the quarantine as audit).
      const liveTarget = path.join(peers, base);
      if (this.existsSync(liveTarget)) continue;
      try {
        this.renameSync(path.join(peers, file), liveTarget);
        restored++;
      } catch (e) {
        this.log('remerge-restore-failed', { file, error: (e as Error)?.message });
      }
    }
    this.log('remerge', { store, origin, restored });
    return { restored };
  }

  /** Prune retained un-merge sets past MAX_UNMERGE_RETAIN per base (the ONLY
   *  destructive leg — through SafeFsExecutor, audited). */
  private pruneRetained(peers: string, safe: string): void {
    let names: string[] = [];
    try {
      names = this.readdirSync(peers);
    } catch {
      return;
    }
    const re = new RegExp(`^(${escapeRegExp(safe)}\\..+)\\.unmerge\\.(\\d+)$`);
    const byBase = new Map<string, { stamp: number; name: string }[]>();
    for (const name of names) {
      const m = re.exec(name);
      if (!m) continue;
      const base = m[1];
      const arr = byBase.get(base) ?? [];
      arr.push({ stamp: Number(m[2]), name });
      byBase.set(base, arr);
    }
    for (const arr of byBase.values()) {
      if (arr.length <= MAX_UNMERGE_RETAIN) continue;
      arr.sort((a, b) => a.stamp - b.stamp); // oldest first
      const drop = arr.slice(0, arr.length - MAX_UNMERGE_RETAIN);
      for (const d of drop) {
        try {
          SafeFsExecutor.safeRmSync(path.join(peers, d.name), { force: true, operation: 'rollback-unmerge:prune-retained' });
        } catch (e) {
          this.log('unmerge-prune-failed', { name: d.name, error: (e as Error)?.message });
        }
      }
    }
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
