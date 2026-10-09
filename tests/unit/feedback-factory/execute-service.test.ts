/**
 * FeedbackExecutorService (docs/specs/feedback-triage-and-execution.md §4) over the real drain,
 * triage and execute stores and a real InitiativeTracker; git, GitHub, the sandbox runtime and
 * sessions are scripted at their boundaries. Every decision boundary is exercised on both sides.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BASE_SHA, HEAD_SHA, createExecHarness, finishSessions, isBaseState, type ExecHarness } from '../../fixtures/feedbackExecuteHarness.js';
import { DrainConflictError } from '../../../src/feedback-factory/drain/FeedbackDrainStore.js';
import { EVIDENCE_FILE, RESULT_FILE } from '../../../src/feedback-factory/execute/executePolicy.js';

const DAY = 24 * 60 * 60_000;
let h: ExecHarness;
afterEach(() => h?.cleanup());

async function startOne(id = 'c1', o: { needsSpec?: boolean; userFacing?: boolean; reports?: number } = {}) {
  const initiativeId = await h.workItem(id, o);
  h.fixWith({ 'src/thing.ts': 'export const thing = 2;\n', 'tests/fix.test.ts': "import { it } from 'vitest';\nit('fixes it', () => {});\n" });
  const t = await h.exec.tick();
  return { initiativeId, t };
}

async function toPrOpen(id = 'c1') {
  const { initiativeId } = await startOne(id);
  finishSessions(h);
  h.now.value += 60_000;
  await h.exec.tick();
  const row = h.execStore.latestFor(initiativeId)!;
  return { initiativeId, row };
}

describe('availability and refusal', () => {
  it('refuses to run when the agent itself could act as the approver; a PIN-bound acceptance lets it run', async () => {
    h = await createExecHarness();
    h.repo.viewer = 'owner'; // the agent's own GitHub login IS the repository owner (case-insensitive)
    const refused = await h.exec.refreshAvailability();
    expect(refused).toMatchObject({ available: false, reason: 'approver-not-independent', approver: 'Owner' });
    expect(refused.independence?.reasons).toContain('agent-github-login');
    const plan = h.exec.planApproverAcceptance();
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.renderedText).toMatch(/Accepted risk, by name/);
    if (!plan.ok) return;
    h.exec.setApproverAcceptance('Owner', plan.reasons, 'dashboard-pin:test');
    expect(await h.exec.refreshAvailability()).toMatchObject({ available: true, reason: 'ok' });
    // A strictly different condition (now also a browser-profile account) needs a NEW acceptance.
    h.identity.profileAccounts = [{ service: 'github', identity: 'Owner', vaultRefs: [] }];
    expect((await h.exec.refreshAvailability()).reason).toBe('approver-not-independent');
    // Removing the evidence again (a Bearer-only registry edit can do that) does NOT restore it: dependence is sticky.
    h.identity.profileAccounts = [];
    const sticky = await h.exec.refreshAvailability();
    expect(sticky.reason).toBe('approver-not-independent');
    expect(sticky.independence?.reasons).toEqual(['agent-github-login', 'browser-profile-account']);
    const plan2 = h.exec.planApproverAcceptance();
    if (!plan2.ok) throw new Error('expected a plan');
    h.exec.setApproverAcceptance('Owner', plan2.reasons, 'dashboard-pin:test-2');
    expect((await h.exec.refreshAvailability()).reason).toBe('ok');
    // Revoking (no PIN needed: it reduces authority) puts it back to waiting.
    expect(h.exec.revokeApproverAcceptance('test')).toBe(true);
    expect((await h.exec.refreshAvailability()).reason).toBe('approver-not-independent');
    // An acceptance for a different login never applies.
    h.exec.setApproverAcceptance('someone-else', plan.reasons, 'dashboard-pin:test2');
    expect((await h.exec.refreshAvailability()).reason).toBe('approver-not-independent');
  });

  it('a browser-profile account, an owned identity, a tagged vault entry or an unreadable registry for the approver also makes it dependent', async () => {
    h = await createExecHarness();
    expect((await h.exec.refreshAvailability()).reason).toBe('ok');
    h.identity.profileAccounts = [{ service: 'github', identity: 'OWNER', vaultRefs: ['gh_owner_token'] }];
    const a = await h.exec.refreshAvailability();
    expect(a.reason).toBe('approver-not-independent');
    expect(a.independence?.reasons).toEqual(expect.arrayContaining(['browser-profile-account', 'tagged-vault-entry']));
    h.cleanup();
    h = await createExecHarness();
    h.identity.ownedIdentities = [{ service: 'github', identity: 'owner' }];
    expect((await h.exec.refreshAvailability()).independence?.reasons).toContain('owned-identity');
    h.cleanup();
    h = await createExecHarness();
    (h.identity as { unreadableSources?: string[] }).unreadableSources = ['playwright-profiles'];
    (h.exec as unknown as { opts: { identityFacts: () => unknown } }).opts.identityFacts = () => ({ ...h.identity, vaultNames: null });
    expect((await h.exec.refreshAvailability()).independence?.reasons).toContain('identity-registry-unreadable');
  });

  it('an unreadable agent login is not independence', async () => {
    h = await createExecHarness();
    h.repo.viewer = null;
    expect((await h.exec.refreshAvailability()).reason).toBe('approver-not-independent');
  });

  it('auto-merge disabled, organization without an approver, no source repo, disabled, sandbox missing', async () => {
    h = await createExecHarness();
    h.repo.info = { ownerLogin: 'Owner', ownerType: 'User', allowAutoMerge: false };
    expect((await h.exec.refreshAvailability()).reason).toBe('auto-merge-disabled');
    h.repo.info = { ownerLogin: 'org', ownerType: 'Organization', allowAutoMerge: true };
    expect((await h.exec.refreshAvailability()).reason).toBe('approver-unset');
    h.repo.info = { ownerLogin: 'Owner', ownerType: 'User', allowAutoMerge: true };
    h.runnerAvailable.value = false;
    expect((await h.exec.refreshAvailability()).reason).toBe('profile-unenforceable');
    h.runnerAvailable.value = true;
    h.cfg.sourceRepoPath = null;
    expect((await h.exec.refreshAvailability()).reason).toBe('no-source-repo');
    h.cfg.sourceRepoPath = h.sourceRepo;
    h.enabled.value = false;
    expect((await h.exec.refreshAvailability()).reason).toBe('disabled');
    expect(h.exec.status()).toEqual({ available: false, reason: 'disabled' });
  });

  it('dry-run records what it would start and starts nothing', async () => {
    h = await createExecHarness({ config: { dryRun: true } });
    await h.workItem('c1');
    const t = await h.exec.tick();
    expect(t.started).toBe(0);
    expect(h.execStore.all()).toHaveLength(0);
    expect(h.sessions.spawned).toHaveLength(0);
    expect(h.exec.summary().wouldStart).toMatchObject({ candidates: 1 });
    expect(h.exec.status()).toEqual({ available: false, reason: 'dry-run' });
  });
});

describe('admission (enforced in the executor\'s own code)', () => {
  for (const [name, set] of [
    ['spawn limiter saturated', (x: ExecHarness) => { x.admission.saturated = true; }],
    ['quota shedding', (x: ExecHarness) => { x.admission.shedding = true; }],
    ['an agent update pending', (x: ExecHarness) => { x.admission.updatePending = true; }],
    ['maxConcurrent 0', (x: ExecHarness) => { x.cfg.maxConcurrent = 0; }],
    ['maxStartsPerDay 0', (x: ExecHarness) => { x.cfg.maxStartsPerDay = 0; }],
    ['maxOpenPrs 0', (x: ExecHarness) => { x.cfg.maxOpenPrs = 0; }],
  ] as const) {
    it(`no start when ${name}; a start once it clears`, async () => {
      h = await createExecHarness();
      await h.workItem('c1');
      set(h);
      expect((await h.exec.tick()).started).toBe(0);
      expect(h.sessions.spawned).toHaveLength(0);
      h.admission = { saturated: false, shedding: false, updatePending: false };
      h.cfg.maxConcurrent = 2; h.cfg.maxStartsPerDay = 6; h.cfg.maxOpenPrs = 4;
      h.fixWith({ 'src/thing.ts': 'x' });
      h.now.value += 60_000;
      expect((await h.exec.tick()).started).toBe(1);
    });
  }

  it('maxConcurrent caps live attempts across items', async () => {
    h = await createExecHarness({ config: { maxConcurrent: 1 } });
    await h.workItem('c1');
    await h.workItem('c2');
    h.fixWith({ 'src/thing.ts': 'x' });
    expect((await h.exec.tick()).started).toBe(1);
    expect(h.execStore.liveCount()).toBe(1);
  });
});

describe('claim (CAS, epoch fenced, lease)', () => {
  it('a second claim for an item with a live attempt is refused; a stale epoch is refused', async () => {
    h = await createExecHarness();
    const id = await h.workItem('c1');
    const row = h.execStore.claim(1, { initiativeId: id, clusterId: 'c1', needsSpec: false, userFacing: false, leaseMs: 1000, maxStartsPerDay: 6 });
    expect(row?.attempt).toBe(1);
    expect(h.execStore.claim(1, { initiativeId: id, clusterId: 'c1', needsSpec: false, userFacing: false, leaseMs: 1000, maxStartsPerDay: 6 })).toBeNull();
    h.execStore.claim(2, { initiativeId: 'other', clusterId: 'cx', needsSpec: false, userFacing: false, leaseMs: 1000, maxStartsPerDay: 6 });
    expect(() => h.execStore.claim(1, { initiativeId: 'third', clusterId: 'cy', needsSpec: false, userFacing: false, leaseMs: 1000, maxStartsPerDay: 6 })).toThrow(DrainConflictError);
  });

  it('an attempt claimed by ANOTHER machine under an older epoch is stopped (remote-close); this machine\'s own live attempt is adopted', async () => {
    h = await createExecHarness();
    const own = await startOne();
    h.epoch.value = 2;
    h.now.value += 60_000;
    await h.exec.tick();
    expect(h.execStore.latestFor(own.initiativeId)).toMatchObject({ state: 'running', ownerEpoch: 2 });
    expect(h.sessions.stopped).toHaveLength(0);
    h.cleanup();
    h = await createExecHarness();
    const { initiativeId } = await startOne();
    const row = h.execStore.latestFor(initiativeId)!;
    h.drain.sharedDatabase().prepare("UPDATE execution SET session_machine='m2' WHERE attempt_id=?").run(row.attemptId);
    expect(h.execStore.latestFor(initiativeId)!.state).toBe('running');
    h.epoch.value = 2;
    h.now.value += 60_000;
    await h.exec.tick();
    expect(h.sessions.remoteStops).toContainEqual({ machine: 'm2', name: row.sessionName });
    const attempts = h.execStore.attemptsFor(initiativeId);
    expect(attempts[0]).toMatchObject({ state: 'stopped', reason: 'stale-epoch' });
  });

  it('a session past its 6 h lease is stopped and the attempt fails with the limit named', async () => {
    h = await createExecHarness();
    const { initiativeId } = await startOne();
    h.now.value += 6 * 60 * 60_000 + 1;
    await h.exec.tick();
    expect(h.execStore.attemptsFor(initiativeId)[0]).toMatchObject({ state: 'failed', reason: 'limit:session-wall-clock' });
  });
});

describe('workspaces and the confined spawn', () => {
  it('creates two clones at the base SHA, strips .claude/, links node_modules, writes read-only evidence, and spawns with the confinement settings', async () => {
    h = await createExecHarness();
    const { initiativeId } = await startOne();
    const row = h.execStore.latestFor(initiativeId)!;
    expect(row).toMatchObject({ state: 'running', baseSha: BASE_SHA, attempt: 1 });
    expect(fs.existsSync(path.join(row.workspace!, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(row.publishClone!, '.claude'))).toBe(true);
    expect(fs.lstatSync(path.join(row.workspace!, 'node_modules')).isSymbolicLink()).toBe(true);
    const evidence = path.join(row.workspace!, EVIDENCE_FILE);
    expect(fs.statSync(evidence).mode & 0o222).toBe(0);
    expect(JSON.parse(fs.readFileSync(evidence, 'utf8'))).toMatchObject({ untrusted: true, clusterId: 'c1' });
    const build = h.sessions.spawned.find((s) => !s.name.startsWith('feedback-canary-'))!;
    expect(build.cwd).toBe(row.workspace);
    // The prompt carries ids, summary and brief — never report text.
    expect(build.prompt).toContain('summary for c1');
    expect(build.prompt).not.toContain('report 0 body');
    const settings = JSON.parse(fs.readFileSync(build.settingsPath!, 'utf8'));
    expect(settings.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
    expect(settings.permissions.defaultMode).toBe('dontAsk');
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch', 'mcp__*']));
    // The runner canary ran its must-fail probes before the session canary and the build session.
    expect(h.runs.some((r) => /cat /.test(r.command))).toBe(true);
    expect(h.sessions.spawned[0].name.startsWith('feedback-canary-')).toBe(true);
  });

  it('a failed canary probe stops the attempt as profile-unenforceable, raises one Attention item and spawns no build session', async () => {
    h = await createExecHarness();
    await h.workItem('c1');
    h.runScript.fn = (cmd) => (/^cat /.test(cmd.command) ? { exitCode: 0, stdout: 'leaked' } : null);
    await h.exec.tick();
    const row = h.execStore.all()[0];
    expect(row).toMatchObject({ state: 'stopped', reason: 'profile-unenforceable' });
    expect(h.sessions.spawned).toHaveLength(0);
    expect(h.attentionExec.filter((a) => a.id.startsWith('feedback-execute:profile-unenforceable'))).toHaveLength(1);
    expect((await h.exec.refreshAvailability()).reason).toBe('profile-unenforceable');
    // The latch clears after 24 h and the next attempt re-runs the canary.
    h.runScript.fn = () => null;
    h.now.value += 25 * 60 * 60_000;
    h.fixWith({ 'src/thing.ts': 'x' });
    expect((await h.exec.tick()).started).toBe(1);
  });

  it('a session-path canary that skipped a probe fails closed', async () => {
    h = await createExecHarness();
    await h.workItem('c1');
    h.sessions.canaryReport.fn = (reportPath) => { fs.writeFileSync(reportPath, JSON.stringify({ attempted: [1, 2, 3], outputs: {} })); };
    await h.exec.tick();
    expect(h.execStore.all()[0]).toMatchObject({ state: 'stopped', reason: 'profile-unenforceable' });
  });

  it('a dependency install failure shows deps-unavailable at once, retries on the ladder and raises one Attention item when exhausted', async () => {
    h = await createExecHarness();
    await h.workItem('c1');
    h.deps.ok = false;
    await h.exec.tick();
    expect(h.exec.summary().deps).toMatchObject({ failures: 1 });
    expect((await h.exec.refreshAvailability()).reason).toBe('deps-unavailable');
    expect(h.degradations).toContain('feedback-execute:deps-unavailable');
    for (const wait of [30 * 60_000, 60 * 60_000, 4 * 60 * 60_000]) { h.now.value += wait + 1; await h.exec.tick(); }
    expect(h.attentionExec.filter((a) => a.id.startsWith('feedback-execute:deps-unavailable'))).toHaveLength(1);
  });
});

describe('verification and publication', () => {
  it('fixed: base check fails with an assertion, head passes, lint passes → PR from the publish clone with the hold label', async () => {
    h = await createExecHarness();
    const { initiativeId, row } = await toPrOpen();
    expect(row).toMatchObject({ state: 'pr-open', prNumber: 100, headSha: HEAD_SHA, approver: 'Owner' });
    const push = h.pushes[0];
    expect(push.branch).toMatch(/^feedback\/feedback-c1-[0-9a-f]{8}-a1$/);
    expect(push.remoteUrl).toBe('https://github.com/owner/repo.git');
    expect(push.files['src/thing.ts']).toBe('export const thing = 2;\n');
    expect(push.files[RESULT_FILE]).toBeUndefined();
    expect(push.files[EVIDENCE_FILE]).toBeUndefined();
    // Canary marker files never reach a change set.
    expect(Object.keys(push.files).some((k) => k.includes('feedback-canary'))).toBe(false);
    // The publish clone is the base tree plus the change set: the base's own .claude/ is untouched there.
    expect(Object.keys(push.files).sort()).toEqual(['.claude/settings.json', 'package.json', 'src/thing.ts', 'tests/fix.test.ts']);
    const pr = h.prs.get(100)!;
    expect(pr.labels).toContain('hold');
    expect(pr.body).toMatch(/## ELI16/);
    expect(pr.body).toMatch(/## UX Impact/);
    // Base check ran in the throwaway base clone with only the tests/ change copied in.
    const baseRun = h.runs.find((r) => /-base$/.test(r.cwd));
    expect(baseRun?.command).toMatch(/vitest run --no-cache 'tests\/fix.test.ts' -t 'fixes it'/);
    expect(baseRun?.env.INSTAR_AUTH_TOKEN).toBeUndefined();
    // Clones are removed after publication.
    expect(fs.existsSync(row.workspace!)).toBe(false);
    expect(fs.existsSync(row.publishClone!)).toBe(false);
    expect(h.exec.executionStateFor(initiativeId)).toEqual({ state: 'pr-open', prLink: 'https://github.com/owner/repo/pull/100' });
  });

  it('a test that passes at base fails the check (the fix proved nothing)', async () => {
    h = await createExecHarness();
    h.runScript.fn = (cmd) => (/vitest run/.test(cmd.command) ? { exitCode: 0 } : null);
    const { initiativeId } = await startOne();
    finishSessions(h);
    await h.exec.tick();
    expect(h.execStore.attemptsFor(initiativeId)[0]).toMatchObject({ state: 'failed', reason: 'base-check:test-passes-at-base' });
  });

  it('an import error of an unchanged module at base fails the check; a missing NEW module is allowed', async () => {
    h = await createExecHarness();
    h.runScript.fn = (cmd) => (isBaseState(cmd.cwd) && /vitest/.test(cmd.command) ? { exitCode: 1, stdout: 'Error: Failed to load url ../src/other (resolved id: ../src/other) in tests/fix.test.ts' } : null);
    const { initiativeId } = await startOne();
    finishSessions(h);
    await h.exec.tick();
    expect(h.execStore.attemptsFor(initiativeId)[0].reason).toBe('base-check:import-error-at-base');
    h.cleanup();
    h = await createExecHarness();
    h.runScript.fn = (cmd) => (isBaseState(cmd.cwd) && /vitest/.test(cmd.command) ? { exitCode: 1, stdout: 'Error: Failed to load url ../src/newfn (resolved id: ../src/newfn)' } : null);
    const id2 = await h.workItem('c1');
    h.fixWith({ 'src/newfn.ts': 'export const add = () => 2;\n', 'tests/fix.test.ts': "import { add } from '../src/newfn';\n" });
    await h.exec.tick();
    finishSessions(h);
    await h.exec.tick();
    expect(h.execStore.latestFor(id2)!.state).toBe('pr-open');
  });

  it('lint failing at the workspace fails the attempt; one retry, then hold execution-failed with the item paused', async () => {
    h = await createExecHarness();
    const { initiativeId } = await startOne();
    // Lint passed in the base canary; it fails on the session's change.
    h.runScript.fn = (cmd) => (cmd.command === 'npm run lint' && /-base$/.test(cmd.cwd) ? { exitCode: 2 } : null);
    finishSessions(h);
    await h.exec.tick();
    expect(h.execStore.attemptsFor(initiativeId)[0]).toMatchObject({ state: 'failed', reason: 'gate:lint' });
    expect(h.store.get(initiativeId)!.state).toBe('work');
    // The retry (attempt 2) already started in the same tick, after the failure was recorded.
    expect(h.execStore.attemptsFor(initiativeId)).toHaveLength(2);
    finishSessions(h);
    h.now.value += 60_000;
    await h.exec.tick();
    expect(h.store.get(initiativeId)).toMatchObject({ state: 'hold', reason: 'execution-failed' });
    expect(h.tracker.get(initiativeId)!.status).toBe('paused');
    // No timer: it comes back only on new reports or an operator instruction.
    expect(h.store.get(initiativeId)!.nextReviewAt).toBeNull();
  });

  it('a missing or invalid result file → failed; gave-up → failed', async () => {
    h = await createExecHarness();
    const { initiativeId } = await startOne();
    fs.writeFileSync(path.join(h.execStore.latestFor(initiativeId)!.workspace!, RESULT_FILE), '{"outcome":"fixed"}');
    finishSessions(h);
    await h.exec.tick();
    expect(h.execStore.attemptsFor(initiativeId)[0].reason).toBe('result-missing-or-invalid');
  });

  it('a symlink in the change set fails the attempt (special-file)', async () => {
    h = await createExecHarness();
    const { initiativeId } = await startOne();
    fs.symlinkSync('/etc/passwd', path.join(h.execStore.latestFor(initiativeId)!.workspace!, 'src', 'link.ts'));
    finishSessions(h);
    await h.exec.tick();
    expect(h.execStore.attemptsFor(initiativeId)[0].reason).toBe('special-file');
    expect(h.pushes).toHaveLength(0);
  });

  it('a change touching tooling paths is never published: held needs-review-tooling and listed', async () => {
    h = await createExecHarness();
    const id = await h.workItem('c1');
    h.fixWith({ 'package.json': '{"name":"fixture","scripts":{"postinstall":"evil"}}\n', 'tests/fix.test.ts': 'x' });
    await h.exec.tick();
    finishSessions(h);
    await h.exec.tick();
    expect(h.execStore.latestFor(id)).toMatchObject({ state: 'held', reason: 'needs-review-tooling' });
    expect(h.store.get(id)).toMatchObject({ state: 'hold', reason: 'needs-review-tooling' });
    expect(h.pushes).toHaveLength(0);
    expect(h.exec.actionItems().some((i) => /touched build tooling/.test(i.line))).toBe(true);
  });

  it('secret-shaped content is held (names only), and published only through the PIN-bound path', async () => {
    h = await createExecHarness();
    const id = await h.workItem('c1');
    const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
    h.fixWith({ 'src/thing.ts': 'export const thing = 2;\n', 'tests/fixtures/cred.ts': `export const token = '${token}';\n`, 'tests/fix.test.ts': 'x' });
    await h.exec.tick();
    finishSessions(h);
    await h.exec.tick();
    const held = h.execStore.latestFor(id)!;
    expect(held).toMatchObject({ state: 'held', reason: 'needs-review-secret-shape' });
    expect(held.secretFiles).toContain('tests/fixtures/cred.ts');
    expect(JSON.stringify(h.exec.summary())).not.toContain(token);
    expect(h.pushes).toHaveLength(0);
    const line = h.exec.actionItems().find((i) => /look like they contain a secret/.test(i.line))!;
    expect(line.line).toContain('tests/fixtures/cred.ts');
    expect(line.line).not.toContain(token);
    const plan = h.exec.planPublishSecretShape(held.attemptId);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect((await h.exec.publishHeld(held.attemptId, 'f'.repeat(64), 'dashboard-pin:x')).ok).toBe(false);
    const published = await h.exec.publishHeld(held.attemptId, plan.digest, 'dashboard-pin:plan-1');
    expect(published).toMatchObject({ ok: true, prNumber: 100 });
    expect(h.execStore.get(held.attemptId)).toMatchObject({ state: 'pr-open', reason: 'published:dashboard-pin:plan-1' });
    expect(h.pushes[0].files['tests/fixtures/cred.ts']).toContain(token);
    // The item is work again with its PR awaiting review; the next tick keeps the PR (it is not orphaned).
    expect(h.store.get(id)).toMatchObject({ state: 'work' });
    expect(h.tracker.get(id)!.status).toBe('active');
    h.now.value += 60_000;
    await h.exec.tick();
    expect(h.execStore.get(held.attemptId)!.state).toBe('pr-open');
  });

  it('spec-drafted: exactly one new docs/specs file without approval tags becomes a docs PR', async () => {
    h = await createExecHarness();
    const id = await h.workItem('c1', { needsSpec: true });
    const draft = 'docs/specs/feedback-feedback-c1.md';
    h.sessions.behavior.fn = (ws) => {
      fs.mkdirSync(path.join(ws, 'docs', 'specs'), { recursive: true });
      fs.writeFileSync(path.join(ws, draft), '---\ntitle: x\n---\n# Draft\n');
      fs.writeFileSync(path.join(ws, RESULT_FILE), JSON.stringify({ outcome: 'spec-drafted', notes: 'n' }));
    };
    await h.exec.tick();
    expect(h.sessions.spawned.find((s) => !s.name.startsWith('feedback-canary'))!.prompt).toContain(draft);
    finishSessions(h);
    await h.exec.tick();
    expect(h.execStore.latestFor(id)).toMatchObject({ state: 'spec-pr-open' });
    expect(Object.keys(h.pushes[0].files)).toContain(draft);
  });

  it('a spec draft carrying an approval tag is refused', async () => {
    h = await createExecHarness();
    const id = await h.workItem('c1', { needsSpec: true });
    h.sessions.behavior.fn = (ws) => {
      fs.mkdirSync(path.join(ws, 'docs', 'specs'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'docs/specs/feedback-feedback-c1.md'), '---\napproved: true\n---\n# Draft\n');
      fs.writeFileSync(path.join(ws, RESULT_FILE), JSON.stringify({ outcome: 'spec-drafted' }));
    };
    await h.exec.tick();
    finishSessions(h);
    await h.exec.tick();
    expect(h.execStore.attemptsFor(id)[0].reason).toMatch(/^spec-shape/);
  });

  it('not-reproducible twice → hold not-reproducible and a weak wrong grade on the work decision', async () => {
    h = await createExecHarness();
    const id = await h.workItem('c1');
    h.sessions.behavior.fn = (ws) => { fs.writeFileSync(path.join(ws, RESULT_FILE), JSON.stringify({ outcome: 'not-reproducible', notes: 'cannot' })); };
    await h.exec.tick(); finishSessions(h); await h.exec.tick();
    expect(h.store.get(id)!.state).toBe('work');
    h.now.value += 60_000;
    await h.exec.tick(); finishSessions(h); h.now.value += 60_000; await h.exec.tick();
    expect(h.store.get(id)).toMatchObject({ state: 'hold', reason: 'not-reproducible' });
    expect(h.store.gradeCounts()).toEqual(expect.arrayContaining([expect.objectContaining({ grade: 'wrong', strength: 'weak', disposition: 'work' })]));
  });

  it('after a second failure episode the executor no longer takes the item automatically; release lets it', async () => {
    h = await createExecHarness();
    const id = await h.workItem('c1');
    h.sessions.behavior.fn = (ws) => { fs.writeFileSync(path.join(ws, RESULT_FILE), JSON.stringify({ outcome: 'gave-up' })); };
    const episode = async () => {
      for (let i = 0; i < 2; i++) { h.now.value += 60_000; await h.exec.tick(); finishSessions(h); h.now.value += 60_000; await h.exec.tick(); }
    };
    await episode();
    expect(h.store.get(id)!.reason).toBe('execution-failed');
    // New reports bring it back to work through triage; a second episode blocks it.
    h.store.fenced(1, () => h.store.setMeta('noop', '1'));
    h.drain.sharedDatabase().prepare("UPDATE triage SET state='work' WHERE initiative_id=?").run(id);
    await episode();
    expect(h.store.get(id)!.reason).toBe('execution-failed');
    h.drain.sharedDatabase().prepare("UPDATE triage SET state='work' WHERE initiative_id=?").run(id);
    expect(h.exec.candidates().map((c) => c.initiativeId)).not.toContain(id);
    expect(h.exec.release(id)).toEqual({ released: true });
    h.drain.sharedDatabase().prepare("UPDATE triage SET state='work' WHERE initiative_id=?").run(id);
    expect(h.exec.candidates().map((c) => c.initiativeId)).toContain(id);
  });
});

describe('review gate and merge', () => {
  it('approvals by any other account, or at an older head, are ignored; the approver\'s approval of the head merges that exact SHA', async () => {
    h = await createExecHarness();
    const { initiativeId } = await toPrOpen();
    h.reviews.set(100, [{ login: 'someone', state: 'APPROVED', commitId: HEAD_SHA, submittedAt: '2026-10-07T00:00:00Z' }]);
    await h.exec.tick();
    expect(h.merges).toHaveLength(0);
    h.reviews.set(100, [{ login: 'Owner', state: 'APPROVED', commitId: 'c'.repeat(40), submittedAt: '2026-10-07T00:00:00Z' }]);
    await h.exec.tick();
    expect(h.merges).toHaveLength(0);
    h.reviews.set(100, [{ login: 'owner', state: 'APPROVED', commitId: HEAD_SHA, submittedAt: '2026-10-07T01:00:00Z' }]);
    await h.exec.tick();
    expect(h.merges).toEqual([{ pr: 100, sha: HEAD_SHA }]);
    expect(h.prs.get(100)!.labels).not.toContain('hold');
    expect(h.execStore.latestFor(initiativeId)).toMatchObject({ state: 'merge-armed', approvedSha: HEAD_SHA });
    // A medium right grade once the operator approved.
    expect(h.store.gradeCounts()).toEqual(expect.arrayContaining([expect.objectContaining({ grade: 'right', strength: 'medium' })]));
  });

  it('merge-armed is confirmed only by mergedAt + headRefOid equal to the approved SHA', async () => {
    h = await createExecHarness();
    const { initiativeId } = await toPrOpen();
    h.reviews.set(100, [{ login: 'Owner', state: 'APPROVED', commitId: HEAD_SHA, submittedAt: '2026-10-07T01:00:00Z' }]);
    await h.exec.tick();
    h.prs.get(100)!.mergedAt = '2026-10-08T00:00:00Z';
    h.prs.get(100)!.mergeCommit = 'd'.repeat(40);
    await h.exec.tick();
    expect(h.execStore.latestFor(initiativeId)).toMatchObject({ state: 'merged', mergedElsewhere: false, mergeCommit: 'd'.repeat(40) });
    const init = h.tracker.get(initiativeId)!;
    expect(init.phases.find((p) => p.id === 'build')!.status).toBe('done');
    expect(init.phases.find((p) => p.id === 'spec')!.status).toBe('done');
    expect(init.phases.find((p) => p.id === 'verify')!.status).not.toBe('done');
  });

  it('a head pushed after arming disarms and needs a fresh approval', async () => {
    h = await createExecHarness();
    const { initiativeId } = await toPrOpen();
    h.reviews.set(100, [{ login: 'Owner', state: 'APPROVED', commitId: HEAD_SHA, submittedAt: '2026-10-07T01:00:00Z' }]);
    await h.exec.tick();
    h.prs.get(100)!.headRefOid = 'e'.repeat(40);
    await h.exec.tick();
    expect(h.disarmed).toContain(100);
    expect(h.execStore.latestFor(initiativeId)).toMatchObject({ state: 'pr-open', reason: 'merge-refused:head-moved', approvedSha: null });
    await h.exec.tick();
    expect(h.merges).toHaveLength(1);
  });

  it('safe-merge refusals map to merge-refused: retried once after 1 h, then hold merge-unavailable (disarmed each time)', async () => {
    h = await createExecHarness();
    const { initiativeId } = await toPrOpen();
    h.reviews.set(100, [{ login: 'Owner', state: 'APPROVED', commitId: HEAD_SHA, submittedAt: '2026-10-07T01:00:00Z' }]);
    h.safeMergeExit = { code: 1, stdout: 'x\nsafe-merge-result: {"result":"refused:red-checks"}' };
    await h.exec.tick();
    expect(h.execStore.latestFor(initiativeId)).toMatchObject({ state: 'pr-open', reason: 'merge-refused:red-checks', mergeRetries: 1 });
    await h.exec.tick();
    expect(h.merges).toHaveLength(1); // waits the hour
    h.now.value += 60 * 60_000 + 1;
    await h.exec.tick();
    expect(h.merges).toHaveLength(2);
    expect(h.execStore.latestFor(initiativeId)).toMatchObject({ state: 'held', reason: 'merge-refused:red-checks' });
    expect(h.store.get(initiativeId)).toMatchObject({ state: 'hold', reason: 'merge-unavailable' });
    expect(h.disarmed.filter((n) => n === 100).length).toBe(2);
  });

  it('a merge-armed PR past its 24 h deadline is disarmed and refused (deadline)', async () => {
    h = await createExecHarness();
    const { initiativeId } = await toPrOpen();
    h.reviews.set(100, [{ login: 'Owner', state: 'APPROVED', commitId: HEAD_SHA, submittedAt: '2026-10-07T01:00:00Z' }]);
    await h.exec.tick();
    h.now.value += 24 * 60 * 60_000 + 1;
    await h.exec.tick();
    expect(h.execStore.latestFor(initiativeId)).toMatchObject({ reason: 'merge-refused:deadline' });
    expect(h.disarmed).toContain(100);
  });

  it('safe-merge exit 0 → merged once GitHub shows mergedAt at the approved head', async () => {
    h = await createExecHarness();
    const { initiativeId } = await toPrOpen();
    h.reviews.set(100, [{ login: 'Owner', state: 'APPROVED', commitId: HEAD_SHA, submittedAt: '2026-10-07T01:00:00Z' }]);
    h.safeMergeExit = { code: 0, stdout: 'safe-merge-result: {"result":"merged"}' };
    const pr = h.prs.get(100)!;
    await h.exec.tick();
    // GitHub has not reported the merge yet: the executor waits (confirmed by mergedAt + headRefOid only).
    expect(h.execStore.latestFor(initiativeId)!.state).toBe('merge-armed');
    pr.mergedAt = '2026-10-08T00:00:00Z'; pr.mergeCommit = 'd'.repeat(40);
    await h.exec.tick();
    expect(h.execStore.latestFor(initiativeId)).toMatchObject({ state: 'merged', approvedSha: HEAD_SHA });
  });

  it('merged elsewhere (no recorded approval) raises one Attention item and blocks verify until the approver approves that SHA after the fact', async () => {
    h = await createExecHarness();
    const { initiativeId } = await toPrOpen();
    h.prs.get(100)!.mergedAt = '2026-10-08T00:00:00Z';
    h.prs.get(100)!.mergeCommit = 'd'.repeat(40);
    await h.exec.tick();
    expect(h.execStore.latestFor(initiativeId)).toMatchObject({ state: 'merged', mergedElsewhere: true });
    expect(h.attentionExec.filter((a) => a.id.startsWith('feedback-execute:merged-elsewhere'))).toHaveLength(1);
    h.release.value = { tag: 'v1.0.1', taggedAt: h.now.value };
    h.now.value += 31 * DAY;
    await h.exec.tick();
    expect(h.execStore.latestFor(initiativeId)!.verifyState).toBe('awaiting-approval-of-merged-head');
    h.reviews.set(100, [{ login: 'Owner', state: 'APPROVED', commitId: HEAD_SHA, submittedAt: '2026-10-09T00:00:00Z' }]);
    await h.exec.tick();
    expect(h.execStore.latestFor(initiativeId)!.mergedElsewhere).toBe(false);
  });

  it('stop paths disarm: re-triage away from work, the operator stop, disabled, stale epoch', async () => {
    h = await createExecHarness();
    const { initiativeId } = await toPrOpen();
    h.reviews.set(100, [{ login: 'Owner', state: 'APPROVED', commitId: HEAD_SHA, submittedAt: '2026-10-07T01:00:00Z' }]);
    await h.exec.tick();
    h.drain.sharedDatabase().prepare("UPDATE triage SET state='hold', reason='needs-evidence' WHERE initiative_id=?").run(initiativeId);
    await h.exec.tick();
    expect(h.disarmed).toEqual([100]);
    expect(h.execStore.latestFor(initiativeId)).toMatchObject({ state: 'stopped', reason: 'retriaged-away-from-work' });

    h.cleanup();
    h = await createExecHarness();
    const b = await toPrOpen('c2');
    h.reviews.set(100, [{ login: 'Owner', state: 'APPROVED', commitId: HEAD_SHA, submittedAt: '2026-10-07T01:00:00Z' }]);
    await h.exec.tick();
    expect((await h.exec.stopItem(b.initiativeId)).stopped).toBe(1);
    expect(h.disarmed).toEqual([100]);
    expect(h.exec.candidates().map((c) => c.initiativeId)).not.toContain(b.initiativeId);

    h.cleanup();
    h = await createExecHarness();
    await toPrOpen('c3');
    h.reviews.set(100, [{ login: 'Owner', state: 'APPROVED', commitId: HEAD_SHA, submittedAt: '2026-10-07T01:00:00Z' }]);
    await h.exec.tick();
    h.enabled.value = false;
    const t = await h.exec.tick();
    expect(t.reason).toBe('disabled');
    expect(h.disarmed).toEqual([100]);

    h.cleanup();
    h = await createExecHarness();
    const d = await toPrOpen('c4');
    h.reviews.set(100, [{ login: 'Owner', state: 'APPROVED', commitId: HEAD_SHA, submittedAt: '2026-10-07T01:00:00Z' }]);
    await h.exec.tick();
    h.epoch.value = 2;
    await h.exec.tick();
    expect(h.disarmed).toEqual([100]);
    expect(h.execStore.latestFor(d.initiativeId)).toMatchObject({ reason: 'disarmed:stale-epoch' });
  });

  it('a failed disarm is its own Attention line', async () => {
    h = await createExecHarness();
    const { initiativeId } = await toPrOpen();
    h.reviews.set(100, [{ login: 'Owner', state: 'APPROVED', commitId: HEAD_SHA, submittedAt: '2026-10-07T01:00:00Z' }]);
    await h.exec.tick();
    (h.exec as unknown as { opts: { github: { disableAuto: () => Promise<boolean> } } }).opts.github.disableAuto = async () => false;
    await h.exec.stopItem(initiativeId);
    expect(h.attentionExec.some((a) => a.id.startsWith('feedback-execute:disarm-failed'))).toBe(true);
  });

  it('a gh error leaves state unchanged (unknown)', async () => {
    h = await createExecHarness();
    const { initiativeId } = await toPrOpen();
    (h.exec as unknown as { opts: { github: { prState: () => Promise<null> } } }).opts.github.prState = async () => null;
    await h.exec.tick();
    expect(h.execStore.latestFor(initiativeId)!.state).toBe('pr-open');
  });
});

describe('verify after merge', () => {
  async function merged(o: { userFacing?: boolean } = {}) {
    const id = await h.workItem('c1', { userFacing: o.userFacing });
    h.fixWith({ 'src/thing.ts': 'x', 'tests/fix.test.ts': 'x' });
    await h.exec.tick(); finishSessions(h); await h.exec.tick();
    h.reviews.set(100, [{ login: 'Owner', state: 'APPROVED', commitId: HEAD_SHA, submittedAt: '2026-10-07T01:00:00Z' }]);
    await h.exec.tick();
    h.prs.get(100)!.mergedAt = '2026-10-08T00:00:00Z'; h.prs.get(100)!.mergeCommit = 'd'.repeat(40);
    await h.exec.tick();
    return id;
  }

  it('no release yet → pending; released + 30 quiet days → verify done, Initiative completed, strong right grade', async () => {
    h = await createExecHarness();
    const id = await merged();
    await h.exec.tick();
    expect(h.execStore.latestFor(id)!.verifyState).toBe('pending-release');
    h.release.value = { tag: 'v1.3.2000', taggedAt: h.now.value };
    await h.exec.tick();
    // Release lookups are throttled to one per hour per attempt.
    expect(h.execStore.latestFor(id)!.verifyState).toBe('pending-release');
    h.now.value += 61 * 60_000;
    await h.exec.tick();
    expect(h.execStore.latestFor(id)).toMatchObject({ verifyState: 'pending-quiet-days', releaseTag: 'v1.3.2000' });
    h.now.value += 30 * DAY + 1;
    await h.exec.tick();
    expect(h.execStore.latestFor(id)!.verifyState).toBe('done');
    expect(h.tracker.get(id)!.status).toBe('completed');
    expect(h.store.gradeCounts()).toEqual(expect.arrayContaining([expect.objectContaining({ grade: 'right', strength: 'strong' })]));
  });

  it('completing the Initiative is not recorded as an operator override; a regressed fix can be attempted again', async () => {
    h = await createExecHarness();
    const id = await merged();
    h.release.value = { tag: 'v1.3.2000', taggedAt: h.now.value };
    h.now.value += 31 * DAY;
    await h.exec.tick();
    expect(h.tracker.get(id)!.status).toBe('completed');
    h.now.value += 60_000;
    await h.service.tick();
    expect(h.store.get(id)!.operatorOverride).toBeNull();
    // A regression after release (new report) reopens it; once triage says work again, a new attempt may start.
    h.cleanup();
    h = await createExecHarness();
    const id2 = await merged();
    h.release.value = { tag: 'v1.3.2000', taggedAt: h.now.value };
    await h.exec.tick();
    h.now.value += 2 * DAY;
    h.reports.get('c1')!.push({ feedbackId: 'fb-late', title: 't', description: 'still broken', type: 'bug', receivedAt: new Date(h.now.value).toISOString(), clusterId: 'c1' });
    await h.exec.tick();
    h.drain.sharedDatabase().prepare("UPDATE triage SET state='work' WHERE initiative_id=?").run(id2);
    expect(h.exec.candidates().map((c) => c.initiativeId)).toContain(id2);
  });

  it('the 30-day work-queue ceiling does not re-triage an item the executor has started', async () => {
    h = await createExecHarness();
    const { initiativeId } = await toPrOpen();
    h.now.value += 40 * DAY;
    await h.service.tick();
    expect(h.store.get(initiativeId)).toMatchObject({ state: 'work', lastRequeuedAt: null });
    // Control: an item the executor has NOT started is re-queued by the same ceiling.
    const fresh = await h.workItem('c9');
    h.quota.value = 99; // pause model calls so the re-queued item stays visibly queued
    h.now.value += 40 * DAY;
    await h.service.tick();
    expect(h.store.get(fresh)!.lastRequeuedAt).not.toBeNull();
    expect(h.store.get(initiativeId)!.lastRequeuedAt).toBeNull();
  });

  it('an undeterminable release keeps verify pending', async () => {
    h = await createExecHarness();
    const id = await merged();
    h.release.value = null;
    h.now.value += 60 * DAY;
    await h.exec.tick();
    expect(h.execStore.latestFor(id)!.verifyState).toBe('pending-release-undeterminable');
    expect(h.tracker.get(id)!.status).not.toBe('completed');
  });

  it('a new report after the release reopens the item for triage', async () => {
    h = await createExecHarness();
    const id = await merged();
    h.release.value = { tag: 'v1.3.2000', taggedAt: h.now.value };
    await h.exec.tick();
    h.now.value += 5 * DAY;
    h.reports.get('c1')!.push({ feedbackId: 'fb-late', title: 't', description: 'still broken', type: 'bug', receivedAt: new Date(h.now.value).toISOString(), clusterId: 'c1' });
    await h.exec.tick();
    expect(h.store.get(id)).toMatchObject({ state: 'queued', requeueReason: 'regressed-after-release' });
  });

  it('a user-facing fix also needs the live-channel harness: PASS completes, FAIL reopens', async () => {
    h = await createExecHarness();
    const id = await merged({ userFacing: true });
    h.release.value = { tag: 'v1.3.2000', taggedAt: h.now.value };
    h.now.value += 31 * DAY;
    await h.exec.tick();
    const live = h.sessions.spawned.find((s) => s.trusted && s.name.startsWith('feedback-liveproof-'))!;
    expect(live.prompt).toMatch(/live-user-channel test harness/);
    const resultPath = /write (\S+\.json) as JSON/.exec(live.prompt)![1];
    fs.writeFileSync(resultPath, JSON.stringify({ result: 'FAIL' }));
    h.sessions.alive.clear();
    await h.exec.tick();
    expect(h.store.get(id)).toMatchObject({ state: 'queued', requeueReason: 'live-proof-failed' });
  });

  it('a merged spec draft is handed to a trusted /spec-converge session that flags operational instructions', async () => {
    h = await createExecHarness();
    const id = await h.workItem('c1', { needsSpec: true });
    h.sessions.behavior.fn = (ws) => {
      fs.mkdirSync(path.join(ws, 'docs', 'specs'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'docs/specs/feedback-feedback-c1.md'), '# Draft\n');
      fs.writeFileSync(path.join(ws, RESULT_FILE), JSON.stringify({ outcome: 'spec-drafted' }));
    };
    await h.exec.tick(); finishSessions(h); await h.exec.tick();
    h.reviews.set(100, [{ login: 'Owner', state: 'APPROVED', commitId: HEAD_SHA, submittedAt: '2026-10-07T01:00:00Z' }]);
    await h.exec.tick();
    h.prs.get(100)!.mergedAt = '2026-10-08T00:00:00Z'; h.prs.get(100)!.mergeCommit = 'd'.repeat(40);
    await h.exec.tick();
    await h.exec.tick();
    const converge = h.sessions.spawned.find((s) => s.trusted && s.name.startsWith('feedback-specconverge-'))!;
    expect(converge.prompt).toMatch(/\/spec-converge/);
    expect(converge.prompt).toMatch(/flag any operational instructions/);
    expect(h.exec.candidates().map((c) => c.initiativeId)).not.toContain(id);
  });
});

describe('operator surface', () => {
  it('the action list carries each PR awaiting approval once, with a direct link', async () => {
    h = await createExecHarness();
    await toPrOpen();
    h.now.value = Date.UTC(2026, 9, 8, 15, 0);
    const first = await h.service.sendActionList();
    expect(first.sent).toBe(true);
    const text = h.sent.length ? h.sent[0].text : h.attention.at(-1)!.description!;
    expect(text).toContain('https://github.com/owner/repo/pull/100/files');
    h.now.value += 24 * 60 * 60_000;
    const second = await h.service.sendActionList();
    expect(second.reason).toBe('nothing-new');
  });

  it('the triage summary and queue show the executor', async () => {
    h = await createExecHarness();
    const { initiativeId } = await toPrOpen();
    expect(h.service.summary().executor).toEqual({ available: true, reason: 'ok' });
    expect(h.service.queue().find((i) => i.initiativeId === initiativeId)).toMatchObject({ executionState: 'pr-open', prLink: 'https://github.com/owner/repo/pull/100' });
  });
});

describe('second-pass review regressions', () => {
  const approve = () => h.reviews.set(100, [{ login: 'Owner', state: 'APPROVED', commitId: HEAD_SHA, submittedAt: '2026-10-07T01:00:00Z' }]);

  it('after an owner-epoch change an armed PR is disarmed ONCE, re-gated under the new epoch, and re-armed — no arm/disarm loop', async () => {
    h = await createExecHarness();
    const { initiativeId } = await toPrOpen();
    approve();
    await h.exec.tick();
    expect(h.execStore.latestFor(initiativeId)!.state).toBe('merge-armed');
    h.epoch.value = 2;
    for (let i = 0; i < 4; i++) { h.now.value += 60_000; await h.exec.tick(); }
    expect(h.disarmed).toEqual([100]);
    expect(h.merges).toHaveLength(2);
    expect(h.execStore.latestFor(initiativeId)).toMatchObject({ state: 'merge-armed', ownerEpoch: 2 });
  });

  it('a PR GitHub already merged is recorded as merged even under a stale epoch (never disarmed after the fact)', async () => {
    h = await createExecHarness();
    const { initiativeId } = await toPrOpen();
    approve();
    await h.exec.tick();
    h.prs.get(100)!.mergedAt = '2026-10-08T00:00:00Z'; h.prs.get(100)!.mergeCommit = 'd'.repeat(40);
    h.epoch.value = 2;
    await h.exec.tick();
    expect(h.disarmed).toEqual([]);
    expect(h.execStore.latestFor(initiativeId)!.state).toBe('merged');
  });

  it('a failed disarm keeps the PR merge-armed (disarmFailed) and retries every tick until it works', async () => {
    h = await createExecHarness();
    const { initiativeId } = await toPrOpen();
    approve();
    await h.exec.tick();
    const gh = (h.exec as unknown as { opts: { github: { disableAuto: (s: string, pr: number) => Promise<boolean> } } }).opts.github;
    const ok = gh.disableAuto;
    gh.disableAuto = async () => false;
    h.drain.sharedDatabase().prepare("UPDATE triage SET state='hold', reason='needs-evidence' WHERE initiative_id=?").run(initiativeId);
    await h.exec.tick();
    expect(h.execStore.latestFor(initiativeId)).toMatchObject({ state: 'merge-armed', disarmFailed: true });
    gh.disableAuto = ok;
    await h.exec.tick();
    expect(h.execStore.latestFor(initiativeId)).toMatchObject({ state: 'stopped', reason: 'retriaged-away-from-work' });
  });

  it('a spec draft merged without the approver\'s approval never reaches the trusted convergence session', async () => {
    h = await createExecHarness();
    await h.workItem('c1', { needsSpec: true });
    h.sessions.behavior.fn = (ws) => {
      fs.mkdirSync(path.join(ws, 'docs', 'specs'), { recursive: true });
      fs.writeFileSync(path.join(ws, 'docs/specs/feedback-feedback-c1.md'), '# Draft\n');
      fs.writeFileSync(path.join(ws, RESULT_FILE), JSON.stringify({ outcome: 'spec-drafted' }));
    };
    await h.exec.tick(); finishSessions(h); await h.exec.tick();
    h.prs.get(100)!.mergedAt = '2026-10-08T00:00:00Z'; h.prs.get(100)!.mergeCommit = 'd'.repeat(40);
    await h.exec.tick(); await h.exec.tick();
    expect(h.sessions.spawned.some((s) => s.trusted)).toBe(false);
    approve(); // the approver approves the merged head after the fact
    await h.exec.tick();
    expect(h.sessions.spawned.some((s) => s.trusted && s.name.startsWith('feedback-specconverge-'))).toBe(true);
  });

  it('an executor hold re-binds the report count: reports that arrived during the attempt do not bring it straight back', async () => {
    h = await createExecHarness();
    const id = await h.workItem('c1');
    // Reports keep arriving while the attempts run.
    const cluster = h.clusters.get('c1')!;
    h.clusters.set('c1', { ...cluster, reportCount: 9 });
    h.sessions.behavior.fn = (ws) => { fs.writeFileSync(path.join(ws, RESULT_FILE), JSON.stringify({ outcome: 'gave-up' })); };
    for (let i = 0; i < 2; i++) { h.now.value += 60_000; await h.exec.tick(); finishSessions(h); h.now.value += 60_000; await h.exec.tick(); }
    expect(h.store.get(id)).toMatchObject({ state: 'hold', reason: 'execution-failed', boundReportCount: 9 });
    h.now.value += 2 * DAY;
    await h.service.tick();
    expect(h.store.get(id)!.state).toBe('hold');
  });

  it('a restart during verification re-verifies once with the workspace intact; it is never counted as the item\'s failure', async () => {
    h = await createExecHarness();
    const { initiativeId } = await startOne();
    const row = h.execStore.latestFor(initiativeId)!;
    h.execStore.patch(1, row.attemptId, { state: 'verifying' }); // as if the server restarted mid-verification
    finishSessions(h);
    await h.exec.tick();
    expect(h.execStore.latestFor(initiativeId)!.state).toBe('running');
    await h.exec.tick();
    expect(h.execStore.latestFor(initiativeId)!.state).toBe('pr-open');
    // Interrupted twice → stopped (infrastructure), not failed.
    h.cleanup();
    h = await createExecHarness();
    const b = await startOne();
    const r2 = h.execStore.latestFor(b.initiativeId)!;
    h.execStore.patch(1, r2.attemptId, { state: 'verifying', reason: 'reverify-after-restart' });
    await h.exec.tick();
    expect(h.execStore.attemptsFor(b.initiativeId)[0]).toMatchObject({ state: 'stopped', reason: 'interrupted' });
    expect(h.store.get(b.initiativeId)!.state).toBe('work');
  });

  it('the operator\'s stop and PIN publication never race a running tick', async () => {
    h = await createExecHarness();
    await h.workItem('c1');
    (h.exec as unknown as { running: boolean }).running = true;
    await expect(h.exec.stopItem('feedback-c1')).rejects.toThrow(/tick-in-flight/);
    expect(await h.exec.publishHeld('x:a1', 'd', 'ref')).toMatchObject({ ok: false });
    (h.exec as unknown as { running: boolean }).running = false;
    expect(await h.exec.stopItem('feedback-c1')).toEqual({ stopped: 0 });
  });
});
