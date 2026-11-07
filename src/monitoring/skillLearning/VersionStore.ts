/**
 * VersionStore — per-machine, append-only version rows for learned skills (spec
 * docs/specs/skill-learning-sentinel.md §3.5 step 5, §3.7, and the "Multi-machine posture" rules on
 * epoch ordering, `superseded` and split-brain).
 *
 * Layout: `<stateDir>/skill-learning/versions/<name>/<machineId>.jsonl` — one file per machine, so the
 * hourly git sync never conflicts on a version file. A row is never rewritten: `void` and `superseded`
 * are TOMBSTONE rows (`{ tombstone, ref: <txId> }`) appended by whichever machine decides, and folded in
 * at read time across every machine's file.
 *
 * Ordering across machines is `(epoch, at)` — the lease epoch is the fencing clock, `at` breaks ties
 * inside one epoch. `lastRow(name)` skips void and superseded rows, so the next holder never reads a
 * conflict loser's hash as an operator edit.
 *
 * Post-sync epoch reconciliation (deviation (t): there is no merge-time hook, `.md` conflicts go to the
 * LLM merge): `reconcileAfterSync(name, onDiskFileHash)` compares the canonical's on-disk hash against
 * the rows from every machine and classifies:
 *   - `in-sync`      — on disk is the winner (highest `(epoch, at)` live row);
 *   - `superseded`   — on disk is a LOWER-epoch loser; the loser rows are tombstoned `superseded`, the
 *                      caller restores the winner's body / turns the loser into a proposal;
 *   - `split-brain`  — two machines' latest rows share the max epoch with different bodies (the store
 *                      itself split): fail closed — both bodies become proposals, the skill is
 *                      unrendered, attention item 5 names it. Identical bodies are a benign double-apply;
 *   - `unknown-hash` — on disk matches no row at all (an LLM-merged canonical, or an operator edit that
 *                      arrived through sync): the caller locks `operator-owned`, unrendered, surfaced;
 *   - `no-rows`      — nothing recorded for this skill yet.
 *
 * Slice 2 minimum (brief 2A). Slice 3A extends rows with bodies, citations and revert links.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { CommitOp, LearnedCanonicalState } from './types.js';
import { SKILL_LEARNING_PATHS, SKILL_NAME_RE } from './types.js';

export type VersionOp = CommitOp | 'retire' | 'restore';

export interface VersionRow {
  kind: 'version';
  /** Unique per row; tombstones reference it. Equals the commit-protocol txId when the protocol wrote it. */
  txId: string;
  version: number;
  /** sha256 of the canonical SKILL.md raw bytes (frontmatter + body). */
  fileHash: string;
  /** The parity rule's body hash (sha256 of the body only — the stamp). */
  bodyHash: string;
  epoch: number;
  fence: 'git' | 'local';
  at: string;
  op: VersionOp;
  state: LearnedCanonicalState;
  machineId: string;
  authorFamily?: string;
  reviewerFamily?: string;
  reason?: string;
}

export interface TombstoneRow {
  kind: 'tombstone';
  tombstone: 'void' | 'superseded';
  /** The `txId` of the version row this tombstone applies to. */
  ref: string;
  at: string;
  machineId: string;
  detail?: string;
}

export type VersionFileRow = VersionRow | TombstoneRow;

/** A version row with its tombstones folded in. */
export interface EffectiveVersionRow extends VersionRow {
  void: boolean;
  superseded: boolean;
}

export type SyncReconcileOutcome =
  | { kind: 'no-rows' }
  | { kind: 'in-sync'; winner: EffectiveVersionRow }
  | { kind: 'superseded'; winner: EffectiveVersionRow; loser: EffectiveVersionRow; tombstoned: number }
  | { kind: 'split-brain'; epoch: number; candidates: EffectiveVersionRow[] }
  | { kind: 'unknown-hash'; winner: EffectiveVersionRow; onDiskFileHash: string };

export interface VersionStoreDeps {
  stateDir: string;
  machineId: string;
  now?: () => number;
}

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf-8').digest('hex');
}

/** `(epoch, at)` ascending; a stable tie-break on txId keeps the order deterministic across machines. */
export function compareVersionRows(a: Pick<VersionRow, 'epoch' | 'at' | 'txId'> & { version?: number }, b: Pick<VersionRow, 'epoch' | 'at' | 'txId'> & { version?: number }): number {
  if (a.epoch !== b.epoch) return a.epoch - b.epoch;
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  // Same epoch and the same millisecond (two writes inside one tick, or a frozen clock): the version
  // number is the holder's own sequence, so it decides before the random txId does.
  if (typeof a.version === 'number' && typeof b.version === 'number' && a.version !== b.version) return a.version - b.version;
  return a.txId < b.txId ? -1 : a.txId > b.txId ? 1 : 0;
}

export class VersionStore {
  private readonly stateDir: string;
  private readonly machineId: string;
  private readonly now: () => number;

  constructor(deps: VersionStoreDeps) {
    this.stateDir = deps.stateDir;
    this.machineId = /^[\w.-]{1,96}$/.test(deps.machineId) ? deps.machineId : 'unknown';
    this.now = deps.now ?? (() => Date.now());
  }

  static bodyHashOf(body: string): string {
    return sha256Hex(body);
  }

  dirOf(name: string): string {
    return path.join(this.stateDir, SKILL_LEARNING_PATHS.versionsDir, name);
  }

  /** This machine's own file for a skill. */
  ownFile(name: string): string {
    return path.join(this.dirOf(name), `${this.machineId}.jsonl`);
  }

  // ─── Writes (own file only; fsync'd — a version row is part of the commit protocol's durable state) ───

  append(name: string, row: Omit<VersionRow, 'kind' | 'machineId' | 'at' | 'txId'> & { at?: string; txId?: string }): VersionRow {
    this.assertName(name);
    const full: VersionRow = {
      kind: 'version',
      txId: row.txId ?? crypto.randomBytes(8).toString('hex'),
      version: row.version,
      fileHash: row.fileHash,
      bodyHash: row.bodyHash,
      epoch: row.epoch,
      fence: row.fence,
      at: row.at ?? new Date(this.now()).toISOString(),
      op: row.op,
      state: row.state,
      machineId: this.machineId,
      ...(row.authorFamily ? { authorFamily: row.authorFamily } : {}),
      ...(row.reviewerFamily ? { reviewerFamily: row.reviewerFamily } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
    };
    this.appendRaw(name, full);
    return full;
  }

  markVoid(name: string, txId: string, detail?: string): void {
    this.tombstone(name, 'void', txId, detail);
  }

  markSuperseded(name: string, txId: string, detail?: string): void {
    this.tombstone(name, 'superseded', txId, detail);
  }

  // ─── Reads (every machine's file) ───

  /** Every version row for a skill across machines, tombstones folded in, ordered `(epoch, at)` ascending. */
  rows(name: string): EffectiveVersionRow[] {
    this.assertName(name);
    const dir = this.dirOf(name);
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch { // @silent-fallback-ok — no versions directory yet means no rows
      return [];
    }
    const versions: VersionRow[] = [];
    const voided = new Set<string>();
    const superseded = new Set<string>();
    for (const f of files.sort()) {
      let raw: string;
      try { raw = fs.readFileSync(path.join(dir, f), 'utf-8'); } catch { continue; } // @silent-fallback-ok — a shard that vanished between readdir and read contributes no rows
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let r: unknown;
        try { r = JSON.parse(line); } catch { continue; /* @silent-fallback-ok — a torn tail line is not a row */ }
        if (!r || typeof r !== 'object') continue;
        const row = r as Partial<VersionFileRow>;
        if (row.kind === 'tombstone') {
          const t = row as Partial<TombstoneRow>;
          if (typeof t.ref !== 'string') continue;
          if (t.tombstone === 'void') voided.add(t.ref);
          else if (t.tombstone === 'superseded') superseded.add(t.ref);
          continue;
        }
        if (row.kind !== 'version') continue;
        const v = row as Partial<VersionRow>;
        if (typeof v.txId !== 'string' || typeof v.fileHash !== 'string' || typeof v.at !== 'string' || typeof v.epoch !== 'number' || typeof v.version !== 'number') continue;
        versions.push(v as VersionRow);
      }
    }
    return versions
      .map((v) => ({ ...v, void: voided.has(v.txId), superseded: superseded.has(v.txId) }))
      .sort(compareVersionRows);
  }

  /** The row every write fences against: the highest `(epoch, at)` row that is neither void nor superseded. */
  lastRow(name: string): EffectiveVersionRow | null {
    const live = this.rows(name).filter((r) => !r.void && !r.superseded);
    return live.length === 0 ? null : live[live.length - 1];
  }

  /** The `expectedPrevHash` a write must carry: the last live row's fileHash, or null when the skill has no rows. */
  expectedPrevHash(name: string): string | null {
    return this.lastRow(name)?.fileHash ?? null;
  }

  nextVersion(name: string): number {
    const all = this.rows(name).filter((r) => !r.void);
    return all.reduce((m, r) => Math.max(m, r.version), 0) + 1;
  }

  /** A row by its txId (any machine), tombstones folded in. */
  rowByTxId(name: string, txId: string): EffectiveVersionRow | null {
    return this.rows(name).find((r) => r.txId === txId) ?? null;
  }

  /** The latest live row written by each machine — the inputs to the split-brain check. */
  latestPerMachine(name: string): EffectiveVersionRow[] {
    const byMachine = new Map<string, EffectiveVersionRow>();
    for (const r of this.rows(name)) {
      if (r.void || r.superseded) continue;
      byMachine.set(r.machineId, r); // rows are ascending, so the last write wins
    }
    return [...byMachine.values()].sort(compareVersionRows);
  }

  /** Equal-epoch, different-body latest rows from two machines: the lease store itself split. */
  splitBrain(name: string): { split: true; epoch: number; candidates: EffectiveVersionRow[] } | { split: false } {
    const latest = this.latestPerMachine(name);
    if (latest.length < 2) return { split: false };
    const maxEpoch = latest[latest.length - 1].epoch;
    const atMax = latest.filter((r) => r.epoch === maxEpoch);
    const hashes = new Set(atMax.map((r) => r.fileHash));
    if (atMax.length >= 2 && hashes.size > 1) return { split: true, epoch: maxEpoch, candidates: atMax };
    return { split: false };
  }

  /**
   * Post-sync epoch reconciliation (deviation (t)). Pure classification plus `superseded` tombstones
   * for a lower-epoch loser; the caller performs the body-level consequence (restore the winner,
   * proposal for the loser, lock `operator-owned`, unrender on split-brain).
   */
  reconcileAfterSync(name: string, onDiskFileHash: string | null): SyncReconcileOutcome {
    const split = this.splitBrain(name);
    if (split.split) return { kind: 'split-brain', epoch: split.epoch, candidates: split.candidates };
    const winner = this.lastRow(name);
    if (!winner) return { kind: 'no-rows' };
    if (onDiskFileHash === winner.fileHash) return { kind: 'in-sync', winner };
    const live = this.rows(name).filter((r) => !r.void && !r.superseded);
    const loser = onDiskFileHash === null ? null : live.find((r) => r.fileHash === onDiskFileHash && compareVersionRows(r, winner) < 0 && r.epoch < winner.epoch) ?? null;
    if (loser) {
      // Every live row of the loser's machine at or below its epoch loses with it: the next holder must
      // never read any of those hashes as the operator's edit.
      let tombstoned = 0;
      for (const r of live) {
        if (r.machineId === loser.machineId && r.epoch <= loser.epoch && r.txId !== winner.txId) {
          this.markSuperseded(name, r.txId, `epoch ${r.epoch} lost to epoch ${winner.epoch} (${winner.machineId})`);
          tombstoned += 1;
        }
      }
      return { kind: 'superseded', winner, loser, tombstoned };
    }
    return { kind: 'unknown-hash', winner, onDiskFileHash: onDiskFileHash ?? '' };
  }

  // ─── Internals ───

  private tombstone(name: string, tombstone: TombstoneRow['tombstone'], ref: string, detail?: string): void {
    this.assertName(name);
    const row: TombstoneRow = { kind: 'tombstone', tombstone, ref, at: new Date(this.now()).toISOString(), machineId: this.machineId, ...(detail ? { detail } : {}) };
    this.appendRaw(name, row);
  }

  private appendRaw(name: string, row: VersionFileRow): void {
    const file = this.ownFile(name);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(file, 'a', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(row) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private assertName(name: string): void {
    if (!SKILL_NAME_RE.test(name)) throw new Error(`VersionStore: invalid skill name "${name}"`);
  }
}
