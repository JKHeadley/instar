/** The service against real git on a local fixture (docs/specs/ecosystem-idea-pipeline.md): cursor, stages, admission, launch, failure. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EcosystemLedger } from '../../src/ecosystem/EcosystemLedger.js';
import { EcosystemIdeaService, type AttentionNotice, type EcosystemIdeaServiceOptions } from '../../src/ecosystem/EcosystemIdeaService.js';
import { runAdmissionProbes } from '../../src/ecosystem/frameworkAdmission.js';
import { GitSourceSearch } from '../../src/ecosystem/sourceSearch.js';
import { orderFiles } from '../../src/ecosystem/projectFetch.js';
import { EpochFencedError } from '../../src/ecosystem/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { fakeSearch, gitIn, makeFixtureProject, scriptedCaller, GOOD_GOAL, PLANTED } from '../helpers/ecosystemFixture.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/ecosystem-idea-service.test.ts' }); });

function setup(over: Partial<EcosystemIdeaServiceOptions> = {}, fixtureRepo = 'o/project') {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'eco-svc-'));
  dirs.push(root);
  const marker = path.join(root, 'EXECUTED');
  const project = makeFixtureProject(root, marker);
  const dir = path.join(root, 'state');
  const ledger = new EcosystemLedger({ dir, machineId: () => 'm1' });
  ledger.append('watchlist-add', { repo: fixtureRepo, addedBy: 'test', reason: 't' }, 0);
  const notices: AttentionNotice[] = [];
  const closed: string[] = [];
  const started: Array<{ name: string; brief: string }> = [];
  const audit: Array<Record<string, unknown>> = [];
  let holder = true;
  let epoch = 0;
  const service = new EcosystemIdeaService({
    ledger, dir,
    seeds: [],
    callers: () => [scriptedCaller({ framework: 'fw-a' }), scriptedCaller({ framework: 'fw-b' })],
    frameworkVersion: async () => '1.0',
    search: fakeSearch(),
    purposeDoc: { repo: 'our/repo', file: 'purpose.md' },
    isHolder: () => holder,
    holderName: () => 'the-holder',
    epoch: () => epoch,
    quotaUsedPercent: async () => 10,
    raiseAttention: async (n) => { notices.push(n); },
    closeAttention: async (k) => { closed.push(k); },
    startSession: async (name, brief) => { started.push({ name, brief }); },
    sessionExists: async () => false,
    audit: (e) => audit.push(e),
    fetch: { testOnlyRepoUrl: (r) => (r === fixtureRepo ? `file://${project.dir}` : null), scratchRoot: root },
    ...over,
  });
  return { root, marker, project, dir, ledger, service, notices, closed, started, audit, setHolder: (v: boolean) => { holder = v; }, setEpoch: (v: number) => { epoch = v; } };
}

const onlyIdea = (s: ReturnType<typeof setup>) => [...s.ledger.state().ideas.values()][0];

describe('a review on a real clone', () => {
  it('finds the planted idea, reads no hostile effect, and leaves no clone behind', async () => {
    const s = setup();
    const run = await s.service.tick();
    expect(run?.stoppedBy).toBeNull();
    const idea = onlyIdea(s);
    expect(idea.sightings[0].claim).toMatch(/watchdog/);
    expect(idea.sightings[0].maturity).toBe('tested-in-their-code');
    expect(idea.stage).toBe('done');
    expect(idea.verdict).toBe('gap');
    expect(idea.goal?.goalFit).toBe('clear');
    expect(fs.existsSync(s.marker)).toBe(false);
    expect(fs.readdirSync(s.root).filter((f) => f.startsWith('instar-ecosystem-'))).toEqual([]);
  });

  it('checks evidence at the commit: a candidate citing nothing real is dropped and counted', async () => {
    const liar = { ...scriptedCaller({ framework: 'fw-a' }), call: async (_p: string, { label }: { label: string }) => {
      if (label.startsWith('probe-')) return 'NO-ACCESS';
      return JSON.stringify({ candidates: [{ claim: 'made up', evidence: [{ path: 'no/such/file.ts', startLine: 1, endLine: 2 }] }] });
    } };
    const s = setup({ callers: () => [liar] });
    const run = await s.service.tick();
    expect(run?.projects[0]).toMatchObject({ candidates: 0, dropped: 1 });
    expect(s.ledger.state().ideas.size).toBe(0);
  });

  it('proposes a named project but never adds it', async () => {
    const s = setup();
    await s.service.tick();
    expect(s.ledger.state().proposals.has('someone/similar')).toBe(true);
    expect(s.ledger.state().watchlist.has('someone/similar')).toBe(false);
  });
});

describe('the cursor', () => {
  it('knows "nothing new" from the remote head, and reviews a new commit by its diff', async () => {
    const calls: string[] = [];
    const s = setup({ callers: () => [scriptedCaller({ framework: 'fw-a', onCall: (l) => calls.push(l) }), scriptedCaller({ framework: 'fw-b' })] });
    await s.service.tick();
    const reviewed = s.ledger.state().cursors.get('o/project')!;
    expect(reviewed.reviewedCommit).toBe(s.project.head());
    expect(reviewed.targetCommit).toBeNull();
    s.ledger.append('cursor', { project: 'o/project', cursor: { nextDueAt: null } }, 0);
    calls.length = 0;
    const second = await s.service.tick();
    expect(second?.projects[0].outcome).toBe('nothing-new');
    expect(calls.filter((c) => c === 'candidates')).toEqual([]);
    s.project.commit('docs.md', '# Docs\nnothing here\n');
    s.ledger.append('cursor', { project: 'o/project', cursor: { nextDueAt: null } }, 0);
    const third = await s.service.tick();
    expect(third?.projects[0].filesRead).toBe(1); // only the changed file
    expect(s.ledger.state().cursors.get('o/project')!.reviewedCommit).toBe(s.project.head());
  });

  it('a vanished cursor commit falls back to a baseline review', async () => {
    const s = setup();
    s.ledger.append('cursor', { project: 'o/project', cursor: { reviewedCommit: 'f'.repeat(40) } }, 0);
    const run = await s.service.tick();
    expect(run?.projects[0].candidates).toBe(1);
    expect(s.audit.find((a) => a.event === 'project-start')).toMatchObject({ baseline: true });
  });

  it('a limit keeps its place: the commit does not advance, and the next run resumes', async () => {
    const s = setup({ limits: { tokensPerRun: 50 } });
    const run = await s.service.tick();
    expect(run?.stoppedBy).toBe('token-limit-run');
    const c = s.ledger.state().cursors.get('o/project')!;
    expect(c.reviewedCommit).toBeNull();
    expect(c.targetCommit).toBe(s.project.head());
  });

  it('an idea resumes at its stage after a stop mid-review', async () => {
    const calls: string[] = [];
    let stopAt: string | null = 'goal-review';
    const caller = scriptedCaller({ framework: 'fw-a', onCall: (l) => { calls.push(l); if (l === stopAt) { stopAt = null; throw new Error('model down'); } } });
    const s = setup({ callers: () => [caller, scriptedCaller({ framework: 'fw-b' })] });
    await s.service.tick();
    expect(onlyIdea(s).stage).toBe('gap-second');
    calls.length = 0;
    s.ledger.append('cursor', { project: 'o/project', cursor: { nextAttemptAt: null } }, 0);
    await s.service.tick();
    expect(onlyIdea(s).stage).toBe('done');
    expect(calls).not.toContain('gap-terms'); // the finished reads are not repeated
  });
});

describe('blind reads', () => {
  it('the second read never sees the first verdict or its terms, and does see the evidence', async () => {
    const seen: string[] = [];
    const a = scriptedCaller({ framework: 'fw-a', verdict: 'partial' });
    const b = scriptedCaller({ framework: 'fw-b', onCall: (l, p) => { if (l.startsWith('gap')) seen.push(p); } });
    const s = setup({ callers: () => [a, b] });
    await s.service.tick();
    expect(seen.length).toBeGreaterThan(0);
    for (const p of seen) { expect(p).not.toContain('partial:'); expect(p).toContain(PLANTED); }
  });
  it('disagreement leaves it unverified, and unranked, with no goal review', async () => {
    const s = setup({ callers: () => [scriptedCaller({ framework: 'fw-a', verdict: 'gap' }), scriptedCaller({ framework: 'fw-b', verdict: 'have-it' })] });
    await s.service.tick();
    const idea = onlyIdea(s);
    expect(idea.verdict).toBe('unverified');
    expect(idea.goal).toBeNull();
    expect(s.service.summary().ideas[0].band).toBe('unranked');
  });
  it('the higher class of two reads wins', async () => {
    const s = setup({ callers: () => [scriptedCaller({ framework: 'fw-a', effectClass: 'additive-dark' }), scriptedCaller({ framework: 'fw-b', effectClass: 'reduces-capability' })] });
    await s.service.tick();
    expect(onlyIdea(s).effectClass).toBe('reduces-capability');
    expect(s.service.summary().ideas[0].band).toBe('plan');
  });
  it('one admitted family: labelled single-family, and it cannot reach Now', async () => {
    const s = setup({ callers: () => [scriptedCaller({ framework: 'fw-a' })] });
    await s.service.tick();
    expect(onlyIdea(s).firstRead?.singleFamily).toBe(true);
    expect(s.service.summary().ideas[0].band).toBe('plan');
    expect(s.started).toEqual([]);
  });
  it('a word-only search cannot reach Now', async () => {
    const s = setup({ search: fakeSearch({ mode: 'word-only' }) });
    await s.service.tick();
    expect(onlyIdea(s).firstRead?.searchMode).toBe('word-only');
    expect(s.service.summary().ideas[0].band).toBe('plan');
  });
});

describe('framework admission', () => {
  it('admits a framework that cannot return the planted file', async () => {
    const r = await runAdmissionProbes(scriptedCaller(), '1', new Date().toISOString());
    expect(r.admitted).toBe(true);
  });
  it('refuses one that can, and one whose probe cannot run', async () => {
    expect((await runAdmissionProbes(scriptedCaller({ canReadFiles: true }), '1', new Date().toISOString())).admitted).toBe(false);
    const broken = await runAdmissionProbes(scriptedCaller({ failLabel: 'probe-capability' }), '1', new Date().toISOString());
    expect(broken.admitted).toBe(false);
    expect(broken.reason).toMatch(/could not run/);
  });
  it('capability alone is caught: a model that ignores the injection but can read still fails', async () => {
    const c = scriptedCaller();
    const caller = { ...c, call: async (p: string, o: { timeoutMs: number; label: string }) => {
      if (o.label === 'probe-injection') return 'A small tool.';
      const f = /(\/[^\s"\\]*planted-secret\.txt)/.exec(p)![1];
      return fs.readFileSync(f, 'utf-8');
    } };
    const r = await runAdmissionProbes(caller, '1', new Date().toISOString());
    expect(r.admitted).toBe(false);
    expect(r.reason).toMatch(/capability probe/);
  });
  it('with nothing admitted it reads nothing and says so', async () => {
    const calls: string[] = [];
    const s = setup({ callers: () => [scriptedCaller({ canReadFiles: true, onCall: (l) => calls.push(l) })] });
    const run = await s.service.tick();
    expect(run?.stoppedBy).toBe('no-admitted-framework');
    expect(calls.filter((c) => !c.startsWith('probe-'))).toEqual([]);
    expect(s.service.summary().admission[0].admitted).toBe(false);
  });
  it('probes once per CLI version, and again when it changes', async () => {
    const calls: string[] = [];
    let version = '1.0';
    const s = setup({ callers: () => [scriptedCaller({ framework: 'fw-a', onCall: (l) => calls.push(l) })], frameworkVersion: async () => version, cadenceHours: 0 });
    await s.service.tick();
    const first = calls.filter((c) => c.startsWith('probe-')).length;
    await s.service.tick();
    expect(calls.filter((c) => c.startsWith('probe-')).length).toBe(first);
    version = '2.0';
    await s.service.tick();
    expect(calls.filter((c) => c.startsWith('probe-')).length).toBe(first * 2);
  });
});

describe('authority', () => {
  it('a machine not holding the lease runs nothing', async () => {
    const s = setup();
    s.setHolder(false);
    expect(await s.service.tick()).toBeNull();
    expect(s.ledger.state().ideas.size).toBe(0);
  });
  it('a review that finishes after the lease moved writes nothing further', async () => {
    let holder = true;
    let epoch = 1;
    const caller = scriptedCaller({ framework: 'fw-a', onCall: (l) => { if (l === 'gap-terms') { holder = false; epoch = 2; } } });
    const s = setup({ callers: () => [caller, scriptedCaller({ framework: 'fw-b' })], isHolder: () => holder, epoch: () => epoch });
    await s.service.tick();
    expect(onlyIdea(s).stage).toBe('candidate');
    expect(onlyIdea(s).firstRead).toBeNull();
    expect(s.started).toEqual([]);
  });
  it('a dispatch re-checks the lease after its await', async () => {
    let holder = true;
    const started: string[] = [];
    const s = setup({ isHolder: () => holder, sessionExists: async () => { holder = false; return false; }, startSession: async (n) => { started.push(n); } });
    await s.service.tick();
    expect(started).toEqual([]);
  });
  it('an answer for a revision that changed while the model thought is dropped', async () => {
    let inject: (() => void) | null = null;
    const caller = scriptedCaller({ framework: 'fw-a', onCall: (l) => { if (l === 'goal-review') inject?.(); } });
    const s = setup({ callers: () => [caller, scriptedCaller({ framework: 'fw-b' })], agentStartsSpecs: false });
    inject = () => {
      inject = null;
      const idea = onlyIdea(s);
      s.ledger.append('sighting', { ideaId: idea.id, sighting: { ...idea.sightings[0], sightingId: 's-new', commit: 'newer' } }, 0);
    };
    await s.service.tick();
    const after = onlyIdea(s);
    expect(after.goal).toBeNull();
    expect(after.stage).not.toBe('done');
  });
  it('a failed review keeps its backoff, and continuing one does not reset the week', async () => {
    let now = Date.parse('2026-11-01T00:00:00Z');
    const calls: string[] = [];
    let fail = true;
    const caller = scriptedCaller({ framework: 'fw-a', onCall: (l) => { calls.push(l); if (l === 'gap-terms' && fail) throw new Error('model down'); } });
    const s = setup({ clock: () => now, callers: () => [caller, scriptedCaller({ framework: 'fw-b' })], agentStartsSpecs: false });
    await s.service.tick();
    expect(s.ledger.state().cursors.get('o/project')!.attempt).toBe(1);
    calls.length = 0;
    expect(await s.service.tick()).toBeNull(); // inside the backoff, so no review
    expect(calls).toEqual([]);
    fail = false;
    const before = s.ledger.state().cursors.get('o/project')!;
    now += 31 * 60_000;
    await s.service.tick();
    expect(onlyIdea(s).stage).toBe('done');
    expect(s.ledger.state().cursors.get('o/project')!.reviewedCommit).toBeTruthy();
    void before;
  });
  it('a cycle that used its attempts waits out the week, unfinished ideas included', async () => {
    let now = Date.parse('2026-11-01T00:00:00Z');
    const calls: string[] = [];
    let fail = false;
    const caller = scriptedCaller({ framework: 'fw-a', onCall: (l) => { calls.push(l); if (l === 'gap-terms' && fail) throw new Error('model down'); } });
    fail = true;
    const s = setup({ clock: () => now, callers: () => [caller, scriptedCaller({ framework: 'fw-b' })], agentStartsSpecs: false });
    await s.service.tick();
    now += 31 * 60_000; await s.service.tick();
    now += 3 * 60 * 60_000; await s.service.tick();
    expect(s.ledger.state().cursors.get('o/project')!.failedCycles).toBe(1);
    calls.length = 0;
    now += 60 * 60_000;
    expect(await s.service.tick()).toBeNull();
    expect(calls).toEqual([]);
  });
  it('a scan that hit its file limit carries on within the hour, not next week', async () => {
    let now = Date.parse('2026-11-01T00:00:00Z');
    const s = setup({ clock: () => now, limits: { filesPerRun: 1 }, agentStartsSpecs: false });
    s.project.commit('docs.md', '# more\n');
    await s.service.tick();
    const c = s.ledger.state().cursors.get('o/project')!;
    expect(c.targetCommit).toBeTruthy();
    expect(Date.parse(c.nextDueAt!) - now).toBe(3_600_000);
    expect(c.reviewedCommit).toBeNull();
    now += 2 * 3_600_000;
    await s.service.tick(); now += 2 * 3_600_000; await s.service.tick(); now += 2 * 3_600_000; await s.service.tick();
    expect(s.ledger.state().cursors.get('o/project')!.reviewedCommit).toBe(s.project.head());
  });
  it('a retry mid-week is not mistaken for a used-up cycle', async () => {
    let now = Date.parse('2026-11-01T00:00:00Z');
    let failOnce = false;
    const caller = scriptedCaller({ framework: 'fw-a', onCall: (l) => { if (l === 'goal-review' && failOnce) { failOnce = false; throw new Error('model down'); } } });
    const s = setup({ clock: () => now, callers: () => [caller, scriptedCaller({ framework: 'fw-b' })], agentStartsSpecs: false });
    s.ledger.append('cursor', { project: 'o/project', cursor: { nextDueAt: new Date(now + 7 * 86_400_000).toISOString(), reviewedCommit: s.project.head() } }, 0);
    const claim = { sightingId: 's0', project: 'o/project', commit: s.project.head(), claim: 'an idea', evidence: [{ path: 'README.md', startLine: 1, endLine: 1 }], excerpts: [], maturity: 'prose-only', ageDays: 90, at: new Date(now).toISOString() };
    s.ledger.append('sighting', { ideaId: 'idea-x', sighting: claim }, 0);
    failOnce = true;
    await s.service.tick();
    expect(s.ledger.state().ideas.get('idea-x')?.stage).toBe('gap-second');
    now += 31 * 60_000;
    await s.service.tick();
    expect(s.ledger.state().ideas.get('idea-x')?.stage).toBe('done');
  });
  it.each([['a decline', true], ['new evidence', false]])('%s during the lookup cancels an automatic launch', async (_name, viaDecline) => {
    const started: string[] = [];
    let once = true;
    const box: { s?: ReturnType<typeof setup> } = {};
    const s = setup({
      startSession: async (n) => { started.push(n); },
      sessionExists: async () => {
        if (once && box.s) {
          once = false;
          const idea = onlyIdea(box.s);
          if (viaDecline) box.s.service.recordDecision(idea.id, { action: 'decline', by: 'operator', ref: 'r' });
          else box.s.ledger.append('sighting', { ideaId: idea.id, sighting: { ...idea.sightings[0], sightingId: 's-late', commit: 'later' } }, 0);
        }
        return false;
      },
    });
    box.s = s;
    await s.service.tick();
    expect(started).toEqual([]);
    expect(onlyIdea(s).launchIntent).toBeNull();
    await s.service.housekeeping();
    expect(started).toEqual([]);
  });
  it('an old holder that keeps running cannot write', async () => {
    const s = setup();
    s.ledger.append('watchlist-add', { repo: 'x/y', addedBy: 't', reason: 't' }, 7);
    s.setEpoch(3);
    expect(() => s.service.addToWatchlist('z/z', 'r', 't')).toThrow(EpochFencedError);
    expect(s.ledger.state().watchlist.has('z/z')).toBe(false);
  });
});

describe('the agent starting a spec', () => {
  it('starts at most one, with a brief holding only ids', async () => {
    const s = setup();
    await s.service.tick();
    expect(s.started).toHaveLength(1);
    expect(s.started[0].brief).toContain(onlyIdea(s).id);
    expect(s.started[0].brief).not.toContain('watchdog');
    expect(s.started[0].brief).not.toContain(PLANTED);
    expect(onlyIdea(s).decisions[0]).toMatchObject({ action: 'start-spec', by: 'agent' });
    await s.service.housekeeping();
    expect(s.started).toHaveLength(1);
  });
  it('switched off, it only tells the operator', async () => {
    const s = setup({ agentStartsSpecs: false });
    await s.service.tick();
    expect(s.started).toEqual([]);
    expect(s.notices.map((n) => n.conditionKey)).toContain('ecosystem-ideas:decision');
  });
  it('a crash between the intent and the record starts no second session', async () => {
    let live = false;
    const started: string[] = [];
    let crash = true;
    const s = setup({
      sessionExists: async () => live,
      startSession: async (name) => { started.push(name); live = true; if (crash) { crash = false; throw new Error('died after starting'); } },
    });
    await s.service.tick().catch(() => null);
    const idea = onlyIdea(s);
    expect(idea.launchIntent?.recorded).toBe(false);
    expect(started).toHaveLength(1);
    await s.service.housekeeping();
    expect(started).toHaveLength(1); // it found the session running under the same name
    expect(onlyIdea(s).launchIntent?.recorded).toBe(true);
  });
  it('a session that may have finished is not started twice; it is left for the operator', async () => {
    const started: string[] = [];
    const s = setup({ sessionExists: async () => false, startSession: async (name) => { started.push(name); throw new Error('unknown outcome'); } });
    await s.service.tick();
    expect(started).toHaveLength(1);
    await s.service.housekeeping();
    await s.service.housekeeping();
    expect(started).toHaveLength(1);
    expect(s.audit.some((a) => a.event === 'launch-unconfirmed')).toBe(true);
    await s.service.operatorStartSpec(onlyIdea(s).id, 'pin').catch(() => undefined);
    expect(started).toHaveLength(2);
  });
  it('an unknown answer about a session starts nothing', async () => {
    const started: string[] = [];
    const s = setup({ sessionExists: async () => { throw new Error('tmux timed out'); }, startSession: async (n) => { started.push(n); } });
    await s.service.tick();
    expect(started).toEqual([]);
  });
  it('a lease move before dispatch starts nothing here; the new holder finishes it once', async () => {
    const s = setup({ sessionExists: async () => false });
    await s.service.tick();
    expect(s.started).toHaveLength(1);
    s.setHolder(false);
    await s.service.housekeeping();
    expect(s.started).toHaveLength(1);
  });
  it('an intent left by an old holder is finished under the same session name by the new one', async () => {
    const s = setup({ agentStartsSpecs: false });
    await s.service.tick();
    const idea = onlyIdea(s);
    s.ledger.append('launch-intent', { ideaId: idea.id, sessionName: 'ecosystem-spec-fixed', reason: 'r' }, 0);
    await s.service.housekeeping();
    expect(s.started.map((x) => x.name)).toEqual(['ecosystem-spec-fixed']);
    await s.service.housekeeping();
    expect(s.started).toHaveLength(1);
  });
});

describe('failure handling', () => {
  it('backs off, then opens a breaker after three failed cycles, and only then raises one item', async () => {
    let now = Date.parse('2026-11-01T00:00:00Z');
    const s = setup({ clock: () => now, fetch: { testOnlyRepoUrl: () => 'file:///no/such/repo', scratchRoot: os.tmpdir() } });
    const tickUntil = async () => { await s.service.tick(); return s.ledger.state().cursors.get('o/project')!; };
    let c = await tickUntil();
    expect(c.attempt).toBe(1);
    expect(Date.parse(c.nextAttemptAt!) - now).toBe(30 * 60_000);
    expect(s.notices).toEqual([]);
    now += 31 * 60_000;
    c = await tickUntil();
    expect(Date.parse(c.nextAttemptAt!) - now).toBe(2 * 60 * 60_000);
    now += 3 * 60 * 60_000;
    c = await tickUntil();
    expect(c.failedCycles).toBe(1);
    expect(s.notices).toEqual([]);
    for (let cycle = 0; cycle < 2; cycle++) {
      for (let attempt = 0; attempt < 3; attempt++) { now += 8 * 86_400_000; await tickUntil(); }
    }
    c = s.ledger.state().cursors.get('o/project')!;
    expect(c.failedCycles).toBe(3);
    expect(s.notices.filter((n) => n.conditionKey === 'ecosystem-ideas:stalled')).toHaveLength(1);
    now += 8 * 86_400_000;
    await tickUntil();
    expect(s.notices.filter((n) => n.conditionKey === 'ecosystem-ideas:stalled')).toHaveLength(1);
    s.service.retryProject('o/project');
    expect(s.service.summary().watchlist.find((w) => w.repo === 'o/project')?.stalled).toBe(false);
  });
  it('a never-run project reads as never-run, not stale', () => {
    const s = setup();
    expect(s.service.summary().neverRun).toBe(true);
    expect(s.service.summary().watchlist[0].lastCheckedAt).toBeNull();
  });
  it('pauses at the quota threshold and keeps its place', async () => {
    const s = setup({ quotaUsedPercent: async () => 80 });
    const run = await s.service.tick();
    expect(run?.stoppedBy).toMatch(/^quota-pause/);
    expect(s.ledger.state().ideas.size).toBe(0);
  });
  it('after eight quiet weeks one item asks what to do, and a Now idea clears it', async () => {
    let now = Date.parse('2026-01-01T00:00:00Z');
    const s = setup({ clock: () => now, callers: () => [scriptedCaller({ framework: 'fw-a' })] });
    await s.service.tick();
    await s.service.housekeeping();
    expect(s.notices.map((n) => n.conditionKey)).not.toContain('ecosystem-ideas:quiet');
    now += 57 * 86_400_000;
    await s.service.housekeeping();
    const quiet = s.notices.filter((n) => n.conditionKey === 'ecosystem-ideas:quiet');
    expect(quiet).toHaveLength(1);
    expect(quiet[0].summary).toMatch(/Keep it running/);
  });
});

describe('monthly audit', () => {
  it('samples what it stopped and counts an overturned verdict', async () => {
    let now = Date.parse('2026-02-01T00:00:00Z');
    let verdict = 'have-it';
    const mk = (fw: string) => { const c = scriptedCaller({ framework: fw }); return { ...c, call: async (p: string, o: { timeoutMs: number; label: string }) => {
      if (o.label === 'gap-classify') return JSON.stringify({ verdict, detail: 'd', citations: ['our/repo:src/a.ts:1'], effectClass: 'additive-dark' });
      return c.call(p, o);
    } }; };
    const s = setup({ clock: () => now, callers: () => [mk('fw-a'), mk('fw-b')] });
    await s.service.tick();
    expect(onlyIdea(s).verdict).toBe('have-it');
    verdict = 'gap';
    now += 31 * 86_400_000;
    await s.service.housekeeping();
    expect(onlyIdea(s).audit).toMatchObject({ overturned: true, verdict: 'gap' });
    expect(s.service.summary().funnel.overturnedInAudit).toBe(1);
  });
});

describe('source search on real git', () => {
  it('fixed-string search finds code and says word-only without embeddings; a term is never a pattern', async () => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'eco-src-'));
    dirs.push(root);
    const src = path.join(root, 'src-repo');
    fs.mkdirSync(path.join(src, 'src'), { recursive: true });
    fs.mkdirSync(path.join(src, 'docs/specs'), { recursive: true });
    fs.writeFileSync(path.join(src, 'src/watch.ts'), 'export const silentTurnRerun = 1; // a.*b\n');
    fs.writeFileSync(path.join(src, 'docs/specs/thing.md'), '# Thing\nreruns a silent turn\n');
    gitIn(src, 'init', '-q', '-b', 'main'); gitIn(src, 'add', '.'); gitIn(src, 'commit', '-qm', 'x');
    const search = new GitSourceSearch({ dir: path.join(root, 'state'), roots: [{ repo: 'our/repo' }], testOnlyRepoUrl: () => `file://${src}` });
    const commits = await search.refresh();
    expect(commits['our/repo']).toBe(gitIn(src, 'rev-parse', 'HEAD'));
    const hit = await search.search(['silentTurnRerun'], 'a claim');
    expect(hit.mode).toBe('word-only');
    expect(hit.results.some((r) => r.ref === 'our/repo:src/watch.ts:1')).toBe(true);
    const pattern = await search.search(['s.lentTurn'], 'x');
    expect(pattern.results.some((r) => r.ref.includes('src/watch.ts'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'state/index.db'))).toBe(true);
    expect((await search.readDoc('our/repo', 'docs/specs/thing.md', 100))?.text).toContain('Thing');
    search.close();
  }, 30_000);
});

describe('seeds', () => {
  it('the three named projects land once, on the holder only', () => {
    const s = setup({ seeds: undefined });
    s.setHolder(false);
    s.service.seedWatchlist();
    expect(s.ledger.state().watchlist.has('openclaw/openclaw')).toBe(false);
    s.setHolder(true);
    s.service.seedWatchlist();
    s.service.seedWatchlist();
    for (const repo of ['openclaw/openclaw', 'NousResearch/hermes-agent', 'mattabate/life-distributable']) expect(s.ledger.state().watchlist.get(repo)?.addedBy).toBe('seed');
  });
});

describe('file order', () => {
  it('reads changelog and readme first, skips lock files and vendored code, and a baseline skips code', () => {
    const files = ['src/a.ts', 'README.md', 'CHANGELOG.md', 'docs/x.md', 'package-lock.json', 'vendor/y.ts', 'logo.png'];
    expect(orderFiles(files, false)).toEqual(['CHANGELOG.md', 'README.md', 'docs/x.md', 'src/a.ts']);
    expect(orderFiles(files, true)).toEqual(['CHANGELOG.md', 'README.md', 'docs/x.md']);
  });
});

void vi; void GOOD_GOAL;
