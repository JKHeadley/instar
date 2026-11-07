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
 * Slice 3A (§3.7) extends the store:
 *   - BODIES: `versions/<name>/bodies/<fileHash>.md` holds the raw document of the last `BODY_RETENTION`
 *     (20) versions; older bodies are MOVED (`fs.renameSync`, never deleted) to the content-addressed
 *     `versions/_cas/<fileHash>.md`. `readBody` looks in both, so a revert can always find version N.
 *   - ANNOTATIONS: a version row is never rewritten, so the fields the reviewer/reverter learn AFTER the
 *     commit protocol appended the row (`citedCorrections`, `rejectedBodyHash`, `revertOf`, `uncertainty`,
 *     a `reviewerFamily` the protocol did not carry) are `{ kind: 'annotation', ref: <txId> }` rows folded
 *     in at read time — the same mechanism as tombstones. The protocol stays untouched.
 *   - SCORES: `versionCounts(rows, outcomes)` — the §3.6 per-version count/score from outcome rows whose
 *     `skillUsed.contentHash` (the rendering stamp = the body hash) names a row's body; operator-edited and
 *     version-uncertain uses are excluded (they cannot be attributed to a version).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { CommitOp, LearnedCanonicalState, OutcomeRow } from './types.js';
import { SKILL_LEARNING_PATHS, SKILL_NAME_RE } from './types.js';

/** How many version bodies stay under `versions/<name>/bodies/` before older ones move to `_cas/` (§3.7). */
export const BODY_RETENTION = 20;
/** The content-addressed overflow directory for bodies past the retention window (moved, never deleted). */
export const CAS_DIR = '_cas';

/** The counts the bounded revert recorded on both sides (§3.7 "the uncertainty"). */
export interface VersionUncertainty { nCorrected: number; nRuns: number; prevRate: number | null }

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
  /** Slice 3A, on a `revert` row: hash(N+1) — the body the revert rejected (§3.7). */
  rejectedBodyHash?: string;
  /** Slice 3A: the correction event ids a patch's hunks answered; `[]` on every other row. */
  citedCorrections?: string[];
  /** Slice 3A, on a `revert` row: the txId of the rejected version row (N+1). */
  revertOf?: string;
  /** Slice 3A, on a `revert` row: the trigger's counts on both sides. */
  uncertainty?: VersionUncertainty;
}

/** Slice 3A: the fields an annotation row may add to a version row (folded in at read time; last write wins per field). */
export type VersionAnnotation = Pick<VersionRow, 'rejectedBodyHash' | 'citedCorrections' | 'revertOf' | 'uncertainty' | 'reviewerFamily'>;

export interface AnnotationRow extends VersionAnnotation {
  kind: 'annotation';
  /** The `txId` of the version row this annotation applies to. */
  ref: string;
  at: string;
  machineId: string;
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

export type VersionFileRow = VersionRow | TombstoneRow | AnnotationRow;

/** A version row with its tombstones and annotations folded in. */
export interface EffectiveVersionRow extends VersionRow {
  void: boolean;
  superseded: boolean;
  citedCorrections: string[];
}

/** §3.6 per-version counts over the uses of ONE body. */
export interface VersionCounts {
  uses: number; accepted: number; acceptedInferred: number; corrected: number; unknown: number; weakPositive: number;
  /** Uses whose transcript corroborated the skill call (`skillUsed.corroborated`). */
  corroborated: number;
  /** Corroborated uses with a measured label (accepted / accepted-inferred / corrected / redo) — the bounded revert's "corroborated runs". */
  measuredCorroborated: number;
  /** Corroborated uses labelled corrected / redo. */
  correctedCorroborated: number;
  score: number | null;
}

/** The §3.6 score: `(acc + ½·inf + 1) / (acc + ½·inf + corr + 2)`; null when nothing was measured. */
export function scoreOf(c: Pick<VersionCounts, 'accepted' | 'acceptedInferred' | 'corrected'>): number | null {
  const measured = c.accepted + c.acceptedInferred + c.corrected;
  return measured > 0 ? (c.accepted + 0.5 * c.acceptedInferred + 1) / (c.accepted + 0.5 * c.acceptedInferred + c.corrected + 2) : null;
}

/**
 * Per-version counts for a skill: a use belongs to the row whose `bodyHash` equals the telemetry stamp
 * (`skillUsed.contentHash`). Uses the operator had edited (`operatorEdited`) or that landed while a render
 * was in flight (`versionUncertain`) are attributable to NO version and are left out here (the per-skill
 * read reports them separately). Rows sharing one body (a pending create and its confirm) share the counts:
 * the uses are of the BODY. Keyed by `bodyHash`.
 */
export function versionCounts(name: string, outcomes: ReadonlyArray<OutcomeRow>): Map<string, VersionCounts> {
  const out = new Map<string, VersionCounts>();
  for (const o of outcomes) {
    const u = o.skillUsed;
    if (!u || u.skill !== name || u.operatorEdited || u.versionUncertain) continue;
    if (!/^[a-f0-9]{64}$/.test(u.contentHash)) continue;
    const c = out.get(u.contentHash) ?? { uses: 0, accepted: 0, acceptedInferred: 0, corrected: 0, unknown: 0, weakPositive: 0, corroborated: 0, measuredCorroborated: 0, correctedCorroborated: 0, score: null };
    c.uses++;
    if (u.corroborated) c.corroborated++;
    const measured = o.label === 'accepted' || o.label === 'accepted-inferred' || o.label === 'corrected' || o.label === 'redo';
    if (u.corroborated && measured) c.measuredCorroborated++;
    if (o.label === 'accepted') c.accepted++;
    else if (o.label === 'accepted-inferred') c.acceptedInferred++;
    else if (o.label === 'corrected' || o.label === 'redo') { c.corrected++; if (u.corroborated) c.correctedCorroborated++; }
    else if (o.label === 'weak-positive') c.weakPositive++;
    else c.unknown++;
    c.score = scoreOf(c);
    out.set(u.contentHash, c);
  }
  return out;
}

/** A version the bounded revert rejected: its body hash and the correction set its patch cited (§3.7 refusal keys). */
export interface RejectedVersion { txId: string | null; bodyHash: string; citedCorrections: string[]; revertTxId: string; at: string }

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
      ...(row.rejectedBodyHash ? { rejectedBodyHash: row.rejectedBodyHash } : {}),
      ...(row.citedCorrections?.length ? { citedCorrections: [...row.citedCorrections] } : {}),
      ...(row.revertOf ? { revertOf: row.revertOf } : {}),
      ...(row.uncertainty ? { uncertainty: { ...row.uncertainty } } : {}),
    };
    this.appendRaw(name, full);
    return full;
  }

  /**
   * Slice 3A: attach what was learned about a row AFTER it was appended (the protocol appends the row; the
   * reviewer/reverter know the citations and the revert link). A separate row, folded in by `rows()`.
   */
  annotate(name: string, txId: string, patch: VersionAnnotation): AnnotationRow {
    this.assertName(name);
    const row: AnnotationRow = {
      kind: 'annotation', ref: txId, at: new Date(this.now()).toISOString(), machineId: this.machineId,
      ...(patch.rejectedBodyHash ? { rejectedBodyHash: patch.rejectedBodyHash } : {}),
      ...(patch.citedCorrections ? { citedCorrections: [...patch.citedCorrections] } : {}),
      ...(patch.revertOf ? { revertOf: patch.revertOf } : {}),
      ...(patch.uncertainty ? { uncertainty: { ...patch.uncertainty } } : {}),
      ...(patch.reviewerFamily ? { reviewerFamily: patch.reviewerFamily } : {}),
    };
    this.appendRaw(name, row);
    return row;
  }

  // ─── Bodies (§3.7: the last 20 as files, older content-addressed, never deleted) ───

  bodiesDir(name: string): string {
    return path.join(this.dirOf(name), 'bodies');
  }

  casDir(): string {
    return path.join(this.stateDir, SKILL_LEARNING_PATHS.versionsDir, CAS_DIR);
  }

  bodyPath(name: string, fileHash: string): string {
    this.assertHash(fileHash);
    return path.join(this.bodiesDir(name), `${fileHash}.md`);
  }

  casPath(fileHash: string): string {
    this.assertHash(fileHash);
    return path.join(this.casDir(), `${fileHash}.md`);
  }

  /**
   * Keep a version's raw document (temp + rename, fsync'd), then apply retention: the bodies of the newest
   * `BODY_RETENTION` rows (by `(epoch, at)` across machines) stay; every other body file under `bodies/`
   * is MOVED to `_cas/` (a rename — nothing is ever removed). Idempotent: a body already stored is left alone.
   */
  storeBody(name: string, fileHash: string, raw: string): { stored: boolean; movedToCas: string[] } {
    this.assertName(name);
    const target = this.bodyPath(name, fileHash);
    let stored = false;
    if (!fs.existsSync(target) && !fs.existsSync(this.casPath(fileHash))) {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      const fd = fs.openSync(tmp, 'w', 0o600);
      try { fs.writeSync(fd, raw); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, target);
      stored = true;
    }
    return { stored, movedToCas: this.retainBodies(name) };
  }

  /** Move every body past the retention window to `_cas/`; returns the hashes moved. */
  retainBodies(name: string): string[] {
    const dir = this.bodiesDir(name);
    let files: string[];
    try { files = fs.readdirSync(dir).filter((f) => /^[a-f0-9]{64}\.md$/.test(f)); } catch { return []; } // @silent-fallback-ok — no bodies directory means nothing to retain
    if (files.length <= BODY_RETENTION) return [];
    // Rank by the newest row carrying each hash; a body no row names (torn write) ranks oldest.
    const rank = new Map<string, number>();
    this.rows(name).forEach((r, i) => { if (!r.void) rank.set(r.fileHash, i); });
    const ordered = files
      .map((f) => ({ f, hash: f.slice(0, 64), rank: rank.get(f.slice(0, 64)) ?? -1 }))
      .sort((a, b) => b.rank - a.rank || (a.hash < b.hash ? -1 : 1));
    const moved: string[] = [];
    fs.mkdirSync(this.casDir(), { recursive: true, mode: 0o700 });
    for (const { f, hash } of ordered.slice(BODY_RETENTION)) {
      // Content-addressed: a destination that already exists holds the same bytes; the rename replaces it in place.
      fs.renameSync(path.join(dir, f), this.casPath(hash));
      moved.push(hash);
    }
    return moved;
  }

  /** The raw document of a version by its whole-file hash: the retention window first, then the content-addressed store. */
  readBody(name: string, fileHash: string): string | null {
    this.assertName(name);
    for (const p of [this.bodyPath(name, fileHash), this.casPath(fileHash)]) {
      try { return fs.readFileSync(p, 'utf-8'); } catch { continue; } // @silent-fallback-ok — absent in this location; the next location is tried, null when neither holds it
    }
    return null;
  }

  // ─── Slice 3A reads: reverts and rejected versions ───

  /** Live `revert` rows, ascending. */
  reverts(name: string): EffectiveVersionRow[] {
    return this.rows(name).filter((r) => !r.void && !r.superseded && r.op === 'revert');
  }

  /** Live reverts at or after `sinceMs` (the §3.7 breaker window). */
  revertsSince(name: string, sinceMs: number): EffectiveVersionRow[] {
    return this.reverts(name).filter((r) => { const t = Date.parse(r.at); return Number.isFinite(t) && t >= sinceMs; });
  }

  /** The versions reverts have rejected: the refusal keys for a later patch (body hash OR cited-correction set). */
  rejectedVersions(name: string): RejectedVersion[] {
    const rows = this.rows(name);
    const out: RejectedVersion[] = [];
    for (const rv of rows) {
      if (rv.void || rv.op !== 'revert') continue;
      const target = rv.revertOf ? rows.find((r) => r.txId === rv.revertOf) ?? null : null;
      // The annotation names the rejected hash; without it, the live row right before the revert is N+1.
      const before = target ?? [...rows].reverse().find((r) => !r.void && !r.superseded && compareVersionRows(r, rv) < 0 && r.bodyHash !== rv.bodyHash) ?? null;
      const bodyHash = rv.rejectedBodyHash ?? before?.bodyHash ?? null;
      if (!bodyHash) continue;
      out.push({ txId: before?.txId ?? null, bodyHash, citedCorrections: before?.citedCorrections ?? [], revertTxId: rv.txId, at: rv.at });
    }
    return out;
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
    const annotations = new Map<string, AnnotationRow[]>();
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
        if (row.kind === 'annotation') {
          const a = row as Partial<AnnotationRow>;
          if (typeof a.ref !== 'string' || typeof a.at !== 'string') continue;
          const list = annotations.get(a.ref) ?? [];
          list.push(a as AnnotationRow);
          annotations.set(a.ref, list);
          continue;
        }
        if (row.kind !== 'version') continue;
        const v = row as Partial<VersionRow>;
        if (typeof v.txId !== 'string' || typeof v.fileHash !== 'string' || typeof v.at !== 'string' || typeof v.epoch !== 'number' || typeof v.version !== 'number') continue;
        versions.push(v as VersionRow);
      }
    }
    return versions
      .map((v): EffectiveVersionRow => {
        const folded: EffectiveVersionRow = { ...v, void: voided.has(v.txId), superseded: superseded.has(v.txId), citedCorrections: v.citedCorrections ? [...v.citedCorrections] : [] };
        for (const a of (annotations.get(v.txId) ?? []).sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0))) {
          if (a.rejectedBodyHash) folded.rejectedBodyHash = a.rejectedBodyHash;
          if (Array.isArray(a.citedCorrections)) folded.citedCorrections = a.citedCorrections.filter((c): c is string => typeof c === 'string');
          if (a.revertOf) folded.revertOf = a.revertOf;
          if (a.uncertainty && typeof a.uncertainty === 'object') folded.uncertainty = { ...a.uncertainty };
          if (a.reviewerFamily) folded.reviewerFamily = a.reviewerFamily;
        }
        return folded;
      })
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

  private assertHash(fileHash: string): void {
    if (!/^[a-f0-9]{64}$/.test(fileHash)) throw new Error(`VersionStore: invalid file hash "${String(fileHash).slice(0, 20)}"`);
  }
}
