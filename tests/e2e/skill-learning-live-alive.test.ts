// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 E2E "feature is alive" for the Skill Learning Sentinel in LIVE mode (docs/specs/skill-learning-sentinel.md
 * §3.5 pending/confirm, §8 "E2E (alive test)", slice 2):
 *
 *  1. ALIVE: the production AgentServer init path with the flag on and `mode: 'live'`, the sentinel started through
 *     the REAL `startSkillLearning` (wire.ts) — which builds the real WriterFence + VersionStore + CommitProtocol over
 *     the real LearnedSkillReconciler and runs the commit journal's recovery before releasing the reconciler's boot
 *     gate — bound through `setSkillLearningSentinel()`: `GET /skills/learned` is 200 with `pending: []`.
 *  2. The scripted replay (the 3/2/2 fixture history with stub model families, as the slice-1 proposal test seeds
 *     it) yields EXACTLY one pending skill; the operator's confirm tap with the real PIN gate yields EXACTLY one
 *     rendered skill under `.claude/skills`.
 *  3. WIRED (source-level): server.ts hands non-null fence deps into `startSkillLearning({...})`, constructs the
 *     reconciler with `holdUntilReleased: true`, and runs the boot reconcile AFTER that call; wire.ts recovers the
 *     journal and releases the gate only when recovery settles — proved live too: a held reconciler's boot pass does
 *     not run until `startSkillLearning` has recovered the journal.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { HandshakeManager } from '../../src/threadline/HandshakeManager.js';
import { LearnedSkillReconciler } from '../../src/monitoring/LearnedSkillReconciler.js';
import { SkillLearningSentinel } from '../../src/monitoring/SkillLearningSentinel.js';
import { startSkillLearning, resolveSkillLearningConfig } from '../../src/monitoring/skillLearning/wire.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import type { FamilyProvider } from '../../src/monitoring/skillLearning/Drafter.js';
import type { EventRow, LedgerReader, LedgerRow, LedgerWriter, OutcomeRow, RequestRow, VerdictRow } from '../../src/monitoring/skillLearning/types.js';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const DAY = 86_400_000;
const NAME = 'ci-health-report';
const TMP = process.env.TMPDIR ?? os.tmpdir();

class FixtureLedger implements LedgerReader, LedgerWriter {
  rows: LedgerRow[] = [];
  append(row: LedgerRow): void { this.rows.push(row); }
  requestsForKey(k: string): RequestRow[] { return this.rows.filter((r): r is RequestRow => r.kind === 'request' && r.procedureKey === k).sort((a, b) => b.at.localeCompare(a.at)); }
  outcomesForKey(k: string): OutcomeRow[] {
    const byRun = new Map<string, OutcomeRow>();
    for (const r of this.rows) if (r.kind === 'outcome' && r.procedureKey === k) { const c = byRun.get(r.runId); if (!c || r.revision > c.revision) byRun.set(r.runId, r); }
    return [...byRun.values()];
  }
  verdictsForKey(k: string): VerdictRow[] {
    const latest = new Map<string, VerdictRow>();
    for (const r of this.rows) if (r.kind === 'verdict' && r.procedureKey === k) { const c = latest.get(r.by); if (!c || r.at >= c.at) latest.set(r.by, r); }
    return [...latest.values()];
  }
  eventsForKey(k: string): EventRow[] { return this.rows.filter((r): r is EventRow => r.kind === 'event' && r.procedureKey === k); }
  keys() {
    const m = new Map<string, { procedureKey: string; requests: number; verifiedRequests: number; lastAt: string }>();
    for (const r of this.rows) {
      if (r.kind !== 'request' || !r.procedureKey) continue;
      const e = m.get(r.procedureKey) ?? { procedureKey: r.procedureKey, requests: 0, verifiedRequests: 0, lastAt: '' };
      e.requests++; if (r.identity === 'verified') e.verifiedRequests++; if (r.at > e.lastAt) e.lastAt = r.at; m.set(r.procedureKey, e);
    }
    return [...m.values()];
  }
  pendingCount(): number { return 0; }
}

const SKILL_MD = [
  '---', `name: ${NAME}`,
  'description: "Use when the operator asks for the weekly CI health of the instar repo. Not for deploy status."',
  'metadata:', '  short-description: "CI health, weekly"', '---',
  '# CI health report', '', '1. Read the CI health route at /ci/health.', '2. Summarise failing jobs and the slowest runs in plain language.', '',
].join('\n');

/** The replay seed: three verified occurrences on distinct days + sessions, each accepted, with the agent's own tool call in the transcript. */
function seed(root: string, machineId: string) {
  const ledger = new FixtureLedger();
  const transcripts = new Map<string, string>();
  for (let i = 0; i < 3; i++) {
    const at = NOW - (i + 1) * DAY; const session = `sess-${i}`;
    ledger.append({ kind: 'request', eventId: `req-${i}`, source: { channel: 'telegram', chatId: '-100', messageId: String(1180 + i) }, topicId: '42', sessionName: session, at: new Date(at).toISOString(), channel: 'telegram', identity: 'verified', state: 'classified', procedureKey: 'ci-health', paraphrase: 'weekly CI health', repeatable: true, runId: `run-${i}`, machineId });
    ledger.append({ kind: 'outcome', eventId: `out-${i}`, runId: `run-${i}`, revision: 1, procedureKey: 'ci-health', topicId: '42', sessionName: session, label: 'accepted', provisional: false, windowStart: new Date(at).toISOString(), windowEnd: new Date(at + 3600_000).toISOString(), at: new Date(at + 3600_000).toISOString(), machineId });
    const file = path.join(root, `${session}.jsonl`);
    fs.writeFileSync(file, `${JSON.stringify({ type: 'assistant', timestamp: new Date(at + 1000).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'curl http://localhost:4040/ci/health' } }] } })}\n`);
    transcripts.set(session, file);
  }
  const providers: FamilyProvider[] = [{ family: 'anthropic', framework: 'claude-code' }, { family: 'openai', framework: 'codex-cli' }].map((f) => ({
    family: f.family, framework: f.framework,
    evaluate: async (prompt) => {
      if (prompt.startsWith('You are the skill-learning arbiter')) return '{"verdict":"draft","reason":"fixture"}';
      if (prompt.startsWith('You are drafting a reusable skill')) return `NEW\n${SKILL_MD}`;
      if (prompt.startsWith('You are the independent reviewer')) return '{"follows":true,"lines":{},"cost":"accept","reason":"grounded"}';
      throw new Error('unexpected prompt');
    },
  }));
  return { ledger, transcripts, providers };
}

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

const skillsUnder = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, 'SKILL.md'))).sort() : []);

describe('skill-learning LIVE E2E lifecycle (feature is alive on the production init path)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  let sentinel: SkillLearningSentinel | null = null;
  let reconciler: LearnedSkillReconciler;
  const AUTH = 'test-e2e-skill-learning-live';
  const PIN = '135791';
  const machineId = os.hostname();

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(TMP, 'skill-learning-live-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E', monitoring: { skillLearning: { enabled: true, mode: 'live' } } }));
    const config: InstarConfig = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH, dashboardPin: PIN,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: { skillLearning: { enabled: true, mode: 'live' } }, updates: {},
      enabledFrameworks: ['claude-code', 'codex-cli'],
    } as InstarConfig;
    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as any,
      state: new StateManager(stateDir),
      handshakeManager: new HandshakeManager(stateDir, 'e2e'),
    });
    await server.start();
    app = server.getApp();

    // The production wiring, with the same reconciler shape server.ts constructs (boot gate held until recovery).
    reconciler = new LearnedSkillReconciler({ projectDir: tmpDir, stateDir, machineId, enabledFrameworks: () => ['claude-code', 'codex-cli'], holdUntilReleased: true, now: () => NOW });
    const { ledger, transcripts, providers } = seed(tmpDir, machineId);
    sentinel = startSkillLearning({
      reconciler, rawConfig: config, projectDir: tmpDir, stateDir, machineId,
      sharedIntelligence: null, topicMemory: null, operatorStore: () => null, provenance: () => null,
    }, (deps) => new SkillLearningSentinel({
      // The real sentinel over the real commit stack wire.ts built; the fixture ledger + stub families replace the network.
      config: deps.config, stateDir: deps.stateDir, projectDir: deps.projectDir, machineId: deps.machineId,
      ledger, families: () => providers,
      transcriptPath: (run) => (run.sessionName && transcripts.get(run.sessionName)) ?? null,
      operatorMessage: (src) => `weekly CI health of the instar repo please (msg ${src.messageId})`,
      provenance: { recordDecision: () => 'jp-e2e', isRecordingLive: () => true },
      commitProtocol: deps.commitProtocol ?? null, mode: () => 'live', rungTwoProven: () => false,
      now: () => NOW,
    }));
    server.setSkillLearningSentinel(sentinel);
  });

  afterAll(async () => {
    server.setSkillLearningSentinel(null);
    sentinel?.stop();
    reconciler.stop();
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/skill-learning-live-alive.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('startSkillLearning built the sentinel over a real commit protocol (not null, not a stub) in live mode', () => {
    expect(sentinel).not.toBeNull();
    expect(resolveSkillLearningConfig({ monitoring: { skillLearning: { enabled: true, mode: 'live' } } }).mode).toBe('live');
    expect(sentinel!.status()).toMatchObject({ enabled: true, mode: 'live' });
  });

  it('flag on + mode live: GET /skills/learned is 200 with pending: [] through the real bearer gate (401 without it)', async () => {
    expect((await request(app).get('/skills/learned')).status).toBe(401);
    const res = await request(app).get('/skills/learned').set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, mode: 'live', pending: [] });
    expect(Array.isArray(res.body.skills)).toBe(true);
    expect(Array.isArray(res.body.proposals)).toBe(true);
    expect(typeof res.body.machine).toBe('string');
    expect(skillsUnder(path.join(tmpDir, '.claude', 'skills'))).toEqual([]);
  });

  it('the scripted replay yields EXACTLY one pending skill: listed by the route, canonical on disk, nothing rendered', async () => {
    const s1 = await sentinel!.tick();
    const s2 = await sentinel!.tick();
    expect(s1.drafted + s2.drafted).toBe(1);
    const res = await request(app).get('/skills/learned').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.pending).toHaveLength(1);
    expect(res.body.pending[0]).toMatchObject({ name: NAME, pendingReason: 'rung-unproven', version: 1 });
    expect(res.body.pending[0].paraphrases).toEqual(['weekly CI health']);
    expect(fs.readFileSync(path.join(tmpDir, '.instar', 'skills', NAME, 'SKILL.md'), 'utf-8')).toMatch(/instar-learned-state: "?pending"?/);
    expect(skillsUnder(path.join(tmpDir, '.claude', 'skills'))).toEqual([]);
    expect(skillsUnder(path.join(tmpDir, '.agents', 'skills'))).toEqual([]);
    expect(fs.existsSync(path.join(stateDir, 'skill-learning', 'proposals', NAME))).toBe(false);
  });

  it('the confirm tap runs the real operator-PIN gate (403 without a PIN) and then yields EXACTLY one rendered skill under .claude/skills', async () => {
    const noPin = await request(app).post(`/skills/learned/pending/${NAME}/confirm`).set(auth()).send({});
    expect(noPin.status).toBe(403);
    expect(noPin.body.error).toContain('Operator PIN required');
    expect(skillsUnder(path.join(tmpDir, '.claude', 'skills'))).toEqual([]);
    const ok = await request(app).post(`/skills/learned/pending/${NAME}/confirm`).set(auth()).send({ pin: PIN });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, name: NAME, action: 'confirm' });
    expect(skillsUnder(path.join(tmpDir, '.claude', 'skills'))).toEqual([NAME]);
    expect(skillsUnder(path.join(tmpDir, '.agents', 'skills'))).toEqual([NAME]);
    const rendered = fs.readFileSync(path.join(tmpDir, '.claude', 'skills', NAME, 'SKILL.md'), 'utf-8');
    expect(rendered).toMatch(/^x-instar-stamp:\s*[a-f0-9]{64}\s*$/m);
    expect(rendered).toContain('1. Read the CI health route at /ci/health.');
    const after = await request(app).get('/skills/learned').set(auth());
    expect(after.body.pending).toEqual([]);
    expect(after.body.skills.map((s: { name: string }) => s.name)).toEqual([NAME]);
    // The commit journal names the confirm from prepare to commit; the version store holds v1 (pending) and v2 (active).
    const journal = fs.readFileSync(path.join(stateDir, 'skill-learning', 'journal', `${machineId}.jsonl`), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(journal.filter((r) => r.commitOp === 'confirm').map((r) => r.op)).toEqual(['commit-prepare', 'commit']);
    const versions = fs.readFileSync(path.join(stateDir, 'skill-learning', 'versions', NAME, `${machineId}.jsonl`), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(versions.map((v) => [v.version, v.op, v.state])).toEqual([[1, 'create', 'pending'], [2, 'confirm', 'active']]);
  });
});

describe('journal recovery runs BEFORE the reconciler boot pass (live, through the real wire.ts)', () => {
  it('a reconciler held with holdUntilReleased does not run its boot pass until startSkillLearning has recovered the journal and released the gate', async () => {
    const root = fs.mkdtempSync(path.join(TMP, 'skill-learning-gate-'));
    const stateDir = path.join(root, '.instar');
    try {
      fs.mkdirSync(path.join(stateDir, 'skills', 'weekly-ci-health'), { recursive: true });
      fs.writeFileSync(path.join(stateDir, 'skills', 'weekly-ci-health', 'SKILL.md'), '---\nname: weekly-ci-health\ndescription: "Use when the operator asks for the weekly CI health."\nmetadata:\n  instar-learned-origin: "skill-learning-sentinel"\n  instar-learned-state: "active"\n---\n# Weekly CI health\n');
      const held = new LearnedSkillReconciler({ projectDir: root, stateDir, machineId: 'gate-m', enabledFrameworks: () => ['claude-code'], holdUntilReleased: true });
      let settled = false;
      const boot = held.reconcileAll('boot').then((r) => { settled = true; return r; });
      await new Promise((r) => setTimeout(r, 50));
      expect(settled).toBe(false); // the gate holds the boot pass
      expect(fs.existsSync(path.join(root, '.claude', 'skills', 'weekly-ci-health', 'SKILL.md'))).toBe(false);
      const out = startSkillLearning({
        reconciler: held, rawConfig: { monitoring: { skillLearning: { enabled: false } } }, projectDir: root, stateDir, machineId: 'gate-m',
        sharedIntelligence: null, topicMemory: null, operatorStore: () => null, provenance: () => null,
      }, () => { throw new Error('the sentinel is not built when the flag is off'); });
      expect(out).toBeNull(); // flag off: no sentinel — but the commit stack, its recovery and the gate release still ran
      const run = await boot;
      expect(settled).toBe(true);
      expect(run.rendered).toBe(1);
      expect(fs.existsSync(path.join(root, '.claude', 'skills', 'weekly-ci-health', 'SKILL.md'))).toBe(true);
      held.stop();
    } finally {
      SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/e2e/skill-learning-live-alive.test.ts' });
    }
  });
});

describe('skill-learning live write path — WIRED into the production server (dead-code guard)', () => {
  const serverSrc = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');
  const wireSrc = fs.readFileSync(path.join(process.cwd(), 'src/monitoring/skillLearning/wire.ts'), 'utf-8');

  it('server.ts passes non-null fence deps into startSkillLearning({...}) — every WriterFence input is a live reader, none a constant', () => {
    const start = serverSrc.indexOf('startSkillLearning({ reconciler: learnedSkillReconciler, fence: {');
    expect(start).toBeGreaterThan(0);
    const call = serverSrc.slice(start, serverSrc.indexOf('}, (deps) => SkillLearningSentinel.create(deps))', start));
    for (const key of ['hasCoordinator', 'holdsLease', 'currentEpoch', 'leaseMediumLocal', 'pullRebase', 'hasRemote', 'isGitRepo']) {
      expect(call, key).toMatch(new RegExp(`${key}: \\(\\) =>`));
    }
    expect(call).toContain('leaseCoordinatorRef');
    expect(call).toContain('gitSyncRef');
    expect(call).toContain('gitLeaseHasNoRemote(config.projectDir)');
    expect(call).not.toMatch(/fence: (null|undefined)/);
  });

  it('server.ts constructs the reconciler with holdUntilReleased: true and runs the boot reconcile AFTER startSkillLearning (recovery first)', () => {
    const ctor = serverSrc.indexOf('const learnedSkillReconciler = new LearnedSkillReconciler({');
    expect(ctor).toBeGreaterThan(0);
    expect(serverSrc.slice(ctor, ctor + 1200)).toContain('holdUntilReleased: true');
    const start = serverSrc.indexOf('startSkillLearning({ reconciler: learnedSkillReconciler');
    const boot = serverSrc.indexOf("learnedSkillReconciler.reconcileAll('boot')");
    expect(start).toBeGreaterThan(ctor);
    expect(boot).toBeGreaterThan(start);
  });

  it('wire.ts recovers this machine’s own journal and releases the boot gate only when recovery settles', () => {
    const recover = wireSrc.indexOf('stack.protocol.recoverOwnJournal()');
    const release = wireSrc.indexOf('input.reconciler.releaseBootGate?.()');
    expect(recover).toBeGreaterThan(0);
    expect(release).toBeGreaterThan(recover);
    expect(wireSrc.slice(recover, release)).toContain('.finally(');
    expect(wireSrc).toContain('commitProtocol: stack?.protocol ?? null');
  });
});
