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

import fs from 'node:fs';
import path from 'node:path';

import { SafeFsExecutor } from './SafeFsExecutor.js';
import { sanitizeMachineId } from './CoherenceJournal.js';

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

/** The durable set of un-merged (store, origin) pairs. Consulted by the union
 *  reader's participating-namespace filter (§7.4). */
export class DroppedOriginRegistry {
  private readonly stateDir: string;
  private readonly readFileSync: (p: string) => string;
  private readonly existsSync: (p: string) => boolean;
  private doc: DroppedDoc;

  constructor(seams: {
    stateDir: string;
    readFileSync?: (p: string) => string;
    existsSync?: (p: string) => boolean;
  }) {
    this.stateDir = seams.stateDir;
    this.readFileSync = seams.readFileSync ?? ((p) => fs.readFileSync(p, 'utf-8'));
    this.existsSync = seams.existsSync ?? ((p) => fs.existsSync(p));
    this.doc = this.load();
  }

  private docPath(): string {
    return path.join(this.stateDir, 'state', 'state-sync', 'dropped-origins.json');
  }

  private load(): DroppedDoc {
    const p = this.docPath();
    if (!this.existsSync(p)) return { version: 1, dropped: [] };
    try {
      const raw = JSON.parse(this.readFileSync(p)) as Partial<DroppedDoc>;
      const dropped = Array.isArray(raw.dropped)
        ? raw.dropped.filter((d): d is DroppedOriginEntry => !!d && typeof (d as DroppedOriginEntry).store === 'string' && typeof (d as DroppedOriginEntry).origin === 'string')
        : [];
      return { version: 1, dropped };
    } catch {
      // @silent-fallback-ok: a corrupt dropped-origins file degrades to "nothing
      // dropped" — the CONSERVATIVE direction is to FAIL CLOSED (treat a corrupt
      // un-merge ledger as no un-merge ⇒ the origin participates again). That is
      // safe: a stale-but-readable peer namespace re-joining the union is a normal
      // re-merge, never data loss; the operator re-issues the un-merge if needed.
      return { version: 1, dropped: [] };
    }
  }

  private persist(): void {
    SafeFsExecutor.atomicWriteJsonSync(this.docPath(), this.doc, { operation: 'dropped-origin-registry:persist' });
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
    this.persist();
  }

  remove(store: string, origin: string): void {
    const before = this.doc.dropped.length;
    this.doc.dropped = this.doc.dropped.filter((d) => !(d.store === store && d.origin === origin));
    if (this.doc.dropped.length !== before) this.persist();
  }

  list(): DroppedOriginEntry[] {
    return [...this.doc.dropped];
  }
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
