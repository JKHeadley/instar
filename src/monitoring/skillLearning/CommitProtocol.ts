/**
 * CommitProtocol — the six-step commit protocol every learned-skill write passes
 * (spec docs/specs/skill-learning-sentinel.md §3.5 tail, "Commit protocol (every write, including
 * patches, reverts, retire and restore)"; integration map brief 2A, deviations (ee)/(ff)/(jj)).
 *
 *   1. `commit-prepare` row to THIS machine's journal `{ txId, name, op, expectedPrevHash, newHash,
 *      epoch, fence }`, fsync'd (openSync/writeSync/fsyncSync — a torn prepare must never read as a
 *      committed write);
 *   2. the WriterFence: `pullRebase` on git-with-remote media (`fence: local` otherwise), lease epoch
 *      re-read; pull failed → `aborted-unreachable`; stale epoch → `aborted`; lease moved → `not-holder`;
 *   3. the on-disk canonical WHOLE-FILE hash (`fileHash` = sha256 of frontmatter + body — a
 *      description-only edit is still an edit) must equal `expectedPrevHash` (the last live version
 *      row's fileHash); mismatch → the operator edited canonical → locked `operator-owned`, abort;
 *   4. rendering preflight against the OLD canonical through the reconciler (its baseline shard, under
 *      its mutex — deviation (q): the parity rule's `remediate` guard cannot see this); conflict →
 *      the shard holds the lock, abort `preflight-conflict`;
 *   5. version row appended (fsync'd); canonical written temp + rename; renderings through
 *      `reconciler.renderSkill(name, txId)` (the ONE shard writer — the protocol never calls
 *      `remediate` or writes the shard itself);
 *   6. `commit` row.
 *
 * Recovery (`recoverOwnJournal`, boot, BEFORE the reconciler's boot pass) reads THIS machine's journal
 * only. A foreign dangling prepare pulled by sync is counted and reported, never acted on (a standby
 * never writes). Three-way on the canonical's on-disk hash:
 *   - `== newHash`          → the rename landed: re-check the fence, make sure the version row exists,
 *                              finish rendering, `commit`;
 *   - `== expectedPrevHash` → nothing was replaced: `commit-void`, version row tombstoned `void`;
 *   - any other hash        → a newer sync or an operator edit intervened: preserve the file, lock it
 *                              `operator-owned`, surface the conflict (version row `lock`).
 * A `reject` (the operator's tap on a pending skill) is a write whose canonical must LEAVE the layout:
 * after the version row the proposal-form document is written and the whole canonical directory is
 * ARCHIVED to `<stateDir>/skill-learning/rejected/<name>/<txId>/` (never deleted) through a
 * `move-prepare`/`move-commit` pair (txId `<txId>.move`) — nothing is rendered, and `status().pending`
 * no longer sees it because no canonical remains under `.instar/skills/`.
 *
 * Moves (retire/restore) are journaled `move-prepare {from, to}` → `move-commit`; a half-moved directory
 * is completed (destination complete, source gone or byte-identical) or reversed (destination partial)
 * the same way. An interrupted system write is never classified as an operator edit — the journal names it.
 *
 * Journal rows share the reconciler's file (`skill-learning/journal/<machineId>.jsonl`, deviation (ee)):
 * their ops are `commit-*` / `move-*`, their `txId`s are unique, and the reconciler's own recovery
 * ignores them (it acts on `render-prepare` only).
 *
 * Self-action posture: the recovery is a self-triggered controller (one boot pass over the dangling
 * prepares); its convergence argument is registered as `skill-learning-commit-recovery` in
 * src/testing/selfActionRegistry.ts — one action per dangling prepare, then zero.
 */
/* @self-action-controller: skill-learning-commit-recovery */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import yaml from 'js-yaml';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import { isLearnedCanonical, learnedStateOf, hasMergeMarkers, type PreflightResult, type RenderSkillOutcome } from '../LearnedSkillReconciler.js';
import type { FenceResult } from './WriterFence.js';
import type { VersionStore } from './VersionStore.js';
import { SKILL_LEARNING_PATHS, SKILL_NAME_RE, type CommitOp, type CommitProtocolLike, type CommitResult, type LearnedCanonicalState } from './types.js';

export type MoveOp = 'retire' | 'restore';

export interface CommitJournalRow {
  ts: string;
  machineId: string;
  op: 'commit-prepare' | 'commit' | 'commit-void' | 'move-prepare' | 'move-commit' | 'move-void';
  txId: string;
  name: string;
  /** The protocol op this transaction performs. */
  commitOp: CommitOp | MoveOp;
  expectedPrevHash?: string | null;
  newHash?: string | null;
  epoch?: number;
  fence?: 'git' | 'local';
  from?: string;
  to?: string;
  detail?: string;
}

export interface CommitProtocolDeps {
  projectDir: string;
  stateDir: string;
  machineId: string;
  fence: { acquireFence(opts?: { expectedEpoch?: number }): FenceResult; peekEpoch(): number; medium(): 'git' | 'local' };
  versions: VersionStore;
  reconciler: { preflight(name: string): Promise<PreflightResult>; renderSkill(name: string, txId: string): Promise<RenderSkillOutcome> };
  /** Observability hooks (never gates). */
  onConflict?: (event: { name: string; reason: string; detail: string; txId: string }) => void;
  now?: () => number;
  logger?: (message: string) => void;
}

export interface RecoverySummary {
  finished: number;
  voided: number;
  locked: number;
  foreignDangling: number;
  /** Own prepares left open because the fence could not be re-checked (remote unreachable); retried next boot. */
  deferred: number;
}

const CANONICAL_ROOT = '.instar/skills';
const STATE_KEY = 'instar-learned-state';
const LOCKED_KEY = 'instar-learned-locked';
const CLOSING: Record<string, 'commit' | 'move'> = { commit: 'commit', 'commit-void': 'commit', 'move-commit': 'move', 'move-void': 'move' };

export function fileHashOf(raw: string | Buffer): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/** The same frontmatter split the parity rule and the reconciler use. */
function splitFrontmatter(raw: string): { fmRaw: string; fm: Record<string, unknown>; body: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  let fm: unknown;
  try { fm = yaml.load(match[1], { schema: yaml.FAILSAFE_SCHEMA, json: false }); } catch { return null; } // @silent-fallback-ok — unparseable frontmatter is "not a learned document"; every caller refuses on null
  if (fm === null || typeof fm !== 'object' || Array.isArray(fm)) return null;
  return { fmRaw: match[1], fm: fm as Record<string, unknown>, body: match[2] };
}

function writeFileAtomicSync(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    const fd = fs.openSync(tmp, 'w', 0o644);
    try { fs.writeSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, target);
  } catch (err) {
    try { SafeFsExecutor.safeRmSync(tmp, { force: true, operation: 'skill-learning:commit-temp-cleanup' }); } catch { /* @silent-fallback-ok — best-effort temp cleanup after a failed write */ }
    throw err;
  }
}

/**
 * Rewrite ONLY the `metadata.instar-learned-state` / `instar-learned-locked` keys of a canonical,
 * preserving every other byte of frontmatter and the body. Used to lock a file the protocol must
 * preserve (an operator edit, an LLM-merged canonical): the body is theirs; the state is ours.
 */
export function withLearnedState(raw: string, state: LearnedCanonicalState, locked: boolean): string | null {
  const parsed = splitFrontmatter(raw);
  if (!parsed) return null;
  const lines = parsed.fmRaw.split('\n');
  const mdIdx = lines.findIndex((l) => /^metadata:\s*$/.test(l));
  const setKey = (key: string, value: string): void => {
    const re = new RegExp(`^(\\s+)${key.replace(/[-]/g, '\\-')}:\\s*.*$`);
    const i = lines.findIndex((l, idx) => idx > mdIdx && re.test(l));
    if (i >= 0) lines[i] = lines[i].replace(re, `$1${key}: "${value}"`);
    else lines.splice(mdIdx + 1, 0, `  ${key}: "${value}"`);
  };
  if (mdIdx < 0) {
    lines.push('metadata:', `  ${STATE_KEY}: "${state}"`, `  ${LOCKED_KEY}: "${locked ? 'true' : 'false'}"`);
  } else {
    // Insert/replace right under `metadata:` — indentation follows the first child when one exists.
    setKey(STATE_KEY, state);
    setKey(LOCKED_KEY, locked ? 'true' : 'false');
  }
  const bodySep = raw.match(/^---\r?\n[\s\S]*?\r?\n---(\r?\n)?/)?.[1] ?? '\n';
  return `---\n${lines.join('\n')}\n---${bodySep}${parsed.body}`;
}

export class CommitProtocol implements CommitProtocolLike {
  private readonly d: CommitProtocolDeps;
  private readonly machineId: string;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(deps: CommitProtocolDeps) {
    this.d = deps;
    this.machineId = /^[\w.-]{1,96}$/.test(deps.machineId) ? deps.machineId : 'unknown';
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.logger ?? (() => {});
  }

  get journalPath(): string {
    return path.join(this.d.stateDir, SKILL_LEARNING_PATHS.journalDir, `${this.machineId}.jsonl`);
  }

  canonicalPath(name: string): string {
    return path.join(this.d.projectDir, CANONICAL_ROOT, name, 'SKILL.md');
  }

  /** Where a rejected pending skill's canonical directory is archived (never deleted). */
  rejectedDir(name: string, txId: string): string {
    return path.join(this.d.stateDir, SKILL_LEARNING_PATHS.rejectedDir, name, txId);
  }

  /** The on-disk canonical whole-file hash, or null when absent. */
  onDiskHash(name: string): string | null {
    try { return fileHashOf(fs.readFileSync(this.canonicalPath(name))); } catch { return null; } // @silent-fallback-ok — absent reads as null (no canonical), which the three-way treats explicitly
  }

  // ─── write ───────────────────────────────────────────────────────────

  write(op: CommitOp, name: string, newRaw: string, ctx: { expectedPrevHash: string | null; reason?: string; authorFamily?: string; reviewerFamily?: string }): Promise<CommitResult> {
    return this.serial(() => this.writeInner(op, name, newRaw, ctx));
  }

  private async writeInner(op: CommitOp, name: string, newRaw: string, ctx: { expectedPrevHash: string | null; reason?: string; authorFamily?: string; reviewerFamily?: string }): Promise<CommitResult> {
    // ── 0. validation (never journaled: an invalid document is not a transaction)
    if (!SKILL_NAME_RE.test(name)) return { ok: false, reason: 'invalid', detail: `invalid skill name "${name}"` };
    if (typeof newRaw !== 'string' || newRaw.length === 0) return { ok: false, reason: 'invalid', detail: 'empty document' };
    if (hasMergeMarkers(newRaw)) return { ok: false, reason: 'invalid', detail: 'document carries git merge-conflict markers' };
    const parsed = splitFrontmatter(newRaw);
    if (!parsed) return { ok: false, reason: 'invalid', detail: 'document has no parseable YAML frontmatter' };
    if (parsed.fm.name !== name) return { ok: false, reason: 'invalid', detail: `frontmatter name "${String(parsed.fm.name)}" does not match "${name}"` };
    if (typeof parsed.fm.description !== 'string') return { ok: false, reason: 'invalid', detail: 'frontmatter description must be a string' };
    if (!isLearnedCanonical(newRaw)) return { ok: false, reason: 'invalid', detail: 'document is not a learned canonical (metadata.instar-learned-origin missing)' };
    const state = (learnedStateOf(newRaw) ?? 'active') as LearnedCanonicalState;
    const expectedPrevHash = ctx.expectedPrevHash;
    if (op === 'create' && expectedPrevHash !== null) return { ok: false, reason: 'invalid', detail: 'create carries no expectedPrevHash' };
    if (op !== 'create' && expectedPrevHash === null) return { ok: false, reason: 'invalid', detail: `${op} needs the expectedPrevHash of the last version row` };

    // A hand-written skill holding this name is never touched: no journal row, no lock, nothing written.
    const existingRaw = this.readCanonicalRaw(name);
    if (existingRaw !== null && !isLearnedCanonical(existingRaw)) {
      return { ok: false, reason: 'unknown-provenance', detail: 'hand-written skill holds this name' };
    }

    const newHash = fileHashOf(newRaw);
    const txId = crypto.randomBytes(8).toString('hex');
    const preparedEpoch = this.d.fence.peekEpoch();
    const medium = this.d.fence.medium();

    // ── 1. prepare (fsync'd)
    this.journal({ op: 'commit-prepare', txId, name, commitOp: op, expectedPrevHash, newHash, epoch: preparedEpoch, fence: medium, ...(ctx.reason ? { detail: ctx.reason } : {}) });

    // ── 2. fence
    const fence = this.d.fence.acquireFence({ expectedEpoch: preparedEpoch });
    if (!fence.ok) {
      this.journal({ op: 'commit-void', txId, name, commitOp: op, detail: `${fence.reason}: ${fence.detail ?? ''}`.trim() });
      return { ok: false, reason: fence.reason, detail: fence.detail };
    }

    // ── 3. whole-file hash: the caller's expectedPrevHash must be the LAST VERSION ROW's fileHash
    //      (the hash chain — a confirm/reject carrying the on-disk hash of a hand-edited pending
    //      canonical is refused here), AND the on-disk canonical (re-read AFTER the pull) must carry it.
    const afterPullRaw = this.readCanonicalRaw(name);
    if (afterPullRaw !== null && !isLearnedCanonical(afterPullRaw)) {
      const detail = 'hand-written skill holds this name (after the pull)';
      this.journal({ op: 'commit-void', txId, name, commitOp: op, detail: `unknown-provenance: ${detail}` });
      return { ok: false, reason: 'unknown-provenance', detail };
    }
    const onDisk = afterPullRaw === null ? null : fileHashOf(afterPullRaw);
    const lastRow = this.d.versions.lastRow(name);
    const chainHash = lastRow?.fileHash ?? null;
    if (op !== 'create' && expectedPrevHash !== chainHash) {
      const reason = lastRow === null ? 'unknown-provenance' : 'user-edit-conflict';
      const detail = lastRow === null
        ? 'no version row for this skill — its provenance is unknown'
        : `expectedPrevHash ${String(expectedPrevHash).slice(0, 12)}… is not the last version row's ${chainHash!.slice(0, 12)}… — the canonical was edited outside the protocol`;
      if (onDisk !== null) this.lockOperatorOwned(name, txId, fence, `${reason}: ${detail}`);
      this.journal({ op: 'commit-void', txId, name, commitOp: op, detail: `${reason}: ${detail}` });
      this.d.onConflict?.({ name, reason, detail, txId });
      return { ok: false, reason, detail };
    }
    if (onDisk !== expectedPrevHash) {
      const reason = expectedPrevHash === null || lastRow === null ? 'unknown-provenance' : 'user-edit-conflict';
      const detail = onDisk === null
        ? `canonical is missing on disk; the last version row expected ${expectedPrevHash}`
        : expectedPrevHash === null
          ? 'a canonical already exists for a create — provenance unknown'
          : `on-disk canonical hash ${onDisk.slice(0, 12)}… differs from the last version row ${expectedPrevHash.slice(0, 12)}… — the operator edited the canonical`;
      if (onDisk !== null) this.lockOperatorOwned(name, txId, fence, `${reason}: ${detail}`);
      this.journal({ op: 'commit-void', txId, name, commitOp: op, detail: `${reason}: ${detail}` });
      this.d.onConflict?.({ name, reason, detail, txId });
      return { ok: false, reason, detail };
    }

    // ── 4. rendering preflight against the OLD canonical (reconciler shard, under its mutex).
    //      A reject renders nothing (the canonical leaves the layout), so it has no preflight.
    const preflight = op === 'reject' ? { ok: true as const } : await this.d.reconciler.preflight(name);
    if (!preflight.ok) {
      const detail = `${preflight.reason} on ${preflight.target}: ${preflight.detail}`;
      this.journal({ op: 'commit-void', txId, name, commitOp: op, detail: `preflight-conflict: ${detail}` });
      this.d.onConflict?.({ name, reason: 'preflight-conflict', detail, txId });
      return { ok: false, reason: 'preflight-conflict', detail };
    }

    // ── 5. version row, canonical temp + rename, renderings through the reconciler
    const version = this.d.versions.nextVersion(name);
    this.d.versions.append(name, { txId, version, fileHash: newHash, bodyHash: fileHashOf(parsed.body), epoch: fence.epoch, fence: fence.fence, op, state, authorFamily: ctx.authorFamily, reviewerFamily: ctx.reviewerFamily, reason: ctx.reason });
    try {
      writeFileAtomicSync(this.canonicalPath(name), newRaw);
    } catch (err) {
      // The canonical never changed: the prepare is void and so is its version row.
      const detail = `canonical write failed: ${err instanceof Error ? err.message : String(err)}`;
      this.d.versions.markVoid(name, txId, detail);
      this.journal({ op: 'commit-void', txId, name, commitOp: op, detail });
      return { ok: false, reason: 'invalid', detail };
    }
    if (op === 'reject') {
      const archived = this.archiveRejected(name, txId, fence);
      if (!archived.ok) {
        this.d.versions.markVoid(name, txId, archived.detail);
        this.journal({ op: 'commit-void', txId, name, commitOp: op, detail: archived.detail });
        return { ok: false, reason: 'invalid', detail: archived.detail };
      }
      const leftover = this.renderingsOf(name);
      const note = leftover.length ? `; reject-left-rendering:${leftover.join(',')}` : '';
      this.journal({ op: 'commit', txId, name, commitOp: op, newHash, epoch: fence.epoch, fence: fence.fence, detail: `archived to ${path.relative(this.d.stateDir, archived.to)}; not rendered (reject)${note}` });
      return { ok: true, txId, fileHash: newHash, version, epoch: fence.epoch, fence: fence.fence, ...(leftover.length ? { detail: `reject-left-rendering:${leftover.join(',')}` } : {}) };
    }
    const render = await this.renderSafely(name, txId);

    // ── 6. commit
    this.journal({ op: 'commit', txId, name, commitOp: op, newHash, epoch: fence.epoch, fence: fence.fence, detail: render.detail });
    if (render.failed) {
      return { ok: false, reason: 'render-failed', detail: `canonical committed as version ${version} (${newHash.slice(0, 12)}…); ${render.detail}` };
    }
    return { ok: true, txId, fileHash: newHash, version, epoch: fence.epoch, fence: fence.fence };
  }

  // ─── move ────────────────────────────────────────────────────────────

  move(op: MoveOp, name: string, fromAbs: string, toAbs: string): Promise<CommitResult> {
    return this.serial(() => this.moveInner(op, name, fromAbs, toAbs));
  }

  private async moveInner(op: MoveOp, name: string, fromAbs: string, toAbs: string): Promise<CommitResult> {
    if (!SKILL_NAME_RE.test(name)) return { ok: false, reason: 'invalid', detail: `invalid skill name "${name}"` };
    if (!path.isAbsolute(fromAbs) || !path.isAbsolute(toAbs)) return { ok: false, reason: 'invalid', detail: 'move paths must be absolute' };
    if (!fs.existsSync(fromAbs)) return { ok: false, reason: 'invalid', detail: `source does not exist: ${fromAbs}` };
    if (fs.existsSync(toAbs)) return { ok: false, reason: 'invalid', detail: `destination already exists: ${toAbs}` };
    const skillMd = path.join(fromAbs, 'SKILL.md');
    let raw: string;
    try { raw = fs.readFileSync(skillMd, 'utf-8'); } catch { return { ok: false, reason: 'invalid', detail: `no SKILL.md under ${fromAbs}` }; } // @silent-fallback-ok — a missing SKILL.md is the named refusal, nothing is moved
    if (!isLearnedCanonical(raw)) return { ok: false, reason: 'unknown-provenance', detail: 'hand-written skill holds this name' };
    const fileHash = fileHashOf(raw);
    const body = splitFrontmatter(raw)?.body ?? raw;
    const txId = crypto.randomBytes(8).toString('hex');
    const preparedEpoch = this.d.fence.peekEpoch();
    this.journal({ op: 'move-prepare', txId, name, commitOp: op, from: fromAbs, to: toAbs, newHash: fileHash, epoch: preparedEpoch, fence: this.d.fence.medium() });
    const fence = this.d.fence.acquireFence({ expectedEpoch: preparedEpoch });
    if (!fence.ok) {
      this.journal({ op: 'move-void', txId, name, commitOp: op, detail: `${fence.reason}: ${fence.detail ?? ''}`.trim() });
      return { ok: false, reason: fence.reason, detail: fence.detail };
    }
    // The file may have changed during the pull: the move carries what is on disk NOW.
    const afterPull = this.readHash(skillMd);
    if (afterPull !== fileHash) {
      this.journal({ op: 'move-void', txId, name, commitOp: op, detail: `source changed during the pull (${fileHash.slice(0, 12)}… → ${String(afterPull).slice(0, 12)}…)` });
      return { ok: false, reason: 'user-edit-conflict', detail: 'the source changed during the pull; retry' };
    }
    const version = this.d.versions.nextVersion(name);
    const state: LearnedCanonicalState = op === 'retire' ? 'retired' : ((learnedStateOf(raw) ?? 'active') as LearnedCanonicalState);
    this.d.versions.append(name, { txId, version, fileHash, bodyHash: fileHashOf(body), epoch: fence.epoch, fence: fence.fence, op, state });
    try {
      moveDirectory(fromAbs, toAbs, `skill-learning:${op}-move`);
    } catch (err) {
      const detail = `move failed: ${err instanceof Error ? err.message : String(err)}`;
      // Whatever landed is reversed by the same rule recovery applies; the row is void.
      try { completeOrReverseMove(fromAbs, toAbs, `skill-learning:${op}-move-reverse`); } catch { /* @silent-fallback-ok — recovery on the next boot sees the open prepare and finishes the same decision */ }
      this.d.versions.markVoid(name, txId, detail);
      this.journal({ op: 'move-void', txId, name, commitOp: op, detail });
      return { ok: false, reason: 'invalid', detail };
    }
    let detail: string | undefined;
    if (op === 'restore') {
      const r = await this.renderSafely(name, txId);
      detail = r.detail;
    }
    this.journal({ op: 'move-commit', txId, name, commitOp: op, from: fromAbs, to: toAbs, newHash: fileHash, epoch: fence.epoch, fence: fence.fence, ...(detail ? { detail } : {}) });
    return { ok: true, txId, fileHash, version, epoch: fence.epoch, fence: fence.fence };
  }

  // ─── recovery ────────────────────────────────────────────────────────

  recoverOwnJournal(): Promise<RecoverySummary> {
    return this.serial(() => this.recoverInner());
  }

  private async recoverInner(): Promise<RecoverySummary> {
    const out: RecoverySummary = { finished: 0, voided: 0, locked: 0, foreignDangling: 0, deferred: 0 };
    const rows = this.readJournal();
    if (rows.length === 0) return out;
    const closed = new Set<string>();
    for (const r of rows) if (CLOSING[r.op]) closed.add(r.txId);
    const dangling = rows.filter((r) => (r.op === 'commit-prepare' || r.op === 'move-prepare') && !closed.has(r.txId));
    for (const p of dangling) {
      // A reject's recovery closes its own `<txId>.move` prepare as it goes; re-read before acting.
      if (this.readJournal().some((r) => CLOSING[r.op] && r.txId === p.txId)) continue;
      if (p.machineId !== this.machineId) {
        out.foreignDangling += 1;
        this.log(`[CommitProtocol] foreign dangling ${p.op} for ${p.name} from ${p.machineId} (tx ${p.txId}) — reported, never acted on`);
        continue;
      }
      try {
        if (p.op === 'commit-prepare') await this.recoverCommit(p, out);
        else await this.recoverMove(p, out);
      } catch (err) {
        this.log(`[CommitProtocol] recovery of ${p.name} (tx ${p.txId}) failed: ${err instanceof Error ? err.message : String(err)}`);
        out.deferred += 1;
      }
    }
    if (out.finished || out.voided || out.locked || out.foreignDangling || out.deferred) {
      this.log(`[CommitProtocol] journal recovery: ${out.finished} finished, ${out.voided} voided, ${out.locked} locked operator-owned, ${out.deferred} deferred, ${out.foreignDangling} foreign dangling`);
    }
    return out;
  }

  private async recoverCommit(p: CommitJournalRow, out: RecoverySummary): Promise<void> {
    const name = p.name;
    const raw = this.readCanonicalRaw(name);
    if (raw !== null && !isLearnedCanonical(raw)) {
      // A hand-written skill took the name since: the prepare is void and the file is never touched.
      this.d.versions.markVoid(name, p.txId, 'recovered: hand-written skill holds this name');
      this.journal({ op: p.op === 'move-prepare' ? 'move-void' : 'commit-void', txId: p.txId, name, commitOp: p.commitOp, detail: 'recovered: hand-written skill holds this name — nothing written' });
      out.voided += 1;
      return;
    }
    if (p.commitOp === 'reject') return this.recoverReject(p, out);
    const onDisk = this.onDiskHash(name);
    const expectedPrev = p.expectedPrevHash ?? null;
    if (onDisk !== null && onDisk === p.newHash) {
      // The rename landed. Re-check the fence (a remote we cannot reach defers the decision).
      const fence = this.d.fence.acquireFence();
      if (!fence.ok && fence.reason === 'aborted-unreachable') { out.deferred += 1; return; }
      if (!this.d.versions.rowByTxId(name, p.txId)) {
        let raw = '';
        try { raw = fs.readFileSync(this.canonicalPath(name), 'utf-8'); } catch { raw = ''; } // @silent-fallback-ok — the hash was already matched; an unreadable body only empties the row's bodyHash input
        const body = splitFrontmatter(raw)?.body ?? raw;
        this.d.versions.append(name, { txId: p.txId, version: this.d.versions.nextVersion(name), fileHash: p.newHash!, bodyHash: fileHashOf(body), epoch: p.epoch ?? 0, fence: p.fence ?? 'local', op: p.commitOp as CommitOp, state: (learnedStateOf(raw) ?? 'active') as LearnedCanonicalState, reason: 'recovered' });
      }
      const render = await this.renderSafely(name, p.txId);
      const fenceNote = fence.ok ? `fence ${fence.fence}@${fence.epoch}` : `fence ${fence.reason}`;
      this.journal({ op: 'commit', txId: p.txId, name, commitOp: p.commitOp, newHash: p.newHash, epoch: p.epoch, fence: p.fence, detail: `recovered: canonical had landed (${fenceNote}); ${render.detail}` });
      out.finished += 1;
      return;
    }
    if (onDisk === expectedPrev) {
      // Nothing was replaced (a missing file matches a null expectedPrevHash).
      this.d.versions.markVoid(name, p.txId, 'recovered: the canonical was never replaced');
      this.journal({ op: 'commit-void', txId: p.txId, name, commitOp: p.commitOp, detail: 'recovered: canonical unchanged, nothing to finish' });
      out.voided += 1;
      return;
    }
    // Any other hash: a newer sync or an operator edit intervened. Preserve it.
    const detail = onDisk === null
      ? 'recovered: canonical missing where a prepared write expected one'
      : `recovered: on-disk hash ${onDisk.slice(0, 12)}… is neither the prepared ${String(p.newHash).slice(0, 12)}… nor the expected ${String(expectedPrev).slice(0, 12)}… — a newer sync or an operator edit intervened`;
    this.d.versions.markVoid(name, p.txId, detail);
    if (onDisk !== null) this.lockOperatorOwned(name, p.txId, { ok: true, epoch: p.epoch ?? 0, fence: p.fence ?? 'local' }, detail);
    this.journal({ op: 'commit-void', txId: p.txId, name, commitOp: p.commitOp, detail: `operator-owned: ${detail}` });
    this.d.onConflict?.({ name, reason: 'operator-owned', detail, txId: p.txId });
    out.locked += 1;
  }

  /**
   * Three-way for a reject: the archive complete (canonical gone) → finish; the canonical still at the
   * proposal-form hash → fence re-check, archive, finish; untouched → void; any other hash → lock.
   */
  private async recoverReject(p: CommitJournalRow, out: RecoverySummary): Promise<void> {
    const name = p.name;
    const from = path.dirname(this.canonicalPath(name));
    const to = this.rejectedDir(name, p.txId);
    const moveTx = `${p.txId}.move`;
    const close = (detail: string): void => {
      this.journal({ op: 'move-commit', txId: moveTx, name, commitOp: 'reject', from, to, newHash: p.newHash, epoch: p.epoch, fence: p.fence, detail });
      this.journal({ op: 'commit', txId: p.txId, name, commitOp: 'reject', newHash: p.newHash, epoch: p.epoch, fence: p.fence, detail });
    };
    const ensureRow = (): void => {
      if (this.d.versions.rowByTxId(name, p.txId)) return;
      let raw = '';
      try { raw = fs.readFileSync(path.join(to, 'SKILL.md'), 'utf-8'); } catch { raw = ''; } // @silent-fallback-ok — the archive was already verified by hash; an unreadable body only empties the row's bodyHash input
      const body = splitFrontmatter(raw)?.body ?? raw;
      this.d.versions.append(name, { txId: p.txId, version: this.d.versions.nextVersion(name), fileHash: p.newHash ?? fileHashOf(raw), bodyHash: fileHashOf(body), epoch: p.epoch ?? 0, fence: p.fence ?? 'local', op: 'reject', state: 'proposal', reason: 'recovered' });
    };
    if (fs.existsSync(to) && fs.existsSync(from)) {
      // A half-done archive: the same completion/reversal rule as every move.
      const decision = completeOrReverseMove(from, to, 'skill-learning:reject-archive-recovery');
      if (decision === 'completed') { ensureRow(); close('recovered: archive completed'); out.finished += 1; return; }
      if (decision === 'lost') { this.log(`[CommitProtocol] ${name}: archive ${to} holds foreign bytes — left in place, prepare deferred`); out.deferred += 1; return; }
    }
    if (!fs.existsSync(from)) {
      if (fs.existsSync(to) && this.readHash(path.join(to, 'SKILL.md')) === p.newHash) { ensureRow(); close('recovered: archive had landed'); out.finished += 1; return; }
      this.d.versions.markVoid(name, p.txId, 'recovered: canonical and archive both missing');
      this.journal({ op: 'move-void', txId: moveTx, name, commitOp: 'reject', from, to, detail: 'recovered: nothing to archive' });
      this.journal({ op: 'commit-void', txId: p.txId, name, commitOp: 'reject', detail: 'recovered: canonical missing and no archive — nothing to finish' });
      out.voided += 1;
      return;
    }
    const onDisk = this.onDiskHash(name);
    if (onDisk === p.newHash) {
      const fence = this.d.fence.acquireFence();
      if (!fence.ok && fence.reason === 'aborted-unreachable') { out.deferred += 1; return; }
      try { this.journal({ op: 'move-prepare', txId: moveTx, name, commitOp: 'reject', from, to, newHash: p.newHash, epoch: p.epoch, fence: p.fence, detail: 'recovered' }); moveDirectory(from, to, 'skill-learning:reject-archive-recovery'); }
      catch (err) {
        this.journal({ op: 'move-void', txId: moveTx, name, commitOp: 'reject', from, to, detail: `recovered: archive failed: ${err instanceof Error ? err.message : String(err)}` });
        out.deferred += 1;
        return;
      }
      ensureRow();
      close('recovered: proposal-form canonical archived');
      out.finished += 1;
      return;
    }
    if (onDisk === (p.expectedPrevHash ?? null)) {
      this.d.versions.markVoid(name, p.txId, 'recovered: the canonical was never replaced');
      this.journal({ op: 'move-void', txId: moveTx, name, commitOp: 'reject', from, to, detail: 'recovered: nothing archived' });
      this.journal({ op: 'commit-void', txId: p.txId, name, commitOp: 'reject', detail: 'recovered: canonical unchanged, nothing to finish' });
      out.voided += 1;
      return;
    }
    const detail = `recovered: on-disk hash ${String(onDisk).slice(0, 12)}… is neither the prepared ${String(p.newHash).slice(0, 12)}… nor the expected ${String(p.expectedPrevHash).slice(0, 12)}… — a newer sync or an operator edit intervened`;
    this.d.versions.markVoid(name, p.txId, detail);
    this.lockOperatorOwned(name, p.txId, { ok: true, epoch: p.epoch ?? 0, fence: p.fence ?? 'local' }, detail);
    this.journal({ op: 'move-void', txId: moveTx, name, commitOp: 'reject', from, to, detail: 'recovered: canonical preserved, not archived' });
    this.journal({ op: 'commit-void', txId: p.txId, name, commitOp: 'reject', detail: `operator-owned: ${detail}` });
    this.d.onConflict?.({ name, reason: 'operator-owned', detail, txId: p.txId });
    out.locked += 1;
  }

  /** Step 5 of a reject: the proposal-form canonical is written, then the whole directory is archived. */
  private archiveRejected(name: string, txId: string, fence: Extract<FenceResult, { ok: true }>): { ok: true; to: string } | { ok: false; detail: string } {
    const from = path.dirname(this.canonicalPath(name));
    const to = this.rejectedDir(name, txId);
    const moveTx = `${txId}.move`;
    this.journal({ op: 'move-prepare', txId: moveTx, name, commitOp: 'reject', from, to, epoch: fence.epoch, fence: fence.fence });
    try {
      moveDirectory(from, to, 'skill-learning:reject-archive');
    } catch (err) {
      const detail = `archive failed: ${err instanceof Error ? err.message : String(err)}`;
      try { completeOrReverseMove(from, to, 'skill-learning:reject-archive-reverse'); } catch { /* @silent-fallback-ok — recovery on the next boot sees the open prepare and finishes the same decision */ }
      this.journal({ op: 'move-void', txId: moveTx, name, commitOp: 'reject', from, to, detail });
      return { ok: false, detail };
    }
    this.journal({ op: 'move-commit', txId: moveTx, name, commitOp: 'reject', from, to, epoch: fence.epoch, fence: fence.fence });
    return { ok: true, to };
  }

  private async recoverMove(p: CommitJournalRow, out: RecoverySummary): Promise<void> {
    if (!p.from || !p.to) { out.voided += 1; this.journal({ op: 'move-void', txId: p.txId, name: p.name, commitOp: p.commitOp, detail: 'recovered: prepare row carried no paths' }); return; }
    const decision = completeOrReverseMove(p.from, p.to, `skill-learning:${p.commitOp}-move-recovery`);
    if (decision === 'lost' && fs.existsSync(p.from) && fs.existsSync(p.to)) {
      this.log(`[CommitProtocol] ${p.name}: destination ${p.to} holds foreign bytes — left in place, prepare deferred`);
      out.deferred += 1;
      return;
    }
    if (decision === 'completed') {
      if (p.commitOp === 'restore') await this.renderSafely(p.name, p.txId);
      this.journal({ op: 'move-commit', txId: p.txId, name: p.name, commitOp: p.commitOp, from: p.from, to: p.to, newHash: p.newHash, epoch: p.epoch, fence: p.fence, detail: 'recovered: move completed' });
      out.finished += 1;
    } else {
      this.d.versions.markVoid(p.name, p.txId, `recovered: move ${decision}`);
      this.journal({ op: 'move-void', txId: p.txId, name: p.name, commitOp: p.commitOp, detail: `recovered: move ${decision}` });
      out.voided += 1;
    }
  }

  // ─── internals ───────────────────────────────────────────────────────

  /** Lock a canonical the protocol must preserve: state `operator-owned`, locked; a `lock` version row names it. */
  private lockOperatorOwned(name: string, txId: string, fence: Extract<FenceResult, { ok: true }>, detail: string): void {
    const file = this.canonicalPath(name);
    let raw: string;
    try { raw = fs.readFileSync(file, 'utf-8'); } catch { return; } // @silent-fallback-ok — nothing on disk, nothing to lock
    if (!isLearnedCanonical(raw)) { this.log(`[CommitProtocol] ${name}: hand-written skill holds this name — not locked, nothing written`); return; }
    if (learnedStateOf(raw) === 'operator-owned') return; // already locked: idempotent
    const locked = withLearnedState(raw, 'operator-owned', true);
    const written = locked ?? raw; // a file we cannot even re-frame keeps its bytes; the version row still names the lock
    if (locked) {
      try { writeFileAtomicSync(file, locked); } catch (err) { this.log(`[CommitProtocol] could not write operator-owned lock for ${name}: ${err instanceof Error ? err.message : String(err)}`); }
    }
    const body = splitFrontmatter(written)?.body ?? written;
    this.d.versions.append(name, { version: this.d.versions.nextVersion(name), fileHash: fileHashOf(written), bodyHash: fileHashOf(body), epoch: fence.epoch, fence: fence.fence, op: 'lock', state: 'operator-owned', reason: `${detail} (tx ${txId})` });
    this.log(`[CommitProtocol] ${name} locked operator-owned: ${detail}`);
  }

  private async renderSafely(name: string, txId: string): Promise<{ failed: boolean; detail: string }> {
    try {
      const r = await this.d.reconciler.renderSkill(name, txId);
      if (r.notRendered) return { failed: false, detail: `not rendered (${r.notRendered})` };
      const failed = r.failed > 0 || r.errors > 0 || r.conflicts > 0;
      return { failed, detail: `rendered ${r.rendered}, in sync ${r.skipped}, conflicts ${r.conflicts}, failed ${r.failed}, errors ${r.errors}` };
    } catch (err) {
      return { failed: true, detail: `render threw: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private readHash(file: string): string | null {
    try { return fileHashOf(fs.readFileSync(file)); } catch { return null; } // @silent-fallback-ok — absent reads as null, which every caller treats as "no file"
  }

  private readCanonicalRaw(name: string): string | null {
    try { return fs.readFileSync(this.canonicalPath(name), 'utf-8'); } catch { return null; } // @silent-fallback-ok — absent reads as null (no canonical)
  }

  /** The layouts that currently hold a rendering of this name (`.claude/skills`, `.agents/skills`). */
  private renderingsOf(name: string): string[] {
    const out: string[] = [];
    for (const [layout, rel] of [['claude-code', '.claude/skills'], ['codex-cli', '.agents/skills']] as const) {
      if (fs.existsSync(path.join(this.d.projectDir, rel, name, 'SKILL.md'))) out.push(layout);
    }
    return out;
  }

  /** fsync'd append: openSync → writeSync → fsyncSync → closeSync. A prepare that is not on disk is not a transaction. */
  private journal(row: Omit<CommitJournalRow, 'ts' | 'machineId'>): void {
    const full: CommitJournalRow = { ts: new Date(this.now()).toISOString(), machineId: this.machineId, ...row };
    fs.mkdirSync(path.dirname(this.journalPath), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(this.journalPath, 'a', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(full) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private readJournal(): CommitJournalRow[] {
    let raw: string;
    try { raw = fs.readFileSync(this.journalPath, 'utf-8'); } catch { return []; } // @silent-fallback-ok — no journal yet means nothing dangling
    const rows: CommitJournalRow[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as Partial<CommitJournalRow>;
        if (r && typeof r === 'object' && typeof r.op === 'string' && typeof r.txId === 'string' && typeof r.name === 'string' && /^(commit|move)(-prepare|-void|-commit)?$/.test(r.op)) rows.push(r as CommitJournalRow);
      } catch { /* @silent-fallback-ok — a torn tail line is not a transition */ }
    }
    return rows;
  }

  /** Writes, moves and recovery never interleave on one machine. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }
}

// ─── directory moves (deviation (cc): SafeFsExecutor has no move primitive) ───

function copyDirRecursive(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const t = path.join(to, e.name);
    if (e.isDirectory()) copyDirRecursive(s, t);
    else fs.copyFileSync(s, t);
  }
}

/** Every file under `a` exists under `b` with identical bytes (and vice versa). */
export function dirsByteIdentical(a: string, b: string): boolean {
  const list = (root: string): Map<string, string> => {
    const out = new Map<string, string>();
    const walk = (dir: string, rel: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else out.set(r, fileHashOf(fs.readFileSync(path.join(dir, e.name))));
      }
    };
    walk(root, '');
    return out;
  };
  let la: Map<string, string>;
  let lb: Map<string, string>;
  try { la = list(a); lb = list(b); } catch { return false; } // @silent-fallback-ok — an unreadable side is NOT provably identical, so the source is never removed
  if (la.size !== lb.size) return false;
  for (const [k, v] of la) if (lb.get(k) !== v) return false;
  return true;
}

/** rename, or (cross-filesystem) copy → verify bytes → safeRmSync the source under an operation label. */
export function moveDirectory(from: string, to: string, operation: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }
  copyDirRecursive(from, to);
  if (!dirsByteIdentical(from, to)) throw new Error(`cross-filesystem copy of ${from} → ${to} did not verify byte-for-byte`);
  SafeFsExecutor.safeRmSync(from, { recursive: true, force: true, operation });
}

/** Every file under `partial` exists under `full` with identical bytes (a prefix of a copy in flight). */
export function dirIsPartialCopyOf(partial: string, full: string): boolean {
  const walk = (dir: string, rel: string): boolean => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; } // @silent-fallback-ok — an unreadable candidate is NOT provably partial, so it is never removed
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!walk(path.join(dir, e.name), r)) return false; continue; }
      let a: Buffer; let b: Buffer;
      try { a = fs.readFileSync(path.join(dir, e.name)); b = fs.readFileSync(path.join(full, r)); } catch { return false; } // @silent-fallback-ok — a file the source lacks means the candidate is not a copy of it
      if (!a.equals(b)) return false;
    }
    return true;
  };
  return walk(partial, '');
}

/**
 * A half-moved directory is completed or reversed the same way at write-failure and at recovery:
 *   - destination present, source gone                       → completed;
 *   - both present and byte-identical                          → completed (remove the source);
 *   - both present, destination a PARTIAL copy of the source   → reversed (remove the partial destination);
 *   - both present, destination NOT a prefix of the source     → 'lost' (reported; NOTHING removed —
 *                                                                 a destination that holds other bytes is never deleted);
 *   - source present, destination absent                       → reversed (never happened);
 *   - neither present                                          → 'lost' (reported; nothing to do).
 */
export function completeOrReverseMove(from: string, to: string, operation: string): 'completed' | 'reversed' | 'lost' {
  const fromExists = fs.existsSync(from);
  const toExists = fs.existsSync(to);
  if (toExists && !fromExists) return 'completed';
  if (toExists && fromExists) {
    if (dirsByteIdentical(from, to)) {
      SafeFsExecutor.safeRmSync(from, { recursive: true, force: true, operation });
      return 'completed';
    }
    if (dirIsPartialCopyOf(to, from)) {
      SafeFsExecutor.safeRmSync(to, { recursive: true, force: true, operation });
      return 'reversed';
    }
    return 'lost';
  }
  if (fromExists) return 'reversed';
  return 'lost';
}
