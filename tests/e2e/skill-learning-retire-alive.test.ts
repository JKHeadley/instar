// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
// safe-git-allow: test fixture — every git call goes through SafeGitExecutor.run on temp repos.
/**
 * Tier-3 E2E for retire as its own reconciliation across TWO machines (docs/specs/skill-learning-sentinel.md §3.8,
 * §8 "E2E"; slice 3B): two fixture agent homes sharing a bare git remote (the `.instar/` state syncs; the
 * renderings under `.claude/` / `.agents/` never do).
 *
 *  1. A writes a learned skill through the real commit protocol → rendered on A; push. B pulls → B's reconcile
 *     tick renders it on B.
 *  2. A retires it (the Retirer: canonical moved to `retired/`, A's renderings archived); push. B pulls → B's
 *     `reconcileAll('tick')` — the production reconciler with the Retirer bound through the REAL `startSkillLearning`
 *     (flag off: no sentinel, the sweep still runs) — ARCHIVES B's rendering byte-for-byte under
 *     `retired/<name>/renderings/<B>/claude/` and removes it from B's discovery; B pushes; A pulls and sees both
 *     machines' archives in `retired[].renderingsArchived`.
 *  3. ALIVE: the production AgentServer on A with the flag on serves `GET /skills/learned` with `retired[]`,
 *     `retireBlocked: []`, `lockLeftRendering: []` through the real bearer gate.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { HandshakeManager } from '../../src/threadline/HandshakeManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { LearnedSkillReconciler } from '../../src/monitoring/LearnedSkillReconciler.js';
import { SkillLearningSentinel } from '../../src/monitoring/SkillLearningSentinel.js';
import { startSkillLearning } from '../../src/monitoring/skillLearning/wire.js';
import type { InstarConfig } from '../../src/core/types.js';
import { FakeLedger, NOW } from '../helpers/skillLearningLiveFixtures.js';

const NAME = 'ci-health-report';
const TMP = process.env.TMPDIR ?? os.tmpdir();

function git(cwd: string, args: string[]): string {
  return SafeGitExecutor.run(args, { cwd, operation: 'tests/e2e/skill-learning-retire-alive.test.ts:git' });
}

function canonicalDoc(): string {
  return [
    '---', `name: ${NAME}`,
    'description: "Use when the operator asks for the weekly CI health of the instar repo. Not for deploy status."',
    'metadata:', '  short-description: "CI health, weekly"', '  instar-learned-origin: "skill-learning-sentinel"', '  instar-learned-key: "ci-health"',
    '  instar-learned-version: "1"', '  instar-learned-created: "2026-10-01T11:00:00Z"', '  instar-learned-locked: "false"', '  instar-learned-state: "active"',
    '---', '# CI health report', '', '1. Read the CI health route at /ci/health.', '2. Summarise failing jobs in plain language.', '',
  ].join('\n');
}

interface Machine { root: string; stateDir: string; machineId: string; reconciler: LearnedSkillReconciler; sentinel: SkillLearningSentinel | null }

function commitAndPush(root: string, msg: string): void {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', msg, '--allow-empty']);
  git(root, ['push', '-q', 'origin', 'main']);
}

const rendering = (m: Machine, layout: '.claude' | '.agents') => path.join(m.root, layout, 'skills', NAME, 'SKILL.md');
const canonical = (m: Machine) => path.join(m.root, '.instar', 'skills', NAME, 'SKILL.md');
const retiredDir = (m: Machine) => path.join(m.stateDir, 'skill-learning', 'retired', NAME);
const readIf = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null);

describe('retire across two machines sharing a bare git remote (feature is alive on the production init path)', () => {
  let base: string;
  let bare: string;
  let A: Machine;
  let B: Machine;

  /** A machine over a clone of the bare remote, wired through the REAL startSkillLearning (the Retirer is bound to the reconciler there). */
  function machine(root: string, machineId: string, enabled: boolean): Machine {
    const stateDir = path.join(root, '.instar');
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    const reconciler = new LearnedSkillReconciler({ projectDir: root, stateDir, machineId, enabledFrameworks: () => ['claude-code', 'codex-cli'], holdUntilReleased: true, now: () => NOW });
    const sentinel = startSkillLearning({
      reconciler, rawConfig: { monitoring: { skillLearning: { enabled, mode: 'live' } } }, projectDir: root, stateDir, machineId,
      sharedIntelligence: null, topicMemory: null, operatorStore: () => null, provenance: () => null,
    }, (deps) => new SkillLearningSentinel({
      config: deps.config, stateDir: deps.stateDir, projectDir: deps.projectDir, machineId: deps.machineId, ledger: new FakeLedger(), families: () => [],
      transcriptPath: () => null, operatorMessage: () => null, provenance: { recordDecision: () => 'jp-e2e', isRecordingLive: () => true },
      commitProtocol: deps.commitProtocol ?? null, versionStore: deps.versionStore ?? null, retirer: deps.retirer ?? null, reviewer: null, reverter: null,
      mode: () => 'live', rungTwoProven: () => true, now: () => NOW,
    }));
    return { root, stateDir, machineId, reconciler, sentinel };
  }

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(TMP, 'sl-retire-e2e-'));
    bare = path.join(base, 'remote.git');
    git(base, ['init', '-q', '--bare', bare]);
    // Machine A: the first clone, seeded with the state layout and the ignore rules (renderings never sync).
    const rootA = path.join(base, 'A');
    git(base, ['clone', '-q', bare, rootA]);
    for (const [k, v] of [['user.email', 'fixture@instar.local'], ['user.name', 'Fixture'], ['commit.gpgsign', 'false']]) git(rootA, ['config', k, v]);
    git(rootA, ['checkout', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(rootA, '.gitignore'), '.claude/\n.agents/\n.instar/state/\n.instar/logs/\n');
    fs.mkdirSync(path.join(rootA, '.instar', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(rootA, '.instar', 'skills', '.keep'), '');
    commitAndPush(rootA, 'chore: seed');
    const rootB = path.join(base, 'B');
    git(base, ['clone', '-q', bare, rootB]);
    for (const [k, v] of [['user.email', 'fixture@instar.local'], ['user.name', 'Fixture'], ['commit.gpgsign', 'false']]) git(rootB, ['config', k, v]);
    git(rootB, ['checkout', '-q', 'main']); // the bare remote's HEAD may not name main; B tracks it explicitly
    A = machine(rootA, 'alpha', true);
    B = machine(rootB, 'beta', false);
  });

  afterAll(() => {
    A?.sentinel?.stop(); B?.sentinel?.stop();
    A?.reconciler.stop(); B?.reconciler.stop();
    SafeFsExecutor.safeRmSync(base, { recursive: true, force: true, operation: 'tests/e2e/skill-learning-retire-alive.test.ts' });
  });

  it('startSkillLearning built the sentinel on A over a real Retirer, and bound a Retirer to B’s reconciler even with the flag off', async () => {
    expect(A.sentinel).not.toBeNull();
    expect(B.sentinel).toBeNull();
    expect(A.sentinel!.status().retired).toEqual([]);
    // B's reconciler reports the sweep fields (the Retirer is bound) — nothing to do yet.
    const boot = await B.reconciler.reconcileAll('boot');
    expect(boot.retireArchived).toBe(0);
    expect(B.reconciler.status().retireBlocked).toEqual([]);
  });

  it('A writes a learned skill (rendered on A), pushes; B pulls and its tick renders it on B', async () => {
    const stack = (A.sentinel as unknown as { deps: { commitProtocol: { write: (...a: unknown[]) => Promise<{ ok: boolean }> } } }).deps.commitProtocol;
    const res = await stack.write('create', NAME, canonicalDoc(), { expectedPrevHash: null, authorFamily: 'anthropic' });
    expect(res.ok).toBe(true);
    expect(readIf(rendering(A, '.claude'))).toMatch(/^x-instar-stamp:/m);
    commitAndPush(A.root, 'feat: learned skill');
    git(B.root, ['pull', '-q', '--rebase', 'origin', 'main']);
    expect(readIf(canonical(B))).toBe(canonicalDoc());
    const tick = await B.reconciler.reconcileAll('tick');
    expect(tick.rendered).toBe(2);
    expect(readIf(rendering(B, '.claude'))).toMatch(/^x-instar-stamp:/m);
    expect(readIf(rendering(B, '.agents'))).toMatch(/^x-instar-stamp:/m);
  });

  it('A retires it (archive first on A, canonical to retired/), pushes; B pulls and its tick archives B’s rendering byte-for-byte and removes it from discovery; A sees both archives after B pushes', async () => {
    const bBytes = fs.readFileSync(rendering(B, '.claude'));
    const r = await A.sentinel!.retireSkill(NAME, { reason: 'operator retire over the e2e' });
    expect(r).toMatchObject({ ok: true });
    expect(readIf(canonical(A))).toBeNull();
    expect(readIf(path.join(retiredDir(A), 'SKILL.md'))).toMatch(/instar-learned-state: "retired"/);
    expect(readIf(rendering(A, '.claude'))).toBeNull();
    expect(fs.existsSync(path.join(retiredDir(A), 'renderings', 'alpha', 'claude', 'SKILL.md'))).toBe(true);
    commitAndPush(A.root, 'chore: retire');
    git(B.root, ['pull', '-q', '--rebase', 'origin', 'main']);
    expect(readIf(canonical(B))).toBeNull();
    expect(readIf(path.join(retiredDir(B), 'SKILL.md'))).toMatch(/retired/);
    expect(readIf(rendering(B, '.claude'))).not.toBeNull(); // renderings never sync: still here until B's own tick
    const tick = await B.reconciler.reconcileAll('tick');
    expect(tick.retireArchived).toBe(2);
    expect(tick.retireBlocked).toBe(0);
    expect(readIf(rendering(B, '.claude'))).toBeNull();
    expect(readIf(rendering(B, '.agents'))).toBeNull();
    expect(fs.readFileSync(path.join(retiredDir(B), 'renderings', 'beta', 'claude', 'SKILL.md')).equals(bBytes)).toBe(true);
    expect(fs.existsSync(path.join(retiredDir(B), 'renderings', 'alpha', 'claude', 'SKILL.md'))).toBe(true); // A's archive, pulled
    // B's journal carries the archive moves prepare → commit (the protocol's row shape; recovery-complete).
    const journal = fs.readFileSync(path.join(B.stateDir, 'skill-learning', 'journal', 'beta.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(journal.filter((x: { detail?: string }) => String(x.detail ?? '').startsWith('archive-rendering:')).map((x: { op: string }) => x.op)).toEqual(['move-prepare', 'move-commit', 'move-prepare', 'move-commit']);
    // A second tick on B is idle; the retired skill is settled.
    expect((await B.reconciler.reconcileAll('tick')).retireArchived).toBe(0);
    commitAndPush(B.root, 'chore: archived rendering on beta');
    git(A.root, ['pull', '-q', '--rebase', 'origin', 'main']);
    expect(A.sentinel!.status().retired).toMatchObject([{ name: NAME, reason: 'operator retire over the e2e', renderingsArchived: { alpha: ['agents', 'claude'], beta: ['agents', 'claude'] } }]);
  });

  it('ALIVE: the production AgentServer on A serves GET /skills/learned with retired[], retireBlocked and lockLeftRendering through the real bearer gate', async () => {
    const AUTH = 'test-e2e-skill-learning-retire';
    const config: InstarConfig = {
      projectName: 'e2e', projectDir: A.root, stateDir: A.stateDir, port: 0, authToken: AUTH, dashboardPin: '135791',
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: { skillLearning: { enabled: true, mode: 'live' } }, updates: {},
      enabledFrameworks: ['claude-code', 'codex-cli'],
    } as InstarConfig;
    const server = new AgentServer({ config, sessionManager: { listRunningSessions: () => [], getSession: () => null } as never, state: new StateManager(A.stateDir), handshakeManager: new HandshakeManager(A.stateDir, 'e2e') });
    await server.start();
    try {
      server.setSkillLearningSentinel(A.sentinel);
      const app: express.Express = server.getApp();
      expect((await request(app).get('/skills/learned')).status).toBe(401);
      const res = await request(app).get('/skills/learned').set({ Authorization: `Bearer ${AUTH}` });
      expect(res.status).toBe(200);
      expect(res.body.retired).toMatchObject([{ name: NAME, kind: 'operator', by: 'operator' }]);
      expect(res.body.retireBlocked).toEqual([]);
      expect(res.body.lockLeftRendering).toEqual([]);
      expect(res.body.retireAll).toBeNull();
      expect(res.body.skills).toEqual([]);
      // The restore tap over the real PIN gate: no PIN is 403 (the route is wired), and nothing moved.
      const noPin = await request(app).post(`/skills/learned/${NAME}/restore`).set({ Authorization: `Bearer ${AUTH}` }).send({});
      expect(noPin.status).toBe(403);
      expect(readIf(path.join(retiredDir(A), 'SKILL.md'))).not.toBeNull();
    } finally {
      server.setSkillLearningSentinel(null);
      await server.stop();
    }
  });
});

describe('retire wiring — WIRED into the production server (dead-code guard)', () => {
  const wireSrc = fs.readFileSync(path.join(process.cwd(), 'src/monitoring/skillLearning/wire.ts'), 'utf-8');
  const serverSrc = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');
  const reconcilerSrc = fs.readFileSync(path.join(process.cwd(), 'src/monitoring/LearnedSkillReconciler.ts'), 'utf-8');

  it('wire.ts builds the Retirer on every machine, binds it to the reconciler, and hands it (plus harmRetired) to the sentinel', () => {
    expect(wireSrc).toContain('new Retirer({');
    expect(wireSrc).toContain('input.reconciler.setRetirer?.(retirer)');
    expect(wireSrc).toContain('retirer,');
    expect(wireSrc).toContain('harmRetired: () => retirer?.harmRetired() ?? []');
    expect(wireSrc.indexOf('new Retirer({')).toBeLessThan(wireSrc.indexOf('if (!config.enabled) return null;'));
  });

  it('server.ts hands EvolutionManager.addLearning into startSkillLearning (a retire for harm posts a learning)', () => {
    const start = serverSrc.indexOf('startSkillLearning({ reconciler: learnedSkillReconciler');
    const call = serverSrc.slice(start, serverSrc.indexOf('}, (deps) => SkillLearningSentinel.create(deps))', start));
    expect(call).toContain('addLearning: (learning) => evolution.addLearning(learning)');
  });

  it('the reconciler runs the retire sweep FIRST in every pass, under its mutex, and forgets the archived baselines', () => {
    const lock = reconcilerSrc.indexOf('return this.withLock(async () => {');
    const sweep = reconcilerSrc.indexOf('this.runRetireSweep(summary)');
    const list = reconcilerSrc.indexOf('const learned = this.listLearnedCanonicals();');
    expect(lock).toBeGreaterThan(0);
    expect(sweep).toBeGreaterThan(lock);
    expect(list).toBeGreaterThan(sweep);
    expect(reconcilerSrc).toContain('this.dropRels(sweep.forgottenRels)');
  });
});
