// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup and as the injected remove seam.
/**
 * Retirer — Tier 1, slice 3B (docs/specs/skill-learning-sentinel.md §3.8 "Retire, never delete; never merge; lock is
 * not immunity"): the REAL CommitProtocol + VersionStore + LearnedSkillReconciler over a temp agent home (granting
 * fence), the Retirer bound into the reconciler the way wire.ts binds it, and the REAL sentinel for "reported active".
 *
 *  - archive before removal: a failure injected between the copy and the removal leaves the archive AND the
 *    rendering intact, reported `retire-blocked`; the next pass finishes the removal;
 *  - an operator-edited rendering is archived byte-for-byte; unrelated orphan dirs are never touched;
 *  - a rename failure takes the copy → verify → safeRmSync path; a total failure is `retire-blocked` and the
 *    sentinel reports the skill ACTIVE (never silently gone);
 *  - floors: a score retire is refused at 2 corroborated runs and allowed at 3; misfire 1 vs 2; the unused
 *    silence floor at 3 × windowDays ± 1 day; the static defaults act only when the reviewer is unavailable and
 *    `retire-arbiter-vs-default` is logged when it answered;
 *  - a locked skill is never patched but IS retirable for harm; a retire for harm posts a learning;
 *  - restore re-lints and re-reviews with a family ≠ the retired author, lands `pending`, counters reset;
 *  - a half-moved rendering archive recovers both directions through the protocol's own journal recovery;
 *  - retire-all writes the audit row + the durable record and holds the sentinel's drafting;
 *  - lock retraction archives a leftover rendering on the tick and clears `lockLeftRendering`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { LearnedSkillReconciler } from '../../src/monitoring/LearnedSkillReconciler.js';
import { CommitProtocol, fileHashOf } from '../../src/monitoring/skillLearning/CommitProtocol.js';
import { VersionStore } from '../../src/monitoring/skillLearning/VersionStore.js';
import { Retirer, patchMetadata, parseRetireReviewOutput, buildRetireReviewPrompt, type RetireCandidate, type RetireReviewer, type RestoreReviewer } from '../../src/monitoring/skillLearning/Retirer.js';
import { SkillLearningSentinel } from '../../src/monitoring/SkillLearningSentinel.js';
import { SKILL_LEARNING_DEFAULTS } from '../../src/config/ConfigDefaults.js';
import type { FenceResult } from '../../src/monitoring/skillLearning/WriterFence.js';
import type { FamilyProvider } from '../../src/monitoring/skillLearning/Drafter.js';
import type { SkillLearningConfig } from '../../src/monitoring/skillLearning/types.js';
import { FakeLedger, NOW, DAY, mkHome, cleanupHomes, seedHistory, fam, responder, harness } from '../helpers/skillLearningLiveFixtures.js';

const NAME = 'ci-health-report';
const TMP = process.env.TMPDIR ?? os.tmpdir();
const homes: string[] = [];
afterEach(() => { cleanupHomes(); for (const d of homes.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/skill-learning-retirer.test.ts' }); });

function canonicalDoc(state: 'pending' | 'active' | 'operator-owned', body = '# CI health report\n\n1. Read the CI health route at /ci/health.\n2. Summarise failing jobs in plain language.\n', name = NAME): string {
  return [
    '---', `name: ${name}`,
    'description: "Use when the operator asks for the weekly CI health of the instar repo. Not for deploy status."',
    'metadata:', '  short-description: "CI health, weekly"', '  instar-learned-origin: "skill-learning-sentinel"', '  instar-learned-key: "ci-health"',
    '  instar-learned-version: "1"', '  instar-learned-created: "2026-10-01T11:00:00Z"', `  instar-learned-locked: "${state === 'operator-owned' ? 'true' : 'false'}"`, `  instar-learned-state: "${state}"`,
    '---', body,
  ].join('\n');
}

function grantingFence() {
  return { acquireFence: (): FenceResult => ({ ok: true, epoch: 0, fence: 'local' }), peekEpoch: () => 0, medium: () => 'local' as const };
}

interface Home {
  root: string; stateDir: string; machineId: string; reconciler: LearnedSkillReconciler; versions: VersionStore; protocol: CommitProtocol;
  retirer: Retirer; log: Array<Record<string, unknown>>; learnings: unknown[]; seams: { rename: ReturnType<typeof vi.fn>; removeDir: ReturnType<typeof vi.fn> }; clock: { now: number };
}

function cfg(over: Partial<SkillLearningConfig> = {}): SkillLearningConfig {
  return { ...(structuredClone(SKILL_LEARNING_DEFAULTS) as unknown as SkillLearningConfig), enabled: true, ...over };
}

function home(opts: { machineId?: string; reviewer?: RetireReviewer | null; restoreReviewer?: RestoreReviewer | null; config?: SkillLearningConfig } = {}): Home {
  const root = fs.mkdtempSync(path.join(TMP, 'sl-retire-'));
  homes.push(root);
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'skills', 'orphan-by-hand'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'skills', 'orphan-by-hand', 'SKILL.md'), '---\nname: orphan-by-hand\ndescription: "Hand-written, no canonical."\n---\nbody\n');
  const machineId = opts.machineId ?? 'm1';
  const clock = { now: NOW };
  const now = () => clock.now;
  const reconciler = new LearnedSkillReconciler({ projectDir: root, stateDir, machineId, enabledFrameworks: () => ['claude-code', 'codex-cli'], now });
  const versions = new VersionStore({ stateDir, machineId, now });
  const protocol = new CommitProtocol({ projectDir: root, stateDir, machineId, fence: grantingFence(), versions, reconciler, now });
  const log: Array<Record<string, unknown>> = [];
  const learnings: unknown[] = [];
  const seams = { rename: vi.fn((from: string, to: string) => fs.renameSync(from, to)), removeDir: vi.fn((dir: string, operation: string) => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation })) };
  const retirer = new Retirer({
    projectDir: root, stateDir, machineId, config: opts.config ?? cfg(), commitProtocol: protocol, versions,
    reviewer: opts.reviewer ?? null, restoreReviewer: opts.restoreReviewer ?? null,
    addLearning: (l) => { learnings.push(l); return l; },
    existingSkills: () => [{ name: 'orphan-by-hand', description: 'Hand-written, no canonical.', learned: false }],
    appendLog: (row) => log.push(row), forgetRenderings: (rels) => reconciler.forgetRenderings(rels),
    rename: (f, t) => seams.rename(f, t), removeDir: (d, op) => seams.removeDir(d, op), now,
  });
  reconciler.setRetirer(retirer);
  return { root, stateDir, machineId, reconciler, versions, protocol, retirer, log, learnings, seams, clock };
}

const rendering = (h: Home, layout: '.claude' | '.agents', name = NAME) => path.join(h.root, layout, 'skills', name, 'SKILL.md');
const archiveOf = (h: Home, layout: 'claude' | 'agents', name = NAME) => path.join(h.stateDir, 'skill-learning', 'retired', name, 'renderings', h.machineId, layout);
const canonical = (h: Home, name = NAME) => path.join(h.root, '.instar', 'skills', name, 'SKILL.md');
const retiredCanonical = (h: Home, name = NAME) => path.join(h.stateDir, 'skill-learning', 'retired', name, 'SKILL.md');
const readIf = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null);
const journal = (h: Home) => fs.readFileSync(path.join(h.stateDir, 'skill-learning', 'journal', `${h.machineId}.jsonl`), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

/** A live, rendered learned skill (create through the real protocol → both layouts rendered). */
async function liveSkill(h: Home, state: 'active' | 'operator-owned' = 'active', name = NAME): Promise<void> {
  const res = await h.protocol.write('create', name, canonicalDoc('active', undefined, name), { expectedPrevHash: null, authorFamily: 'anthropic' });
  expect(res.ok).toBe(true);
  expect(readIf(rendering(h, '.claude', name))).not.toBeNull();
  if (state === 'operator-owned') {
    const locked = canonicalDoc('operator-owned', undefined, name);
    const r2 = await h.protocol.write('lock', name, locked, { expectedPrevHash: fileHashOf(canonicalDoc('active', undefined, name)) });
    expect(r2.ok).toBe(true);
    expect(readIf(rendering(h, '.claude', name))).not.toBeNull(); // the lock retracts nothing by itself
  }
}

function candidate(over: Partial<RetireCandidate> = {}): RetireCandidate {
  return {
    name: NAME, state: 'active', locked: false, version: 1, key: 'ci-health', authorFamily: 'anthropic', score: 0.2, corroboratedRuns: 3, correctedRuns: 2, uses: 3, misfires: 0,
    lastUsedAt: new Date(NOW - DAY).toISOString(), lastRequestAt: new Date(NOW - DAY).toISOString(), requestsWithoutUse: 0, occurrencesInWindow: 3,
    countersSince: '2026-10-01T11:00:00Z', indexBytes: 120, sessionsPerWeek: 20, ...over,
  };
}

// ── the every-machine side: archive first ──────────────────────────────────

describe('archive first (every machine)', () => {
  it('a retired skill’s renderings leave both layouts byte-for-byte into retired/<name>/renderings/<machine>/{claude,agents}; the hand-written orphan beside them is untouched', async () => {
    const h = home();
    await liveSkill(h);
    const claudeBytes = fs.readFileSync(rendering(h, '.claude'));
    const r = await h.retirer.retire(NAME, { kind: 'operator', reason: 'test', harm: false, by: 'operator' });
    expect(r).toMatchObject({ ok: true, version: 2 });
    expect(readIf(canonical(h))).toBeNull();
    expect(readIf(retiredCanonical(h))).toMatch(/instar-learned-state: "retired"/);
    expect(readIf(retiredCanonical(h))).toContain('instar-learned-retire-reason: "test"');
    expect(readIf(rendering(h, '.claude'))).toBeNull();
    expect(readIf(rendering(h, '.agents'))).toBeNull();
    expect(fs.readFileSync(path.join(archiveOf(h, 'claude'), 'SKILL.md')).equals(claudeBytes)).toBe(true);
    expect(fs.existsSync(path.join(archiveOf(h, 'agents'), 'agents', 'openai.yaml'))).toBe(true);
    expect(readIf(path.join(h.root, '.claude', 'skills', 'orphan-by-hand', 'SKILL.md'))).toContain('Hand-written');
    const side = JSON.parse(fs.readFileSync(path.join(h.stateDir, 'skill-learning', 'retired', NAME, 'retired.json'), 'utf-8'));
    expect(side).toMatchObject({ name: NAME, kind: 'operator', harm: false, by: 'operator', version: 2, authorFamily: 'anthropic', machineId: 'm1' });
    expect(h.versions.lastRow(NAME)).toMatchObject({ op: 'retire', state: 'retired', version: 2 });
    // The archive moves are journaled with the protocol's row shape, prepare → commit.
    const rows = journal(h).filter((x) => String(x.detail ?? '').startsWith('archive-rendering:'));
    expect(rows.map((x) => x.op)).toEqual(['move-prepare', 'move-commit', 'move-prepare', 'move-commit']);
    expect(h.retirer.listRetired()).toMatchObject([{ name: NAME, kind: 'operator', renderingsArchived: { m1: ['agents', 'claude'] }, archiveDir: `skill-learning/retired/${NAME}` }]);
    expect(h.learnings).toEqual([]); // not harm → no learning
  });

  it('a rendering the operator EDITED is archived byte-for-byte, edit included', async () => {
    const h = home();
    await liveSkill(h);
    const edited = `${fs.readFileSync(rendering(h, '.claude'), 'utf-8')}\n3. My own extra step.\n`;
    fs.writeFileSync(rendering(h, '.claude'), edited);
    await h.retirer.retire(NAME, { kind: 'operator', reason: 'test', harm: false, by: 'operator' });
    expect(readIf(path.join(archiveOf(h, 'claude'), 'SKILL.md'))).toBe(edited);
    expect(readIf(rendering(h, '.claude'))).toBeNull();
  });

  it('on another machine: the sync-pulled retired canonical makes the tick archive the local rendering FIRST (no canonical, no removal path other than the archive)', async () => {
    const a = home({ machineId: 'A' });
    await liveSkill(a);
    const b = home({ machineId: 'B' });
    await liveSkill(b);
    // "Sync": B receives A's retired dir and loses its canonical; B's renderings stay (they never sync).
    await a.retirer.retire(NAME, { kind: 'operator', reason: 'test', harm: false, by: 'operator' });
    fs.cpSync(path.join(a.stateDir, 'skill-learning', 'retired'), path.join(b.stateDir, 'skill-learning', 'retired'), { recursive: true });
    SafeFsExecutor.safeRmSync(path.dirname(canonical(b)), { recursive: true, force: true, operation: 'tests/unit/skill-learning-retirer.test.ts:sync' });
    const before = fs.readFileSync(rendering(b, '.claude'));
    const tick = await b.reconciler.reconcileAll('tick');
    expect(tick.retireArchived).toBe(2);
    expect(tick.retireBlocked).toBe(0);
    expect(readIf(rendering(b, '.claude'))).toBeNull();
    expect(fs.readFileSync(path.join(archiveOf(b, 'claude'), 'SKILL.md')).equals(before)).toBe(true);
    expect(fs.existsSync(archiveOf(a, 'claude'))).toBe(true); // A's own archive is a sibling, untouched
    expect(b.retirer.listRetired()[0].renderingsArchived).toEqual({ A: ['agents', 'claude'], B: ['agents', 'claude'] });
    // Settled: a second tick does nothing.
    const again = await b.reconciler.reconcileAll('tick');
    expect(again.retireArchived).toBe(0);
    expect(b.reconciler.status().retireBlocked).toEqual([]);
    // The reconciler forgot the baselines of the renderings that left.
    const shard = JSON.parse(fs.readFileSync(path.join(b.stateDir, 'skill-learning', 'rendered-baselines', 'B.json'), 'utf-8'));
    expect(Object.keys(shard.baselines)).toEqual([]);
  });

  it('a rendering with no learned marker (a hand-written skill that took the name) is never moved; it is reported blocked by name', async () => {
    const h = home();
    await liveSkill(h);
    await h.retirer.retire(NAME, { kind: 'operator', reason: 'test', harm: false, by: 'operator' });
    fs.mkdirSync(path.dirname(rendering(h, '.claude')), { recursive: true });
    fs.writeFileSync(rendering(h, '.claude'), '---\nname: ci-health-report\ndescription: "The operator wrote this one by hand after the retire."\n---\nmine\n');
    const sweep = h.retirer.reconcileRetiredRenderings();
    expect(sweep.archived).toEqual([]);
    expect(sweep.blocked).toMatchObject([{ name: NAME, layout: 'claude', reason: 'no-learned-marker' }]);
    expect(readIf(rendering(h, '.claude'))).toContain('by hand');
  });
});

describe('the move primitives: rename → copy/verify/remove → blocked', () => {
  it('a rename failure takes the copy → verify → safeRmSync path (source gone, archive identical, via "copy")', async () => {
    const h = home();
    await liveSkill(h);
    h.seams.rename.mockImplementation(() => { throw new Error('EXDEV: cross-device link not permitted'); });
    const bytes = fs.readFileSync(rendering(h, '.claude'));
    const r = await h.retirer.retire(NAME, { kind: 'operator', reason: 'test', harm: false, by: 'operator' });
    expect(r.ok).toBe(true);
    expect((r as { archived: Array<{ via: string }> }).archived.map((a) => a.via)).toEqual(['copy', 'copy']);
    expect(readIf(rendering(h, '.claude'))).toBeNull();
    expect(fs.readFileSync(path.join(archiveOf(h, 'claude'), 'SKILL.md')).equals(bytes)).toBe(true);
    expect(h.seams.removeDir).toHaveBeenCalledWith(path.dirname(rendering(h, '.claude')), 'skill-learning:retire-rendering');
  });

  it('archive BEFORE removal: a failure injected between the copy and the removal leaves the archive AND the rendering intact, reported retire-blocked; the next pass finishes the removal', async () => {
    const h = home();
    await liveSkill(h);
    h.seams.rename.mockImplementation(() => { throw new Error('rename refused'); });
    h.seams.removeDir.mockImplementation((dir: string) => { if (dir.includes('.claude')) throw new Error('EACCES: removal refused'); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/skill-learning-retirer.test.ts' }); });
    const bytes = fs.readFileSync(rendering(h, '.claude'));
    const r = await h.retirer.retire(NAME, { kind: 'operator', reason: 'test', harm: false, by: 'operator' });
    expect(r.ok).toBe(true);
    const blocked = (r as { blocked: Array<{ layout: string; reason: string }> }).blocked;
    expect(blocked).toMatchObject([{ layout: 'claude' }]);
    expect(blocked[0].reason).toMatch(/^archived, remove-failed/);
    expect(fs.readFileSync(rendering(h, '.claude')).equals(bytes)).toBe(true);                          // rendering intact
    expect(fs.readFileSync(path.join(archiveOf(h, 'claude'), 'SKILL.md')).equals(bytes)).toBe(true);  // archive exists
    expect(h.retirer.retireBlocked()).toMatchObject([{ name: NAME, layout: 'claude' }]);
    // The prepare is still open (recovery's business); the bytes did not change, so the next sweep does not re-attempt within 24 h …
    expect(h.retirer.reconcileRetiredRenderings().blocked).toMatchObject([{ name: NAME, layout: 'claude' }]);
    expect(h.seams.removeDir.mock.calls.filter((c) => String(c[0]).includes('.claude'))).toHaveLength(1);
    // … but once the removal works again (a day later), the byte-identical archive lets the pass finish the removal.
    h.clock.now += 25 * 3600_000;
    h.seams.removeDir.mockImplementation((dir: string, op: string) => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: op }));
    const sweep = h.retirer.reconcileRetiredRenderings();
    expect(sweep.archived).toMatchObject([{ layout: 'claude', via: 'already-archived' }]);
    expect(readIf(rendering(h, '.claude'))).toBeNull();
    expect(h.retirer.retireBlocked()).toEqual([]);
  });

  it('a TOTAL failure (rename and copy both refused) is retire-blocked, nothing is removed, and the sentinel reports the skill ACTIVE with the flag', async () => {
    const h = home();
    await liveSkill(h);
    h.seams.rename.mockImplementation(() => { throw new Error('rename refused'); });
    const realMkdir = fs.mkdirSync;
    const spy = vi.spyOn(fs, 'mkdirSync').mockImplementation(((p: fs.PathLike, o?: fs.MakeDirectoryOptions) => { if (String(p).includes(path.join('renderings', 'm1'))) throw new Error('EROFS: archive dir refused'); return realMkdir(p, o as never); }) as never);
    try {
      const r = await h.retirer.retire(NAME, { kind: 'operator', reason: 'test', harm: false, by: 'operator' });
      expect(r.ok).toBe(true); // the canonical moved; the renderings could not
      const blocked = (r as { blocked: Array<{ reason: string }> }).blocked;
      expect(blocked).toHaveLength(2);
      expect(blocked[0].reason).toMatch(/copy-failed after rename/);
    } finally { spy.mockRestore(); }
    expect(readIf(rendering(h, '.claude'))).not.toBeNull();
    expect(h.seams.removeDir).not.toHaveBeenCalled();
    expect(fs.existsSync(archiveOf(h, 'claude'))).toBe(false);
    // The sentinel over this home: the skill is in skills[] as learned (active), flagged retireBlocked; status names the block.
    const ledger = new FakeLedger();
    const sentinel = new SkillLearningSentinel({ config: cfg(), stateDir: h.stateDir, projectDir: h.root, machineId: 'm1', ledger, families: () => [], transcriptPath: () => null, operatorMessage: () => null, provenance: { recordDecision: () => 'jp', isRecordingLive: () => true }, retirer: h.retirer, now: () => h.clock.now });
    const status = sentinel.status();
    expect(status.skills).toMatchObject([{ name: NAME, state: 'learned', retireBlocked: true }]);
    expect(status.retireBlocked).toMatchObject([{ name: NAME, layout: 'claude' }, { name: NAME, layout: 'agents' }]);
    expect(status.retired).toMatchObject([{ name: NAME }]);
  });

  it('a half-moved archive recovers BOTH directions through the protocol’s journal recovery: a partial destination is reversed, a complete one is finished', async () => {
    const h = home();
    await liveSkill(h);
    await h.retirer.retire(NAME, { kind: 'operator', reason: 'test', harm: false, by: 'operator' });
    // Put the rendering back as if B's tick had not run yet, then fake two half-done states with open prepares.
    const from = path.dirname(rendering(h, '.claude'));
    const to = archiveOf(h, 'claude');
    const archivedMd = fs.readFileSync(path.join(to, 'SKILL.md'));
    // (1) partial destination: the archive holds a prefix of the rendering → reversed (partial removed, source kept).
    SafeFsExecutor.safeRmSync(to, { recursive: true, force: true, operation: 'tests/unit/skill-learning-retirer.test.ts' });
    fs.mkdirSync(from, { recursive: true }); fs.writeFileSync(path.join(from, 'SKILL.md'), archivedMd); fs.writeFileSync(path.join(from, 'extra.md'), 'more');
    fs.mkdirSync(to, { recursive: true }); fs.writeFileSync(path.join(to, 'SKILL.md'), archivedMd);
    (h.retirer as unknown as { journalMove(op: string, name: string, from: string, to: string, detail: string, txId?: string): void }).journalMove('move-prepare', NAME, from, to, 'archive-rendering:claude:retired', 'tx-partial');
    let rec = await h.protocol.recoverOwnJournal();
    expect(rec.voided).toBe(1);
    expect(fs.existsSync(to)).toBe(false);
    expect(readIf(path.join(from, 'extra.md'))).toBe('more');
    expect(journal(h).find((r) => r.txId === 'tx-partial' && r.op === 'move-void')).toBeTruthy();
    // (2) complete destination, source still present and byte-identical → completed (source removed).
    fs.cpSync(from, to, { recursive: true });
    (h.retirer as unknown as { journalMove(op: string, name: string, from: string, to: string, detail: string, txId?: string): void }).journalMove('move-prepare', NAME, from, to, 'archive-rendering:claude:retired', 'tx-complete');
    rec = await h.protocol.recoverOwnJournal();
    expect(rec.finished).toBe(1);
    expect(fs.existsSync(from)).toBe(false);
    expect(readIf(path.join(to, 'extra.md'))).toBe('more');
    expect(journal(h).find((r) => r.txId === 'tx-complete' && r.op === 'move-commit')).toBeTruthy();
    // The archive rows carry their own op, and recovery never touched the version store: no stray tombstone.
    expect(journal(h).filter((r) => r.txId === 'tx-partial' || r.txId === 'tx-complete').every((r) => r.commitOp === 'archive-rendering')).toBe(true);
    const versionRows = fs.readFileSync(path.join(h.stateDir, 'skill-learning', 'versions', NAME, 'm1.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string });
    expect(versionRows.filter((r) => r.kind === 'tombstone')).toEqual([]);
    expect(h.versions.rows(NAME).map((r) => r.op)).toEqual(['create', 'retire']);
  });

  it('a crash-orphaned retired/<name>.aside-* directory is visible (retireBlocked, layout "aside", not a live skill) and the sweep puts it back — or merges it when the retire had landed', async () => {
    // (1) crash BEFORE the canonical moved: the aside goes back to retired/<name>/.
    const h = home();
    await liveSkill(h, 'operator-owned');
    await h.reconciler.reconcileAll('tick'); // lock retraction → retired/<name>/renderings/m1/…
    const asideA = path.join(h.stateDir, 'skill-learning', 'retired', `${NAME}.aside-deadbeef`);
    fs.renameSync(path.join(h.stateDir, 'skill-learning', 'retired', NAME), asideA);
    expect(h.retirer.retireBlocked()).toMatchObject([{ name: NAME, layout: 'aside' }]);
    expect(h.retirer.retireBlocked()[0].reason).toContain('set aside');
    expect(h.retirer.blockedNames()).toEqual([]); // an aside is not a live skill
    h.retirer.reconcileRetiredRenderings();
    expect(fs.existsSync(asideA)).toBe(false);
    expect(fs.existsSync(path.join(archiveOf(h, 'claude'), 'SKILL.md'))).toBe(true);
    expect(h.retirer.retireBlocked()).toEqual([]);
    expect(h.log.find((r) => r.kind === 'retire-aside-recovered')).toMatchObject({ name: NAME, merged: false });
    // (2) crash AFTER the canonical moved (retired/<name>/SKILL.md exists, archives still aside): merged in beside it.
    const g = home();
    await liveSkill(g, 'operator-owned');
    await g.reconciler.reconcileAll('tick');
    const asideB = path.join(g.stateDir, 'skill-learning', 'retired', `${NAME}.aside-0badf00d`);
    fs.renameSync(path.join(g.stateDir, 'skill-learning', 'retired', NAME), asideB);
    fs.mkdirSync(path.join(g.stateDir, 'skill-learning', 'retired', NAME), { recursive: true });
    fs.writeFileSync(path.join(g.stateDir, 'skill-learning', 'retired', NAME, 'SKILL.md'), canonicalDoc('active').replace('"operator-owned"', '"retired"'));
    g.retirer.reconcileRetiredRenderings();
    expect(fs.existsSync(asideB)).toBe(false);
    expect(fs.existsSync(path.join(archiveOf(g, 'claude'), 'SKILL.md'))).toBe(true);
    expect(g.log.find((r) => r.kind === 'retire-aside-recovered')).toMatchObject({ name: NAME, merged: true });
    expect(g.retirer.listRetired()[0].renderingsArchived).toEqual({ m1: ['agents', 'claude'] });
  });

  it('a learned-marker rendering with no canonical anywhere is reported as orphan-learned-rendering and never moved', async () => {
    const h = home();
    await liveSkill(h);
    const rendered = fs.readFileSync(rendering(h, '.claude'));
    SafeFsExecutor.safeRmSync(path.dirname(canonical(h)), { recursive: true, force: true, operation: 'tests/unit/skill-learning-retirer.test.ts:hand-delete' });
    expect(h.retirer.lockLeftRendering()).toEqual([{ name: NAME, layouts: ['claude', 'agents'], state: 'orphan-learned-rendering' }]);
    const sweep = h.retirer.reconcileRetiredRenderings();
    expect(sweep.lockLeftRendering).toEqual([{ name: NAME, layouts: ['claude', 'agents'], state: 'orphan-learned-rendering' }]);
    expect(sweep.archived).toEqual([]);
    expect(fs.readFileSync(rendering(h, '.claude')).equals(rendered)).toBe(true);
    expect(fs.existsSync(archiveOf(h, 'claude'))).toBe(false);
    expect(readIf(path.join(h.root, '.claude', 'skills', 'orphan-by-hand', 'SKILL.md'))).toContain('Hand-written'); // no marker → not even reported
    expect(h.reconciler.status().lockLeftRendering).toEqual([]); // untouched until a pass ran
    await h.reconciler.reconcileAll('tick');
    expect(h.reconciler.status().lockLeftRendering).toMatchObject([{ name: NAME, state: 'orphan-learned-rendering' }]);
  });
});

describe('retire-all pauses drafting until the re-arm date (deviation 3B-1)', () => {
  it('a 3/2/2 key does not draft while the hold is in force; after reArmReviewAt it drafts', async () => {
    const hm = mkHome();
    fs.mkdirSync(path.join(hm.stateDir, 'logs'), { recursive: true });
    const ledger = new FakeLedger();
    seedHistory(ledger, hm, 3);
    const families = [fam('anthropic', 'claude-code', responder({})), fam('openai', 'codex-cli', responder({}))];
    const retirer = new Retirer({ projectDir: hm.root, stateDir: hm.stateDir, machineId: 'm1', config: cfg(), commitProtocol: null, now: () => hx.clock.now });
    const hx = harness(hm, ledger, families, { retirer });
    const record = await retirer.retireAll('operator');
    expect(record.retired).toEqual([]);
    expect(retirer.retireAllHold()).toBe(true);
    const t1 = await hx.sentinel.tick();
    const t2 = await hx.sentinel.tick();
    expect(t1.drafted + t2.drafted).toBe(0);
    expect(t1).toMatchObject({ observeOnly: true, held: 1 });
    expect(hx.sentinel.status().retireAll).toMatchObject({ actor: 'operator', reArmReviewAt: record.reArmReviewAt });
    hx.clock.now = Date.parse(record.reArmReviewAt) + 1;
    expect(retirer.retireAllHold()).toBe(false);
    const t3 = await hx.sentinel.tick();
    const t4 = await hx.sentinel.tick();
    expect(t3.drafted + t4.drafted).toBe(1);
  });
});

// ── the holder side: floors, the reviewer, the defaults ──────────────────────

describe('the evidence floor and the reviewer (holder)', () => {
  const retiredHere = (h: Home) => fs.existsSync(retiredCanonical(h));

  it('a score retire is refused at 2 corroborated runs (unmeasured) and allowed at 3 — the static defaults deciding only because no reviewer is wired', async () => {
    const h2 = home();
    await liveSkill(h2);
    const d2 = await h2.retirer.judge([candidate({ corroboratedRuns: 2, score: 0.2 })]);
    expect(d2[0]).toMatchObject({ verdict: 'unmeasured', by: 'floor' });
    expect(retiredHere(h2)).toBe(false);
    const h3 = home();
    await liveSkill(h3);
    const d3 = await h3.retirer.judge([candidate({ corroboratedRuns: 3, score: 0.2 })]);
    expect(d3[0]).toMatchObject({ verdict: 'retire', by: 'default-rung', kind: 'score', harm: true, applied: true });
    expect(retiredHere(h3)).toBe(true);
    expect(h3.learnings).toHaveLength(1); // harm → a learning
    expect(h3.learnings[0]).toMatchObject({ category: 'skill-learning', tags: ['skill-learning', 'retire', 'harm'] });
    expect(h3.log.find((r) => r.kind === 'retire-arbiter-vs-default')).toBeUndefined(); // no reviewer answered
    // One judgment per (name, version): the memo makes the next tick idle.
    const again = await h3.retirer.judge([candidate({ corroboratedRuns: 3, score: 0.2 })]);
    expect(again[0]).toMatchObject({ verdict: 'memoised' });
  });

  it('a single misfire verdict never retires; two do (misfire rate above the default floor)', async () => {
    const one = home();
    await liveSkill(one);
    expect((await one.retirer.judge([candidate({ corroboratedRuns: 1, score: null, misfires: 1, uses: 2 })]))[0]).toMatchObject({ verdict: 'unmeasured' });
    const two = home();
    await liveSkill(two);
    expect((await two.retirer.judge([candidate({ corroboratedRuns: 1, score: null, misfires: 2, uses: 2 })]))[0]).toMatchObject({ verdict: 'retire', kind: 'misfire', harm: false, applied: true });
    expect(two.learnings).toEqual([]);
  });

  it('the unused silence floor is 3 × windowDays: one day short the reviewer is not asked; at the boundary it is', async () => {
    const silence = 3 * SKILL_LEARNING_DEFAULTS.defaultGate.windowDays;
    const reviewer = vi.fn<RetireReviewer>(async () => ({ verdict: 'keep', reason: 'still wanted', harm: false, family: 'openai' }));
    const short = home({ reviewer });
    await liveSkill(short);
    const quiet = (days: number) => candidate({ corroboratedRuns: 0, score: null, uses: 0, misfires: 0, lastUsedAt: undefined, lastRequestAt: new Date(NOW - days * DAY).toISOString(), requestsWithoutUse: 0, occurrencesInWindow: 0 });
    expect((await short.retirer.judge([quiet(silence - 1)]))[0]).toMatchObject({ verdict: 'unmeasured' });
    expect(reviewer).not.toHaveBeenCalled();
    const at = home({ reviewer });
    await liveSkill(at);
    expect((await at.retirer.judge([quiet(silence)]))[0]).toMatchObject({ verdict: 'keep', by: 'reviewer' });
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(reviewer.mock.calls[0][0].signals).toMatchObject({ unusedFloorMet: true, daysSilent: silence });
    // One observed request with no use is the other arm of the same floor.
    const asked = home({ reviewer });
    await liveSkill(asked);
    expect((await asked.retirer.judge([candidate({ corroboratedRuns: 0, score: null, uses: 0, requestsWithoutUse: 1 })]))[0]).toMatchObject({ verdict: 'keep', by: 'reviewer' });
  });

  it('the reviewer’s verdict governs: "keep" where the defaults would retire retires nothing, and retire-arbiter-vs-default records the disagreement with the numbers', async () => {
    const reviewer = vi.fn<RetireReviewer>(async () => ({ verdict: 'keep', reason: 'the corrections were about tone, not the procedure', harm: false, family: 'openai' }));
    const h = home({ reviewer });
    await liveSkill(h);
    const d = await h.retirer.judge([candidate({ corroboratedRuns: 3, score: 0.2 })]);
    expect(d[0]).toMatchObject({ verdict: 'keep', by: 'reviewer', defaultVerdict: 'retire', reviewerFamily: 'openai' });
    expect(retiredHere(h)).toBe(false);
    const row = h.log.find((r) => r.kind === 'retire-arbiter-vs-default');
    expect(row).toMatchObject({ name: NAME, arbiter: 'keep', default: 'retire', defaultKind: 'score', agree: false, family: 'openai' });
    expect((row!.signals as Record<string, unknown>).costPerExpectedUse).toBeCloseTo((120 * 20) / (3 / (30 / 7)), 3);
    const prompt = reviewer.mock.calls[0][0].prompt;
    expect(prompt).toContain('Score (accepted+1 over measured+2): 0.20');
    expect(prompt).toContain('retire when score < 0.4');
  });

  it('an unrecorded reviewer verdict is discarded (nothing acts, re-asked after a day), and a reviewer OUTAGE lets the defaults decide', async () => {
    const unrecorded = home({ reviewer: async () => 'unrecorded' });
    await liveSkill(unrecorded);
    expect((await unrecorded.retirer.judge([candidate()]))[0]).toMatchObject({ verdict: 'unrecorded' });
    expect(retiredHere(unrecorded)).toBe(false);
    expect(unrecorded.log.find((r) => r.kind === 'retire-unrecorded')).toBeTruthy();
    expect((await unrecorded.retirer.judge([candidate()]))[0]).toMatchObject({ verdict: 'memoised' });
    const outage = home({ reviewer: async () => { throw new Error('provider down'); } });
    await liveSkill(outage);
    expect((await outage.retirer.judge([candidate()]))[0]).toMatchObject({ verdict: 'retire', by: 'default-rung', applied: true });
    expect(outage.log.find((r) => r.kind === 'retire-reviewer-error')).toBeTruthy();
  });

  it('a LOCKED skill is never patched (the reviewer’s "patch" is refused) and never retired for anything but harm — but harm retires it, edited rendering archived', async () => {
    const answers: Array<{ verdict: 'retire' | 'keep' | 'patch'; harm: boolean }> = [{ verdict: 'patch', harm: false }, { verdict: 'retire', harm: false }, { verdict: 'retire', harm: true }];
    const reviewer = vi.fn<RetireReviewer>(async () => ({ ...answers.shift()!, reason: 'r', family: 'openai' }));
    const h = home({ reviewer, config: cfg({ shadow: { ...SKILL_LEARNING_DEFAULTS.shadow, verdictReaskDays: 0 } }) });
    await liveSkill(h, 'operator-owned');
    const edited = `${fs.readFileSync(rendering(h, '.claude'), 'utf-8')}\n3. The operator's own step.\n`;
    fs.writeFileSync(rendering(h, '.claude'), edited);
    const locked = () => candidate({ state: 'operator-owned', locked: true, corroboratedRuns: 3, score: 0.2 });
    const d1 = await h.retirer.judge([locked()]);
    expect(d1[0]).toMatchObject({ verdict: 'patch', refused: 'locked-never-patched' });
    h.clock.now += DAY + 1;
    const d2 = await h.retirer.judge([locked()]);
    expect(d2[0]).toMatchObject({ verdict: 'retire', refused: 'locked-not-harm' });
    expect(retiredHere(h)).toBe(false);
    h.clock.now += DAY + 1;
    const d3 = await h.retirer.judge([locked()]);
    expect(d3[0]).toMatchObject({ verdict: 'retire', harm: true, applied: true });
    expect(retiredHere(h)).toBe(true);
    expect(readIf(path.join(archiveOf(h, 'claude'), 'SKILL.md'))).toBe(edited); // the operator's bytes, recoverable
    expect(readIf(rendering(h, '.claude'))).toBeNull();
    expect(h.learnings).toHaveLength(1);
    expect(h.log.filter((r) => r.kind === 'retire-refused').map((r) => r.reason)).toEqual(['locked-never-patched', 'locked-not-harm']);
  });

  it('retire refuses by name: a pending skill (reject is its tap), a missing one, a hand-written one', async () => {
    const h = home();
    await h.protocol.write('create', NAME, canonicalDoc('pending'), { expectedPrevHash: null });
    expect(await h.retirer.retire(NAME, { kind: 'operator', reason: 'x', harm: false, by: 'operator' })).toEqual({ ok: false, error: 'pending-use-reject' });
    expect(await h.retirer.retire('nothing-here', { kind: 'operator', reason: 'x', harm: false, by: 'operator' })).toEqual({ ok: false, error: 'not-found' });
    fs.mkdirSync(path.join(h.root, '.instar', 'skills', 'by-hand'), { recursive: true });
    fs.writeFileSync(path.join(h.root, '.instar', 'skills', 'by-hand', 'SKILL.md'), '---\nname: by-hand\ndescription: "mine"\n---\nbody\n');
    expect(await h.retirer.retire('by-hand', { kind: 'operator', reason: 'x', harm: false, by: 'operator' })).toEqual({ ok: false, error: 'not-learned' });
    expect(readIf(path.join(h.root, '.instar', 'skills', 'by-hand', 'SKILL.md'))).toContain('mine');
  });
});

// ── restore ──────────────────────────────────────────────────────────────────

describe('restore: lint again, a different family reviews, held pending, counters reset', () => {
  it('re-lints, asks a reviewer with the retired author named, moves the canonical back as pending with counters-since, keeps the archive in history, renders nothing', async () => {
    const restoreReviewer = vi.fn<RestoreReviewer>(async () => ({ pass: true, reason: 'still grounded', family: 'openai' }));
    const h = home({ restoreReviewer });
    await liveSkill(h);
    await h.retirer.retire(NAME, { kind: 'score', reason: 'its runs kept getting corrected', harm: true, by: 'reviewer', reviewerFamily: 'openai' });
    h.clock.now += DAY;
    const r = await h.retirer.restore(NAME, { actor: 'operator' });
    expect(r).toMatchObject({ ok: true, version: 3, pendingReason: 'restored', reviewerFamily: 'openai', harmReason: 'its runs kept getting corrected' });
    expect(restoreReviewer).toHaveBeenCalledTimes(1);
    expect(restoreReviewer.mock.calls[0][0]).toMatchObject({ name: NAME, authorFamily: 'anthropic', harmReason: 'its runs kept getting corrected' });
    const back = readIf(canonical(h))!;
    expect(back).toMatch(/instar-learned-state: "pending"/);
    expect(back).toContain(`instar-learned-counters-since: "${new Date(h.clock.now).toISOString()}"`);
    expect(back).not.toContain('instar-learned-retire-reason');
    expect(readIf(retiredCanonical(h))).toBeNull();
    expect(readIf(rendering(h, '.claude'))).toBeNull(); // pending: nothing renders until the confirm tap
    expect(h.versions.lastRow(NAME)).toMatchObject({ op: 'restore', state: 'pending', version: 3 });
    const history = path.join(h.stateDir, 'skill-learning', 'retired', '_history', NAME);
    const stamps = fs.readdirSync(history);
    expect(stamps).toHaveLength(1);
    expect(fs.existsSync(path.join(history, stamps[0], 'renderings', 'm1', 'claude', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(history, stamps[0], 'retired.json'))).toBe(true);
    expect(h.retirer.listRetired()).toEqual([]);
    expect(h.log.find((x) => x.kind === 'restore')).toMatchObject({ name: NAME, pendingReason: 'restored', harm: true, authorFamily: 'anthropic' });
  });

  it('the structural lint refuses a restore (a scripts/ reference), nothing moves; a refusing reviewer refuses it too; no second family holds it pending one-family', async () => {
    const lintHome = home({ restoreReviewer: async () => ({ pass: true, reason: 'ok', family: 'openai' }) });
    await lintHome.protocol.write('create', NAME, canonicalDoc('active', '# Steps\n\n1. Run scripts/deploy.sh then read /ci/health.\n'), { expectedPrevHash: null });
    await lintHome.retirer.retire(NAME, { kind: 'operator', reason: 'x', harm: false, by: 'operator' });
    const lint = await lintHome.retirer.restore(NAME);
    expect(lint).toMatchObject({ ok: false, error: 'lint' });
    expect((lint as { detail: string }).detail).toContain('no-scripts');
    expect(readIf(retiredCanonical(lintHome))).not.toBeNull();
    expect(readIf(canonical(lintHome))).toBeNull();
    const refusing = home({ restoreReviewer: async () => ({ pass: false, reason: 'the second step is ungrounded', family: 'openai' }) });
    await liveSkill(refusing);
    await refusing.retirer.retire(NAME, { kind: 'operator', reason: 'x', harm: false, by: 'operator' });
    expect(await refusing.retirer.restore(NAME)).toMatchObject({ ok: false, error: 'review-refused' });
    expect(readIf(retiredCanonical(refusing))).toMatch(/instar-learned-state: "retired"/); // the held frontmatter was put back
    expect(fs.existsSync(path.join(refusing.stateDir, 'skill-learning', 'retired', NAME, 'retired.json'))).toBe(true);
    const oneFamily = home({ restoreReviewer: async () => 'one-family' });
    await liveSkill(oneFamily);
    await oneFamily.retirer.retire(NAME, { kind: 'operator', reason: 'x', harm: false, by: 'operator' });
    expect(await oneFamily.retirer.restore(NAME)).toMatchObject({ ok: true, pendingReason: 'one-family' });
    const noReviewer = home();
    await liveSkill(noReviewer);
    await noReviewer.retirer.retire(NAME, { kind: 'operator', reason: 'x', harm: false, by: 'operator' });
    expect(await noReviewer.retirer.restore(NAME)).toMatchObject({ ok: false, error: 'review-unavailable' });
  });
});

// ── retire-all and lock retraction ──────────────────────────────────────────

describe('retire-all and lock retraction', () => {
  it('retire-all retires every live learned skill, writes the audit row { actor, reArmReviewAt: now + 14 d } to the log and the durable file, and holds the sentinel’s drafting', async () => {
    const h = home();
    await liveSkill(h);
    await liveSkill(h, 'operator-owned', 'release-notes');
    await h.protocol.write('create', 'still-pending', canonicalDoc('pending', undefined, 'still-pending'), { expectedPrevHash: null });
    const record = await h.retirer.retireAll('operator');
    expect(record.retired).toEqual([NAME, 'release-notes']);
    expect(record.refused).toEqual([]);
    expect(record.reArmReviewAt).toBe(new Date(NOW + 14 * DAY).toISOString());
    expect(h.log.find((r) => r.kind === 'retire-all')).toMatchObject({ actor: 'operator', reArmReviewAt: record.reArmReviewAt, retired: [NAME, 'release-notes'] });
    expect(JSON.parse(fs.readFileSync(path.join(h.stateDir, 'skill-learning', 'retire-all.m1.json'), 'utf-8'))).toMatchObject({ actor: 'operator', reArmReviewAt: record.reArmReviewAt });
    expect(readIf(canonical(h, 'still-pending'))).not.toBeNull(); // pending is not live: untouched
    expect(h.retirer.retireAllHold()).toBe(true);
    h.clock.now = NOW + 14 * DAY;
    expect(h.retirer.retireAllHold()).toBe(false);
    h.clock.now = NOW;
    // The sentinel skips the keys phase while the hold is in force.
    const ledger = new FakeLedger();
    const families: FamilyProvider[] = [];
    const sentinel = new SkillLearningSentinel({ config: cfg(), stateDir: h.stateDir, projectDir: h.root, machineId: 'm1', ledger, families: () => families, transcriptPath: () => null, operatorMessage: () => null, provenance: { recordDecision: () => 'jp', isRecordingLive: () => true }, retirer: h.retirer, reviewer: null, reverter: null, now: () => h.clock.now });
    const tick = await sentinel.tick();
    expect(tick).toMatchObject({ observeOnly: true, held: 1 });
    expect(sentinel.status().retireAll).toMatchObject({ actor: 'operator', retired: 2 });
  });

  it('lock retraction: a locked canonical’s leftover rendering is listed in lockLeftRendering until the tick archives it into retired/<name>/renderings/<machine>/; the canonical stays', async () => {
    const h = home();
    await liveSkill(h, 'operator-owned');
    expect(h.retirer.lockLeftRendering()).toEqual([{ name: NAME, layouts: ['claude', 'agents'], state: 'operator-owned' }]);
    const bytes = fs.readFileSync(rendering(h, '.claude'));
    const tick = await h.reconciler.reconcileAll('tick');
    expect(tick.retireArchived).toBe(2);
    expect(h.retirer.lockLeftRendering()).toEqual([]);
    expect(h.reconciler.status().lockLeftRendering).toEqual([]);
    expect(readIf(rendering(h, '.claude'))).toBeNull();
    expect(fs.readFileSync(path.join(archiveOf(h, 'claude'), 'SKILL.md')).equals(bytes)).toBe(true);
    expect(readIf(canonical(h))).toMatch(/instar-learned-state: "operator-owned"/);
    expect(h.retirer.listRetired()).toEqual([]); // archives alone are not a retired skill
    // A later retire of the locked skill finds the archives in the way and merges them in beside the canonical.
    const r = await h.retirer.retire(NAME, { kind: 'score', reason: 'harm', harm: true, by: 'reviewer' });
    expect(r.ok).toBe(true);
    expect(readIf(retiredCanonical(h))).toMatch(/retired/);
    expect(fs.existsSync(path.join(archiveOf(h, 'claude'), 'SKILL.md'))).toBe(true);
    expect(h.retirer.listRetired()[0].renderingsArchived).toEqual({ m1: ['agents', 'claude'] });
  });

  it('archiveLeftoverRenderings(name) — the sentinel’s one-liner — archives on the spot and reports what is still left', async () => {
    const h = home();
    await liveSkill(h, 'operator-owned');
    const r = await h.retirer.archiveLeftoverRenderings(NAME);
    expect(r.archived.map((a) => a.layout)).toEqual(['claude', 'agents']);
    expect(r.left).toEqual([]);
    expect(await h.retirer.archiveLeftoverRenderings(NAME)).toEqual({ archived: [], blocked: [], left: [] });
    // Not locked → nothing happens.
    const active = home();
    await liveSkill(active);
    expect(await active.retirer.archiveLeftoverRenderings(NAME)).toEqual({ archived: [], blocked: [], left: [] });
    expect(readIf(rendering(active, '.claude'))).not.toBeNull();
  });
});

describe('held-state retraction and the index-cost heal (coordinator items d/e)', () => {
  it('archiveLeftoverRenderings archives the rendering a PENDING canonical left behind (a refused revert’s N+1) and lockLeftRendering names the state', async () => {
    const h = home();
    await liveSkill(h);
    // 3A's refused-revert shape: the canonical flips to pending while N's rendering is still on disk.
    fs.writeFileSync(canonical(h), canonicalDoc('pending'));
    expect(h.retirer.lockLeftRendering()).toEqual([{ name: NAME, layouts: ['claude', 'agents'], state: 'pending' }]);
    const r = await h.retirer.archiveLeftoverRenderings(NAME);
    expect(r.archived.map((a) => a.layout)).toEqual(['claude', 'agents']);
    expect(readIf(rendering(h, '.claude'))).toBeNull();
    expect(fs.existsSync(path.join(archiveOf(h, 'claude'), 'SKILL.md'))).toBe(true);
    expect(h.retirer.lockLeftRendering()).toEqual([]);
    expect(readIf(canonical(h))).toMatch(/pending/); // the canonical is untouched
  });

  it('retireLowestUnused: the lowest-scored unused skill is proposed to the reviewer and retired through the normal path; nothing retirable is terminal', async () => {
    const reviewer = vi.fn<RetireReviewer>(async (input) => ({ verdict: 'retire', reason: `make room: ${input.candidate.name}`, harm: false, family: 'openai' }));
    const h = home({ reviewer });
    await liveSkill(h);
    await liveSkill(h, 'active', 'release-notes');
    const cands: RetireCandidate[] = [
      candidate({ name: NAME, score: 0.9, uses: 4, corroboratedRuns: 4, requestsWithoutUse: 0 }),                           // used, above the floor: not a candidate
      candidate({ name: 'release-notes', key: 'release-notes', score: null, uses: 0, corroboratedRuns: 0, requestsWithoutUse: 2, lastUsedAt: undefined }),
    ];
    h.retirer.bind({ candidates: () => cands } as never);
    const heal = await h.retirer.retireLowestUnused({ key: 'deploy-digest', indexBytes: 9000, claudeHeadroomChars: 200 });
    expect(heal).toMatchObject({ healed: true, name: 'release-notes' });
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(reviewer.mock.calls[0][0].prompt).toContain('judged too costly for a wanted draft (key deploy-digest');
    expect(readIf(retiredCanonical(h, 'release-notes'))).toMatch(/instar-learned-retire-kind: "unused"/);
    expect(readIf(canonical(h))).not.toBeNull(); // the used one stays
    expect(h.log.find((r) => r.kind === 'retire-arbiter-vs-default' && r.heal === 'index-cost')).toBeTruthy();
    // Nothing left above the unused floor → terminal.
    h.retirer.bind({ candidates: () => [cands[0]] } as never);
    expect(await h.retirer.retireLowestUnused({ key: 'k', indexBytes: null, claudeHeadroomChars: null })).toEqual({ healed: false, reason: 'nothing-retirable', terminal: true });
    // A reviewer that keeps: not healed, not terminal; with NO reviewer the defaults decide (unused floor met but < defaultUnusedDays → keep).
    const keep = home({ reviewer: async () => ({ verdict: 'keep', reason: 'wanted', harm: false, family: 'openai' }) });
    await liveSkill(keep);
    keep.retirer.bind({ candidates: () => [cands[1]] } as never);
    expect(await keep.retirer.retireLowestUnused({ key: 'k', indexBytes: 1, claudeHeadroomChars: 1 })).toMatchObject({ healed: false, reason: 'reviewer-keep' });
    const none = home();
    await liveSkill(none);
    none.retirer.bind({ candidates: () => [cands[1]] } as never);
    expect(await none.retirer.retireLowestUnused({ key: 'k', indexBytes: 1, claudeHeadroomChars: 1 })).toMatchObject({ healed: false, reason: 'defaults-keep' });
  });

  it('a retire for harm writes `instar-learned-retire-reason: "harm: <reason>"` into the retired frontmatter', async () => {
    const h = home();
    await liveSkill(h);
    await h.retirer.retire(NAME, { kind: 'score', reason: 'four corrections in a row', harm: true, by: 'reviewer' });
    expect(readIf(retiredCanonical(h))).toContain('instar-learned-retire-reason: "harm: four corrections in a row"');
    expect(h.retirer.harmRetired()).toEqual([{ skill: NAME, version: 2, reason: 'four corrections in a row' }]);
  });
});

describe('helpers', () => {
  it('patchMetadata sets, replaces and removes flat metadata keys without touching the body; the review parser is strict', () => {
    const raw = canonicalDoc('active');
    const patched = patchMetadata(raw, { 'instar-learned-state': 'retired', 'instar-learned-retire-reason': 'he said "no"', 'instar-learned-key': null })!;
    expect(patched).toContain('instar-learned-state: "retired"');
    expect(patched).toContain('instar-learned-retire-reason: "he said \\"no\\""');
    expect(patched).not.toContain('instar-learned-key');
    expect(patched.split('---\n')[2]).toBe(raw.split('---\n')[2]);
    expect(patchMetadata('no frontmatter', { a: 'b' })).toBeNull();
    expect(parseRetireReviewOutput('{"verdict":"retire","harm":true,"reason":"x"}')).toEqual({ verdict: 'retire', harm: true, reason: 'x' });
    expect(parseRetireReviewOutput('{"verdict":"delete"}')).toBeNull();
    expect(parseRetireReviewOutput('nope')).toBeNull();
    const prompt = buildRetireReviewPrompt(candidate(), { scoreFloorMet: true, misfireFloorMet: false, unusedFloorMet: false, misfireRate: 0, daysUnused: 1, daysSilent: 1, costPerExpectedUse: null }, { scoreFloor: 0.4, misfireFloor: 0.3, unusedDays: 60 });
    expect(prompt).toContain('Cost per expected use (index bytes × sessions/week ÷ occurrences/week): unmeasured');
  });
});
