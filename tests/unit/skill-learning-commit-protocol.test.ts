/**
 * CommitProtocol — Tier 1 (Testing Integrity Standard), with the REAL LearnedSkillReconciler and
 * parity rule underneath (no mocks on the write path).
 *
 * Spec: docs/specs/skill-learning-sentinel.md §3.5 tail (the six-step commit protocol and its
 * three-way recovery); integration map brief 2A. Covers: a create/patch through all six steps; the
 * whole-file hash boundary (a description-only edit is an edit); the rendering preflight against the
 * OLD canonical; every fence refusal; a `pending` write that is committed but never rendered; each
 * interruption point of the protocol (prepare only / canonical landed without a version row / landed
 * with the row / a foreign hash) recovered as finish, void or operator-owned lock; a foreign dangling
 * prepare left untouched; the fsync on the prepare row; and half-done moves completed or reversed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { LearnedSkillReconciler, learnedStateOf } from '../../src/monitoring/LearnedSkillReconciler.js';
import { CommitProtocol, completeOrReverseMove, dirIsPartialCopyOf, fileHashOf, withLearnedState, type CommitJournalRow } from '../../src/monitoring/skillLearning/CommitProtocol.js';
import { VersionStore } from '../../src/monitoring/skillLearning/VersionStore.js';
import type { FenceResult } from '../../src/monitoring/skillLearning/WriterFence.js';

const MACHINE = 'm_alpha';
const NAME = 'ci-health-report';

function learned(body: string, opts: { name?: string; state?: string; description?: string; locked?: boolean } = {}): string {
  const name = opts.name ?? NAME;
  return [
    '---',
    `name: ${name}`,
    `description: "${opts.description ?? 'Use when the operator asks for the weekly CI health of the repo.'}"`,
    'metadata:',
    '  instar-learned-origin: "skill-learning-sentinel"',
    `  instar-learned-key: "${name}"`,
    `  instar-learned-state: "${opts.state ?? 'active'}"`,
    ...(opts.locked ? ['  instar-learned-locked: "true"'] : []),
    '---',
    body,
  ].join('\n');
}

/** A scriptable fence: every call answers the next queued result (default: sole-writer ok). */
class FakeFence {
  queue: FenceResult[] = [];
  calls = 0;
  epoch = 3;
  acquireFence(): FenceResult {
    this.calls += 1;
    return this.queue.shift() ?? { ok: true, epoch: this.epoch, fence: 'git' };
  }
  peekEpoch(): number { return this.epoch; }
  medium(): 'git' | 'local' { return 'git'; }
}

interface Rig {
  projectDir: string;
  stateDir: string;
  reconciler: LearnedSkillReconciler;
  versions: VersionStore;
  fence: FakeFence;
  protocol: CommitProtocol;
  canonical: (name?: string) => string;
  rendering: (name?: string) => string;
  journal: () => CommitJournalRow[];
  ops: () => string[];
}

function makeRig(machineId = MACHINE): Rig {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'skills'), { recursive: true });
  const reconciler = new LearnedSkillReconciler({ projectDir, stateDir, machineId, enabledFrameworks: () => ['claude-code'], tickMinutes: 10 });
  const versions = new VersionStore({ stateDir, machineId });
  const fence = new FakeFence();
  const protocol = new CommitProtocol({ projectDir, stateDir, machineId, fence, versions, reconciler });
  const journalPath = path.join(stateDir, 'skill-learning/journal', `${machineId}.jsonl`);
  const journal = (): CommitJournalRow[] => fs.existsSync(journalPath)
    ? fs.readFileSync(journalPath, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as CommitJournalRow).filter((r) => /^(commit|move)/.test(r.op))
    : [];
  return {
    projectDir, stateDir, reconciler, versions, fence, protocol,
    canonical: (name = NAME) => path.join(projectDir, '.instar/skills', name, 'SKILL.md'),
    rendering: (name = NAME) => path.join(projectDir, '.claude/skills', name, 'SKILL.md'),
    journal,
    ops: () => journal().map((r) => r.op),
  };
}

function writeRaw(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('CommitProtocol — write (the six steps)', () => {
  let r: Rig;
  beforeEach(() => { r = makeRig(); });
  afterEach(() => { SafeFsExecutor.safeRmSync(r.projectDir, { recursive: true, force: true, operation: 'tests/unit/skill-learning-commit-protocol.test.ts' }); });

  it('create: prepare (fsync) → fence → hash → preflight → version row + canonical + rendering → commit', async () => {
    const fsync = vi.spyOn(fs, 'fsyncSync');
    const raw = learned('# v1');
    const out = await r.protocol.write('create', NAME, raw, { expectedPrevHash: null, reason: 'floor met' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out).toMatchObject({ version: 1, epoch: 3, fence: 'git', fileHash: fileHashOf(raw) });
    expect(fs.readFileSync(r.canonical(), 'utf-8')).toBe(raw);
    expect(fs.readFileSync(r.rendering(), 'utf-8')).toContain('# v1');
    expect(r.ops()).toEqual(['commit-prepare', 'commit']);
    const prepare = r.journal()[0];
    expect(prepare).toMatchObject({ txId: out.txId, name: NAME, commitOp: 'create', expectedPrevHash: null, newHash: out.fileHash, epoch: 3, fence: 'git', machineId: MACHINE });
    expect(fsync).toHaveBeenCalled(); // the prepare row, the version row and the canonical are all fsync'd
    fsync.mockRestore();
    const last = r.versions.lastRow(NAME);
    expect(last).toMatchObject({ txId: out.txId, version: 1, fileHash: out.fileHash, op: 'create', state: 'active', epoch: 3 });
    expect(last?.bodyHash).toBe(crypto.createHash('sha256').update('# v1').digest('hex'));
    // The reconciler's render rows carry the commit txId, so the two read as one transaction.
    const rendersForTx = fs.readFileSync(path.join(r.stateDir, 'skill-learning/journal', `${MACHINE}.jsonl`), 'utf-8').split('\n').filter((l) => l.includes(`commit:${out.txId}`));
    expect(rendersForTx.length).toBeGreaterThan(0);
  });

  it('patch with the right expectedPrevHash → version 2, rendering follows; the wrong hash is the operator\'s edit → operator-owned, locked, body preserved', async () => {
    const v1 = await r.protocol.write('create', NAME, learned('# v1'), { expectedPrevHash: null });
    expect(v1.ok).toBe(true);
    const v2 = await r.protocol.write('patch', NAME, learned('# v2'), { expectedPrevHash: r.versions.expectedPrevHash(NAME) });
    expect(v2.ok).toBe(true);
    if (!v2.ok) return;
    expect(v2.version).toBe(2);
    expect(fs.readFileSync(r.rendering(), 'utf-8')).toContain('# v2');

    // The operator edits the canonical by hand (a different body).
    const edited = learned('# v2\n\nMy own step.');
    fs.writeFileSync(r.canonical(), edited);
    const v3 = await r.protocol.write('patch', NAME, learned('# v3'), { expectedPrevHash: v2.fileHash });
    expect(v3.ok).toBe(false);
    if (v3.ok) return;
    expect(v3.reason).toBe('user-edit-conflict');
    const onDisk = fs.readFileSync(r.canonical(), 'utf-8');
    expect(onDisk).toContain('My own step.'); // preserved
    expect(onDisk).not.toContain('# v3');
    expect(learnedStateOf(onDisk)).toBe('operator-owned');
    expect(onDisk).toContain('instar-learned-locked: "true"');
    expect(r.versions.lastRow(NAME)).toMatchObject({ op: 'lock', state: 'operator-owned', version: 3 });
    expect(r.ops().slice(-2)).toEqual(['commit-prepare', 'commit-void']);
    // Never rendered over from now on: the reconciler skips operator-owned canonicals.
    const run = await r.reconciler.reconcileAll('tick');
    expect(run.learned).toBe(0);
    expect(fs.readFileSync(r.rendering(), 'utf-8')).toContain('# v2');
  });

  it('hash boundary: a description-only edit (same body) is still an operator edit of the whole file', async () => {
    const v1 = await r.protocol.write('create', NAME, learned('# v1'), { expectedPrevHash: null });
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;
    fs.writeFileSync(r.canonical(), learned('# v1', { description: 'Changed only the description.' }));
    const out = await r.protocol.write('patch', NAME, learned('# v2'), { expectedPrevHash: v1.fileHash });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('user-edit-conflict');
    // Whereas byte-identical content is NOT an edit.
    const r2 = makeRig();
    try {
      const c = await r2.protocol.write('create', NAME, learned('# v1'), { expectedPrevHash: null });
      expect(c.ok).toBe(true);
      fs.writeFileSync(r2.canonical(), learned('# v1')); // rewritten, same bytes
      const p = await r2.protocol.write('patch', NAME, learned('# v2'), { expectedPrevHash: c.ok ? c.fileHash : null });
      expect(p.ok).toBe(true);
    } finally {
      SafeFsExecutor.safeRmSync(r2.projectDir, { recursive: true, force: true, operation: 'tests/unit/skill-learning-commit-protocol.test.ts' });
    }
  });

  it('create over an existing canonical with no version row → unknown-provenance, locked operator-owned', async () => {
    writeRaw(r.canonical(), learned('# someone else wrote this'));
    const out = await r.protocol.write('create', NAME, learned('# v1'), { expectedPrevHash: null });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('unknown-provenance');
    expect(learnedStateOf(fs.readFileSync(r.canonical(), 'utf-8'))).toBe('operator-owned');
    expect(fs.existsSync(r.rendering())).toBe(false);
  });

  it('step 4 preflight: an operator-edited rendering on this machine refuses the write BEFORE the canonical changes', async () => {
    const v1 = await r.protocol.write('create', NAME, learned('# v1'), { expectedPrevHash: null });
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;
    const edited = fs.readFileSync(r.rendering(), 'utf-8') + '\n## Operator note\n';
    fs.writeFileSync(r.rendering(), edited);
    const out = await r.protocol.write('patch', NAME, learned('# v2'), { expectedPrevHash: v1.fileHash });
    expect(out.ok).toBe(false);
    if (!out.ok) { expect(out.reason).toBe('preflight-conflict'); expect(out.detail).toContain('user-edit-conflict'); }
    expect(fs.readFileSync(r.canonical(), 'utf-8')).toBe(learned('# v1')); // untouched
    expect(fs.readFileSync(r.rendering(), 'utf-8')).toBe(edited);          // never overwritten
    expect(r.versions.lastRow(NAME)?.version).toBe(1);                      // no row for the refused write
    expect(r.reconciler.status().lockedConflicts.map((c) => c.skill)).toEqual([NAME]);
    expect(r.ops().slice(-1)).toEqual(['commit-void']);
  });

  it('fence refusals (not-holder / aborted-unreachable / aborted) void the prepare: no canonical, no version row', async () => {
    for (const reason of ['not-holder', 'aborted-unreachable', 'aborted'] as const) {
      r.fence.queue.push({ ok: false, reason, detail: 'scripted' });
      const out = await r.protocol.write('create', NAME, learned('# v1'), { expectedPrevHash: null });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe(reason);
      expect(fs.existsSync(r.canonical())).toBe(false);
      expect(r.versions.rows(NAME)).toEqual([]);
      expect(r.ops().slice(-2)).toEqual(['commit-prepare', 'commit-void']);
      expect(r.journal().slice(-1)[0].detail).toContain(reason);
    }
  });

  it('a `pending` write is committed (canonical + version row) but NOT rendered — by the protocol or a later reconcile', async () => {
    const out = await r.protocol.write('create', NAME, learned('# draft', { state: 'pending' }), { expectedPrevHash: null });
    expect(out.ok).toBe(true);
    expect(fs.existsSync(r.canonical())).toBe(true);
    expect(fs.existsSync(r.rendering())).toBe(false);
    expect(r.versions.lastRow(NAME)?.state).toBe('pending');
    expect(r.journal().slice(-1)[0].detail).toContain('not rendered (pending)');
    const run = await r.reconciler.reconcileAll('tick');
    expect(run.learned).toBe(0);
    expect(fs.existsSync(r.rendering())).toBe(false);
    // The confirm tap writes the same body as `active` through the protocol: now it renders.
    const confirmed = await r.protocol.write('confirm', NAME, learned('# draft', { state: 'active' }), { expectedPrevHash: out.ok ? out.fileHash : null });
    expect(confirmed.ok).toBe(true);
    expect(fs.readFileSync(r.rendering(), 'utf-8')).toContain('# draft');
  });

  it('reject: the proposal-form canonical is ARCHIVED under skill-learning/rejected/<name>/<txId>/ (never deleted), nothing is rendered, and the layout no longer holds it', async () => {
    const pending = await r.protocol.write('create', NAME, learned('# draft', { state: 'pending' }), { expectedPrevHash: null });
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    fs.writeFileSync(path.join(path.dirname(r.canonical()), 'proposal.json'), '{"sidecar":true}');
    const proposalRaw = learned('# draft', { state: 'proposal' });
    const out = await r.protocol.write('reject', NAME, proposalRaw, { expectedPrevHash: pending.fileHash, reason: 'operator reject tap' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(fs.existsSync(path.dirname(r.canonical()))).toBe(false);          // left the layout
    expect(fs.existsSync(r.rendering())).toBe(false);                         // never rendered
    const archive = r.protocol.rejectedDir(NAME, out.txId);
    expect(fs.readFileSync(path.join(archive, 'SKILL.md'), 'utf-8')).toBe(proposalRaw);
    expect(fs.readFileSync(path.join(archive, 'proposal.json'), 'utf-8')).toBe('{"sidecar":true}'); // the whole dir, byte-for-byte
    expect(r.versions.lastRow(NAME)).toMatchObject({ op: 'reject', state: 'proposal', version: 2, fileHash: fileHashOf(proposalRaw) });
    expect(r.ops().slice(-4)).toEqual(['commit-prepare', 'move-prepare', 'move-commit', 'commit']);
    expect(r.journal().slice(-2)[0]).toMatchObject({ txId: `${out.txId}.move`, from: path.dirname(r.canonical()), to: archive });
    expect(r.journal().slice(-1)[0].detail).toContain('not rendered (reject)');
    const run = await r.reconciler.reconcileAll('tick');
    expect(run.learned).toBe(0);
    expect(await r.protocol.recoverOwnJournal()).toMatchObject({ finished: 0, voided: 0, locked: 0, deferred: 0 });
    // A proposal-form canonical that somehow sits in the layout is still never rendered (defensive hold).
    writeRaw(r.canonical('stray-proposal'), learned('# p', { name: 'stray-proposal', state: 'proposal' }));
    expect((await r.reconciler.renderSkill('stray-proposal', 'tx')).notRendered).toBe('proposal');
    expect((await r.reconciler.reconcileAll('tick')).learned).toBe(0);
  });

  it('hash chain (step 3): a confirm must carry the LAST VERSION ROW\'s fileHash — a hand-edited pending canonical confirmed with its on-disk hash is refused and locked; untouched confirms', async () => {
    const pending = await r.protocol.write('create', NAME, learned('# draft', { state: 'pending' }), { expectedPrevHash: null });
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    // The operator hand-edits the pending canonical; a caller then passes the on-disk hash (not the chain's).
    const edited = learned('# draft\n\nhand edit', { state: 'pending' });
    fs.writeFileSync(r.canonical(), edited);
    const refused = await r.protocol.write('confirm', NAME, learned('# draft\n\nhand edit', { state: 'active' }), { expectedPrevHash: fileHashOf(edited) });
    expect(refused.ok).toBe(false);
    if (!refused.ok) { expect(refused.reason).toBe('user-edit-conflict'); expect(refused.detail).toContain('last version row'); }
    const onDisk = fs.readFileSync(r.canonical(), 'utf-8');
    expect(learnedStateOf(onDisk)).toBe('operator-owned');
    expect(onDisk).toContain('hand edit'); // preserved
    expect(fs.existsSync(r.rendering())).toBe(false);
    expect(r.versions.lastRow(NAME)).toMatchObject({ op: 'lock', state: 'operator-owned' });
    // Untouched: the chain hash equals the disk hash and the confirm lands.
    const r2 = makeRig();
    try {
      const p2 = await r2.protocol.write('create', NAME, learned('# draft', { state: 'pending' }), { expectedPrevHash: null });
      if (!p2.ok) throw new Error('setup');
      expect(r2.versions.expectedPrevHash(NAME)).toBe(p2.fileHash);
      const ok = await r2.protocol.write('confirm', NAME, learned('# draft', { state: 'active' }), { expectedPrevHash: r2.versions.expectedPrevHash(NAME) });
      expect(ok.ok).toBe(true);
      expect(fs.readFileSync(r2.rendering(), 'utf-8')).toContain('# draft');
      // A stale chain hash (the row before last) is refused too, even when disk happens to match nothing else.
      const stale = await r2.protocol.write('patch', NAME, learned('# v3'), { expectedPrevHash: p2.fileHash });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.reason).toBe('user-edit-conflict');
    } finally {
      SafeFsExecutor.safeRmSync(r2.projectDir, { recursive: true, force: true, operation: 'tests/unit/skill-learning-commit-protocol.test.ts' });
    }
  });

  it('a HAND-WRITTEN skill holding the name is never touched: write/move/lock refuse unknown-provenance, no journal row, no frontmatter rewrite', async () => {
    const hand = '---\nname: ci-health-report\ndescription: "A skill a person wrote."\n---\n# mine\n';
    writeRaw(r.canonical(), hand);
    const w = await r.protocol.write('patch', NAME, learned('# v2'), { expectedPrevHash: fileHashOf(hand) });
    expect(w).toEqual({ ok: false, reason: 'unknown-provenance', detail: 'hand-written skill holds this name' });
    const c = await r.protocol.write('create', NAME, learned('# v1'), { expectedPrevHash: null });
    expect(c).toEqual({ ok: false, reason: 'unknown-provenance', detail: 'hand-written skill holds this name' });
    const m = await r.protocol.move('retire', NAME, path.dirname(r.canonical()), path.join(r.stateDir, 'skill-learning/retired', NAME));
    expect(m).toEqual({ ok: false, reason: 'unknown-provenance', detail: 'hand-written skill holds this name' });
    expect(fs.readFileSync(r.canonical(), 'utf-8')).toBe(hand);
    expect(r.ops()).toEqual([]);
    expect(r.versions.rows(NAME)).toEqual([]);
    // Recovery over a hand-written name voids the prepare and writes nothing to the file.
    const file = path.join(r.stateDir, 'skill-learning/journal', `${MACHINE}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), machineId: MACHINE, op: 'commit-prepare', txId: 'hw-1', name: NAME, commitOp: 'patch', expectedPrevHash: 'x', newHash: 'y', epoch: 3, fence: 'git' }) + '\n');
    expect(await r.protocol.recoverOwnJournal()).toMatchObject({ voided: 1, locked: 0 });
    expect(fs.readFileSync(r.canonical(), 'utf-8')).toBe(hand);
    expect(r.journal().filter((j) => j.txId === 'hw-1').map((j) => j.op)).toEqual(['commit-prepare', 'commit-void']);
  });

  it('reject reports a surviving rendering of the name as reject-left-rendering (never deletes it)', async () => {
    const pending = await r.protocol.write('create', NAME, learned('# draft', { state: 'pending' }), { expectedPrevHash: null });
    if (!pending.ok) throw new Error('setup');
    writeRaw(r.rendering(), '---\nname: ci-health-report\ndescription: "stale"\n---\n# stale rendering');
    const out = await r.protocol.write('reject', NAME, learned('# draft', { state: 'proposal' }), { expectedPrevHash: pending.fileHash });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.detail).toBe('reject-left-rendering:claude-code');
    expect(fs.existsSync(r.rendering())).toBe(true);
    expect(r.journal().slice(-1)[0].detail).toContain('reject-left-rendering:claude-code');
  });

  it('invalid documents are refused before any journal row', async () => {
    const cases: Array<[string, string, string | null, string]> = [
      ['Bad Name', learned('# x', { name: 'Bad Name' }), null, 'create'],
      [NAME, 'no frontmatter at all', null, 'create'],
      [NAME, learned('# x', { name: 'other-name' }), null, 'create'],
      [NAME, '---\nname: ci-health-report\ndescription: "hand-written"\n---\n# x', null, 'create'],
      [NAME, learned('# x'), 'abc', 'create'],
      [NAME, learned('# x'), null, 'patch'],
      [NAME, learned('<<<<<<< HEAD\n# x\n=======\n# y\n>>>>>>> theirs'), null, 'create'],
    ];
    for (const [name, raw, prev, op] of cases) {
      const out = await r.protocol.write(op as 'create', name, raw, { expectedPrevHash: prev });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe('invalid');
    }
    expect(r.ops()).toEqual([]);
  });

  it('writes are serialized: a second write prepared on a stale hash sees the first one landed', async () => {
    const v1 = await r.protocol.write('create', NAME, learned('# v1'), { expectedPrevHash: null });
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;
    const [a, b] = await Promise.all([
      r.protocol.write('patch', NAME, learned('# a'), { expectedPrevHash: v1.fileHash }),
      r.protocol.write('patch', NAME, learned('# b'), { expectedPrevHash: v1.fileHash }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe('user-edit-conflict');
  });
});

describe('CommitProtocol — recovery of this machine\'s own journal', () => {
  let r: Rig;
  beforeEach(() => { r = makeRig(); });
  afterEach(() => { SafeFsExecutor.safeRmSync(r.projectDir, { recursive: true, force: true, operation: 'tests/unit/skill-learning-commit-protocol.test.ts' }); });

  const prepareRow = (over: Partial<CommitJournalRow>): CommitJournalRow => ({
    ts: new Date().toISOString(), machineId: MACHINE, op: 'commit-prepare', txId: crypto.randomBytes(8).toString('hex'), name: NAME, commitOp: 'patch', expectedPrevHash: null, newHash: null, epoch: 3, fence: 'git', ...over,
  });
  const appendJournal = (row: CommitJournalRow): void => {
    const file = path.join(r.stateDir, 'skill-learning/journal', `${MACHINE}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
  };

  it('nothing dangling → zero counts; a clean journal is idempotent', async () => {
    await r.protocol.write('create', NAME, learned('# v1'), { expectedPrevHash: null });
    expect(await r.protocol.recoverOwnJournal()).toEqual({ finished: 0, voided: 0, locked: 0, foreignDangling: 0, deferred: 0 });
  });

  it('interruption after the prepare only (canonical == expectedPrevHash) → voided; a create whose file never appeared → voided', async () => {
    const v1 = await r.protocol.write('create', NAME, learned('# v1'), { expectedPrevHash: null });
    if (!v1.ok) throw new Error('setup');
    const tx = crypto.randomBytes(8).toString('hex');
    appendJournal(prepareRow({ txId: tx, expectedPrevHash: v1.fileHash, newHash: fileHashOf(learned('# v2')) }));
    appendJournal(prepareRow({ txId: 'create-never-landed', name: 'other-skill', commitOp: 'create', expectedPrevHash: null, newHash: fileHashOf(learned('# o', { name: 'other-skill' })) }));
    const out = await r.protocol.recoverOwnJournal();
    expect(out).toMatchObject({ finished: 0, voided: 2, locked: 0 });
    expect(r.journal().filter((j) => j.txId === tx).map((j) => j.op)).toEqual(['commit-prepare', 'commit-void']);
    expect(fs.readFileSync(r.canonical(), 'utf-8')).toBe(learned('# v1'));
    expect(r.versions.lastRow(NAME)?.version).toBe(1);
    expect(await r.protocol.recoverOwnJournal()).toMatchObject({ voided: 0 }); // closed now
  });

  it('interruption after the canonical landed WITHOUT its version row → the row is appended, the rendering finished, committed', async () => {
    const v1 = await r.protocol.write('create', NAME, learned('# v1'), { expectedPrevHash: null });
    if (!v1.ok) throw new Error('setup');
    const v2raw = learned('# v2');
    const tx = crypto.randomBytes(8).toString('hex');
    appendJournal(prepareRow({ txId: tx, expectedPrevHash: v1.fileHash, newHash: fileHashOf(v2raw) }));
    fs.writeFileSync(r.canonical(), v2raw); // the rename landed, then the process died
    const fenceCallsBefore = r.fence.calls;
    const out = await r.protocol.recoverOwnJournal();
    expect(out).toMatchObject({ finished: 1, voided: 0, locked: 0 });
    expect(r.fence.calls).toBe(fenceCallsBefore + 1); // the fence was re-checked
    expect(r.versions.rowByTxId(NAME, tx)).toMatchObject({ version: 2, fileHash: fileHashOf(v2raw), reason: 'recovered' });
    expect(fs.readFileSync(r.rendering(), 'utf-8')).toContain('# v2');
    expect(r.journal().filter((j) => j.txId === tx).map((j) => j.op)).toEqual(['commit-prepare', 'commit']);
    expect(r.reconciler.status().lockedConflicts).toEqual([]); // never read as an edit
  });

  it('interruption after the version row AND the canonical, before the commit → finished without a duplicate row', async () => {
    const v1 = await r.protocol.write('create', NAME, learned('# v1'), { expectedPrevHash: null });
    if (!v1.ok) throw new Error('setup');
    const v2raw = learned('# v2');
    const tx = crypto.randomBytes(8).toString('hex');
    appendJournal(prepareRow({ txId: tx, expectedPrevHash: v1.fileHash, newHash: fileHashOf(v2raw) }));
    r.versions.append(NAME, { txId: tx, version: 2, fileHash: fileHashOf(v2raw), bodyHash: 'b', epoch: 3, fence: 'git', op: 'patch', state: 'active' });
    fs.writeFileSync(r.canonical(), v2raw);
    const out = await r.protocol.recoverOwnJournal();
    expect(out).toMatchObject({ finished: 1 });
    expect(r.versions.rows(NAME).filter((x) => x.txId === tx)).toHaveLength(1);
    expect(r.versions.lastRow(NAME)?.version).toBe(2);
    expect(fs.readFileSync(r.rendering(), 'utf-8')).toContain('# v2');
  });

  it('the canonical carries a THIRD hash (a newer sync or an operator edit) → preserved, locked operator-owned, the prepare and its row void', async () => {
    const v1 = await r.protocol.write('create', NAME, learned('# v1'), { expectedPrevHash: null });
    if (!v1.ok) throw new Error('setup');
    const tx = crypto.randomBytes(8).toString('hex');
    appendJournal(prepareRow({ txId: tx, expectedPrevHash: v1.fileHash, newHash: fileHashOf(learned('# v2')) }));
    r.versions.append(NAME, { txId: tx, version: 2, fileHash: fileHashOf(learned('# v2')), bodyHash: 'b', epoch: 3, fence: 'git', op: 'patch', state: 'active' });
    const foreign = learned('# v9 from a newer sync');
    fs.writeFileSync(r.canonical(), foreign);
    const out = await r.protocol.recoverOwnJournal();
    expect(out).toMatchObject({ finished: 0, voided: 0, locked: 1 });
    const onDisk = fs.readFileSync(r.canonical(), 'utf-8');
    expect(onDisk).toContain('# v9 from a newer sync');
    expect(learnedStateOf(onDisk)).toBe('operator-owned');
    expect(r.versions.rowByTxId(NAME, tx)?.void).toBe(true);
    expect(r.versions.lastRow(NAME)).toMatchObject({ op: 'lock', state: 'operator-owned' });
    expect(fs.readFileSync(r.rendering(), 'utf-8')).toContain('# v1'); // the old rendering stands; nothing rendered over
    expect(r.journal().filter((j) => j.txId === tx).slice(-1)[0]).toMatchObject({ op: 'commit-void' });
  });

  it('a FOREIGN dangling prepare (another machine\'s, pulled by sync) is counted and never acted on', async () => {
    const v1 = await r.protocol.write('create', NAME, learned('# v1'), { expectedPrevHash: null });
    if (!v1.ok) throw new Error('setup');
    appendJournal(prepareRow({ machineId: 'm_beta', txId: 'beta-tx', expectedPrevHash: v1.fileHash, newHash: fileHashOf(learned('# v2')) }));
    const before = fs.readFileSync(r.canonical(), 'utf-8');
    const out = await r.protocol.recoverOwnJournal();
    expect(out).toMatchObject({ finished: 0, voided: 0, locked: 0, foreignDangling: 1 });
    expect(fs.readFileSync(r.canonical(), 'utf-8')).toBe(before);
    expect(r.journal().filter((j) => j.txId === 'beta-tx')).toHaveLength(1); // no closing row written for it
    expect(learnedStateOf(before)).toBe('active');
  });

  it('a landed canonical whose fence re-check is unreachable is DEFERRED (prepare left open), then finished on the next boot', async () => {
    const v1 = await r.protocol.write('create', NAME, learned('# v1'), { expectedPrevHash: null });
    if (!v1.ok) throw new Error('setup');
    const v2raw = learned('# v2');
    const tx = crypto.randomBytes(8).toString('hex');
    appendJournal(prepareRow({ txId: tx, expectedPrevHash: v1.fileHash, newHash: fileHashOf(v2raw) }));
    fs.writeFileSync(r.canonical(), v2raw);
    r.fence.queue.push({ ok: false, reason: 'aborted-unreachable' });
    expect(await r.protocol.recoverOwnJournal()).toMatchObject({ finished: 0, deferred: 1 });
    expect(r.journal().filter((j) => j.txId === tx)).toHaveLength(1);
    expect(await r.protocol.recoverOwnJournal()).toMatchObject({ finished: 1, deferred: 0 });
  });

  it('reject recovery: proposal-form canonical written but not archived → archived + finished; archive landed → finished; untouched → voided; other hash → locked', async () => {
    const mk = async (): Promise<{ pendingHash: string; proposalRaw: string }> => {
      const pending = await r.protocol.write('create', NAME, learned('# draft', { state: 'pending' }), { expectedPrevHash: null });
      if (!pending.ok) throw new Error('setup');
      return { pendingHash: pending.fileHash, proposalRaw: learned('# draft', { state: 'proposal' }) };
    };
    // (a) written, not archived.
    let { pendingHash, proposalRaw } = await mk();
    appendJournal(prepareRow({ txId: 'rj-a', commitOp: 'reject', expectedPrevHash: pendingHash, newHash: fileHashOf(proposalRaw) }));
    fs.writeFileSync(r.canonical(), proposalRaw);
    expect(await r.protocol.recoverOwnJournal()).toMatchObject({ finished: 1, voided: 0, locked: 0 });
    expect(fs.existsSync(path.dirname(r.canonical()))).toBe(false);
    expect(fs.readFileSync(path.join(r.protocol.rejectedDir(NAME, 'rj-a'), 'SKILL.md'), 'utf-8')).toBe(proposalRaw);
    expect(r.versions.rowByTxId(NAME, 'rj-a')).toMatchObject({ op: 'reject', state: 'proposal', reason: 'recovered' });
    expect(r.journal().filter((j) => j.txId === 'rj-a').map((j) => j.op)).toEqual(['commit-prepare', 'commit']);
    expect(r.journal().filter((j) => j.txId === 'rj-a.move').map((j) => j.op)).toEqual(['move-prepare', 'move-commit']);
    // (b) archive landed, canonical gone, no closing rows.
    ({ pendingHash, proposalRaw } = await mk());
    appendJournal(prepareRow({ txId: 'rj-b', commitOp: 'reject', expectedPrevHash: pendingHash, newHash: fileHashOf(proposalRaw) }));
    fs.writeFileSync(r.canonical(), proposalRaw);
    fs.mkdirSync(path.dirname(r.protocol.rejectedDir(NAME, 'rj-b')), { recursive: true });
    fs.renameSync(path.dirname(r.canonical()), r.protocol.rejectedDir(NAME, 'rj-b'));
    expect(await r.protocol.recoverOwnJournal()).toMatchObject({ finished: 1, voided: 0 });
    expect(r.versions.rowByTxId(NAME, 'rj-b')).toMatchObject({ op: 'reject' });
    // (c) untouched pending canonical → voided; it stays pending (and unrendered).
    ({ pendingHash, proposalRaw } = await mk());
    appendJournal(prepareRow({ txId: 'rj-c', commitOp: 'reject', expectedPrevHash: pendingHash, newHash: fileHashOf(proposalRaw) }));
    expect(await r.protocol.recoverOwnJournal()).toMatchObject({ voided: 1, finished: 0 });
    expect(learnedStateOf(fs.readFileSync(r.canonical(), 'utf-8'))).toBe('pending');
    expect(fs.existsSync(r.rendering())).toBe(false);
    // (d) a third hash → preserved, locked operator-owned.
    appendJournal(prepareRow({ txId: 'rj-d', commitOp: 'reject', expectedPrevHash: pendingHash, newHash: fileHashOf(proposalRaw) }));
    fs.writeFileSync(r.canonical(), learned('# someone changed it', { state: 'pending' }));
    expect(await r.protocol.recoverOwnJournal()).toMatchObject({ locked: 1 });
    expect(learnedStateOf(fs.readFileSync(r.canonical(), 'utf-8'))).toBe('operator-owned');
    expect(fs.existsSync(path.dirname(r.canonical()))).toBe(true);
  });

  it('the prepare row is fsync\'d (openSync/writeSync/fsyncSync), never a bare appendFileSync', async () => {
    const fsync = vi.spyOn(fs, 'fsyncSync');
    const append = vi.spyOn(fs, 'appendFileSync');
    r.fence.queue.push({ ok: false, reason: 'not-holder' }); // stop right after the prepare
    await r.protocol.write('create', NAME, learned('# v1'), { expectedPrevHash: null });
    expect(fsync.mock.calls.length).toBeGreaterThanOrEqual(2); // prepare + void rows
    expect(append).not.toHaveBeenCalled();
    fsync.mockRestore(); append.mockRestore();
  });
});

describe('CommitProtocol — moves (retire / restore) and half-done recovery', () => {
  let r: Rig;
  beforeEach(() => { r = makeRig(); });
  afterEach(() => { SafeFsExecutor.safeRmSync(r.projectDir, { recursive: true, force: true, operation: 'tests/unit/skill-learning-commit-protocol.test.ts' }); });

  const retiredDir = (name = NAME) => path.join(r.stateDir, 'skill-learning/retired', name);
  const canonicalDir = (name = NAME) => path.join(r.projectDir, '.instar/skills', name);

  it('retire moves the canonical dir, journals move-prepare → move-commit, appends a `retire` row; restore moves it back and renders', async () => {
    const v1 = await r.protocol.write('create', NAME, learned('# v1'), { expectedPrevHash: null });
    if (!v1.ok) throw new Error('setup');
    fs.writeFileSync(path.join(canonicalDir(), 'notes.md'), 'bundled');
    const out = await r.protocol.move('retire', NAME, canonicalDir(), retiredDir());
    expect(out.ok).toBe(true);
    expect(fs.existsSync(canonicalDir())).toBe(false);
    expect(fs.readFileSync(path.join(retiredDir(), 'notes.md'), 'utf-8')).toBe('bundled');
    expect(r.ops().slice(-2)).toEqual(['move-prepare', 'move-commit']);
    expect(r.journal().slice(-1)[0]).toMatchObject({ from: canonicalDir(), to: retiredDir(), commitOp: 'retire' });
    expect(r.versions.lastRow(NAME)).toMatchObject({ op: 'retire', state: 'retired', version: 2 });
    const back = await r.protocol.move('restore', NAME, retiredDir(), canonicalDir());
    expect(back.ok).toBe(true);
    expect(fs.existsSync(path.join(canonicalDir(), 'SKILL.md'))).toBe(true);
    expect(r.versions.lastRow(NAME)).toMatchObject({ op: 'restore', version: 3 });
  });

  it('refuses a move whose source is missing or destination exists, and a fence refusal voids the prepare', async () => {
    expect((await r.protocol.move('retire', NAME, canonicalDir(), retiredDir())).ok).toBe(false);
    await r.protocol.write('create', NAME, learned('# v1'), { expectedPrevHash: null });
    fs.mkdirSync(retiredDir(), { recursive: true });
    expect((await r.protocol.move('retire', NAME, canonicalDir(), retiredDir())).ok).toBe(false);
    SafeFsExecutor.safeRmSync(retiredDir(), { recursive: true, force: true, operation: 'tests/unit/skill-learning-commit-protocol.test.ts' });
    r.fence.queue.push({ ok: false, reason: 'not-holder' });
    const out = await r.protocol.move('retire', NAME, canonicalDir(), retiredDir());
    expect(out.ok).toBe(false);
    expect(fs.existsSync(canonicalDir())).toBe(true);
    expect(r.ops().slice(-2)).toEqual(['move-prepare', 'move-void']);
  });

  it('half-done moves are completed or reversed the same way at recovery', async () => {
    await r.protocol.write('create', NAME, learned('# v1'), { expectedPrevHash: null });
    const file = path.join(r.stateDir, 'skill-learning/journal', `${MACHINE}.jsonl`);
    const row = (txId: string, from: string, to: string): string => JSON.stringify({ ts: new Date().toISOString(), machineId: MACHINE, op: 'move-prepare', txId, name: NAME, commitOp: 'retire', from, to, epoch: 3, fence: 'git' }) + '\n';

    // (1) source present, destination absent → reversed (never happened).
    fs.appendFileSync(file, row('mv-1', canonicalDir(), retiredDir()));
    expect(await r.protocol.recoverOwnJournal()).toMatchObject({ voided: 1, finished: 0 });
    expect(fs.existsSync(canonicalDir())).toBe(true);
    expect(r.journal().filter((j) => j.txId === 'mv-1').map((j) => j.op)).toEqual(['move-prepare', 'move-void']);

    // (2) destination complete, source gone → completed.
    fs.mkdirSync(path.dirname(retiredDir()), { recursive: true });
    fs.renameSync(canonicalDir(), retiredDir());
    fs.appendFileSync(file, row('mv-2', canonicalDir(), retiredDir()));
    expect(await r.protocol.recoverOwnJournal()).toMatchObject({ finished: 1 });
    expect(r.journal().filter((j) => j.txId === 'mv-2').slice(-1)[0].op).toBe('move-commit');

    // (3) both present, byte-identical (a cross-fs copy that finished before the source was removed) → completed, source removed.
    fs.cpSync(retiredDir(), canonicalDir(), { recursive: true });
    fs.appendFileSync(file, row('mv-3', canonicalDir(), retiredDir()));
    expect(await r.protocol.recoverOwnJournal()).toMatchObject({ finished: 1 });
    expect(fs.existsSync(canonicalDir())).toBe(false);
    expect(fs.existsSync(retiredDir())).toBe(true);

    // (4) both present, the destination a PARTIAL copy (a byte-identical subset of the source) → reversed: the partial destination is removed.
    fs.renameSync(retiredDir(), canonicalDir());
    fs.writeFileSync(path.join(canonicalDir(), 'notes.md'), 'second file, not yet copied');
    fs.mkdirSync(retiredDir(), { recursive: true });
    fs.copyFileSync(path.join(canonicalDir(), 'SKILL.md'), path.join(retiredDir(), 'SKILL.md'));
    fs.appendFileSync(file, row('mv-4', canonicalDir(), retiredDir()));
    expect(await r.protocol.recoverOwnJournal()).toMatchObject({ voided: 1 });
    expect(fs.existsSync(retiredDir())).toBe(false);
    expect(fs.readFileSync(path.join(canonicalDir(), 'SKILL.md'), 'utf-8')).toContain('# v1');

    // (5) both present, destination holds FOREIGN bytes (not a prefix of the source) → lost, NOTHING removed.
    fs.mkdirSync(retiredDir(), { recursive: true });
    fs.writeFileSync(path.join(retiredDir(), 'SKILL.md'), fs.readFileSync(path.join(canonicalDir(), 'SKILL.md')));
    fs.writeFileSync(path.join(retiredDir(), 'extra.md'), 'not from the source');
    fs.appendFileSync(file, row('mv-5', canonicalDir(), retiredDir()));
    expect(await r.protocol.recoverOwnJournal()).toMatchObject({ deferred: 1 });
    expect(fs.existsSync(path.join(retiredDir(), 'extra.md'))).toBe(true);
    expect(fs.existsSync(canonicalDir())).toBe(true);
    expect(r.journal().filter((j) => j.txId === 'mv-5').map((j) => j.op)).toEqual(['move-prepare']); // still open
    SafeFsExecutor.safeRmSync(retiredDir(), { recursive: true, force: true, operation: 'tests/unit/skill-learning-commit-protocol.test.ts' });
    expect(dirIsPartialCopyOf(canonicalDir(), canonicalDir())).toBe(true);

    // The pure decision function, for the record.
    expect(completeOrReverseMove(path.join(r.projectDir, 'nope-a'), path.join(r.projectDir, 'nope-b'), 'tests/unit/skill-learning-commit-protocol.test.ts')).toBe('lost');
  });
});

describe('withLearnedState', () => {
  it('rewrites only the state/locked keys, preserving every other frontmatter line and the body byte-for-byte', () => {
    const raw = learned('# body\n\nwith two lines\n');
    const out = withLearnedState(raw, 'operator-owned', true);
    expect(out).not.toBeNull();
    expect(out).toContain('instar-learned-state: "operator-owned"');
    expect(out).toContain('instar-learned-locked: "true"');
    expect(out).toContain('instar-learned-origin: "skill-learning-sentinel"');
    expect(out!.split('---\n')[2]).toBe('# body\n\nwith two lines\n');
    expect(learnedStateOf(out!)).toBe('operator-owned');
    // Without a metadata block one is added; without frontmatter → null.
    const bare = withLearnedState('---\nname: x\ndescription: "d"\n---\nbody', 'pending', false);
    expect(bare).toContain('metadata:\n  instar-learned-state: "pending"');
    expect(withLearnedState('no frontmatter', 'active', false)).toBeNull();
  });
});
