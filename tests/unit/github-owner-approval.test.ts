/**
 * GithubOwnerApproval (docs/specs/github-approval-from-the-app.md): availability, the live precheck,
 * GitHub-as-judge verification, the HOLD on a wrong-head approval, restart reconciliation, CODEOWNERS
 * reading, and the approver script's secret handling.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  GithubOwnerApproval, selectOwnerProfile, ownerLatest, ownerFilesOf, patternCovers, parseCodeowners, isCodeOwner,
  parsePaginated, scriptApprover, profileLock, approverScriptPath, type GithubOwnerApprovalDeps, type ReviewRow, type ApprovalRun,
} from '../../src/core/GithubOwnerApproval.js';
import { totpAt, base32Decode } from '../../scripts/github-owner-approve.mjs';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const CODEOWNERS = '# owners\n/docs/STANDARDS-REGISTRY.md @JKHeadley\n/.github/CODEOWNERS @JKHeadley\n';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-owner-approval-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/github-owner-approval.test.ts' }); });

const review = (id: number, state: string, commit: string | null, login = 'JKHeadley', at = `2026-11-19T10:00:${String(id % 60).padStart(2, '0')}Z`): ReviewRow =>
  ({ id, state, commit_id: commit, submitted_at: at, user: { login } });

function harness(over: Partial<GithubOwnerApprovalDeps> & { reviewsSeq?: ReviewRow[][]; files?: string[]; head?: string; own?: boolean } = {}) {
  const profileDir = path.join(tmp, 'justin-github');
  fs.mkdirSync(profileDir, { recursive: true });
  const calls = { runApprover: [] as Array<Record<string, unknown>>, holds: [] as number[], audit: [] as Array<Record<string, unknown>>, killed: [] as number[] };
  const seq = over.reviewsSeq ?? [[], []];
  let reviewsRead = 0;
  let locked = false;
  const runs: ApprovalRun[] = [];
  const deps: GithubOwnerApprovalDeps = {
    config: () => ({ enabled: true, playwrightCoreDir: '/pw' }),
    repo: () => 'JKHeadley/instar',
    profiles: () => [{ id: 'justin-github', userDataDir: profileDir, accounts: [{ service: 'github', identity: 'JKHeadley', owner: 'operator', vaultRefs: ['github_justin_username', 'github_justin_password', 'github_justin_totp_secret'] }] }],
    hasSecret: () => true,
    readSecret: (n) => `SECRET-${n}`,
    codeowners: () => CODEOWNERS,
    readCodeownersAt: async () => CODEOWNERS,
    playwrightLoads: () => true,
    readPr: async () => ({ state: 'open', merged: false, headSha: over.head ?? HEAD, title: 'Amend the constitution', baseSha: BASE }),
    readFiles: async () => over.files ?? ['docs/STANDARDS-REGISTRY.md', 'src/x.ts'],
    readReviews: async () => { const r = seq[Math.min(reviewsRead, seq.length - 1)]; reviewsRead++; return r; },
    runApprover: async (input) => { calls.runApprover.push(input); return { outcome: 'submitted', step: 5 }; },
    isAgentPr: async () => over.own ?? true,
    applyHold: async (pr) => { calls.holds.push(pr); return { ok: true }; },
    lock: () => { if (locked) return false; locked = true; return true; },
    unlock: () => { locked = false; },
    audit: (row) => { calls.audit.push(row); },
    runsStore: { load: () => runs.slice(), save: (r) => { runs.splice(0, runs.length, ...r); } },
    killGroup: (pgid) => { calls.killed.push(pgid); },
    sleep: async () => {},
    ...over,
  };
  return { svc: new GithubOwnerApproval(deps), calls, runs, deps };
}

describe('availability', () => {
  it('is off unless switched on, with a plain reason', () => {
    const { svc } = harness({ config: () => ({ enabled: false }) });
    expect(svc.availability()).toEqual({ available: false, reason: expect.stringMatching(/switched off/) });
  });
  it('is on when the profile, vault, code-owner login and playwright are all here', () => {
    expect(harness().svc.availability()).toEqual({ available: true, reason: null });
  });
  it('names each missing piece', () => {
    expect(harness({ hasSecret: () => false }).svc.availability().reason).toMatch(/vault/);
    expect(harness({ playwrightLoads: () => false }).svc.availability().reason).toMatch(/browser tool/);
    expect(harness({ codeowners: () => '/x @someoneelse\n' }).svc.availability().reason).toMatch(/not a code owner/);
    expect(harness({ profiles: () => [] }).svc.availability().reason).toMatch(/no GitHub sign-in/);
  });
});

describe('selectOwnerProfile', () => {
  it('prefers typed vault bindings, else the one reference naming the role', () => {
    const p = selectOwnerProfile([{ id: 'p', userDataDir: '/d', accounts: [{ service: 'github', identity: 'JK', owner: 'operator', vaultRefs: ['a', 'b'], vaultBindings: { password: 'a', totp: 'b' } }] }], null);
    expect(p).toMatchObject({ passwordRef: 'a', totpRef: 'b', identity: 'JK' });
    const q = selectOwnerProfile([{ id: 'p', userDataDir: '/d', accounts: [{ service: 'github', identity: 'JK', owner: 'operator', vaultRefs: ['x_password', 'x_totp_secret'] }] }], null);
    expect(q).toMatchObject({ passwordRef: 'x_password', totpRef: 'x_totp_secret' });
  });
  it('refuses two candidates and an agent-owned account', () => {
    const acc = { service: 'github', identity: 'JK', owner: 'operator', vaultRefs: ['p_password', 'p_totp'] };
    expect(selectOwnerProfile([{ id: 'a', userDataDir: '/a', accounts: [acc] }, { id: 'b', userDataDir: '/b', accounts: [acc] }], null)).toMatch(/more than one/);
    expect(selectOwnerProfile([{ id: 'a', userDataDir: '/a', accounts: [{ ...acc, owner: 'agent' }] }], null)).toMatch(/no GitHub sign-in/);
  });
});

describe('CODEOWNERS reading', () => {
  it('applies the last matching rule (a later rule can give the path to someone else)', () => {
    expect(ownerFilesOf(['docs/STANDARDS-REGISTRY.md'], CODEOWNERS, 'jkheadley')).toEqual(['docs/STANDARDS-REGISTRY.md']);
    expect(ownerFilesOf(['docs/STANDARDS-REGISTRY.md'], `${CODEOWNERS}/docs/ @other\n`, 'JKHeadley')).toEqual([]);
    expect(ownerFilesOf(['src/a.ts'], CODEOWNERS, 'JKHeadley')).toEqual([]);
  });
  it('refuses syntax it does not read, never guesses', () => {
    expect(parseCodeowners('docs/**/x.md @a\n')).toBeNull();
    expect(ownerFilesOf(['docs/a/x.md'], 'docs/**/x.md @a\n', 'a')).toBeNull();
    expect(isCodeOwner('docs/**/x.md @a\n', 'a')).toBe(false);
  });
  it('matches literal paths, dir prefixes and a one-segment star', () => {
    expect(patternCovers('/docs/STANDARDS-REGISTRY.md', 'docs/STANDARDS-REGISTRY.md')).toBe(true);
    expect(patternCovers('/docs/', 'docs/a/b.md')).toBe(true);
    expect(patternCovers('/docs/*', 'docs/a.md')).toBe(true);
    expect(patternCovers('/docs/*', 'docs/a/b.md')).toBe(false);
    expect(patternCovers('CODEOWNERS', '.github/CODEOWNERS')).toBe(true);
    expect(patternCovers('/docs/x.md', 'other/docs/x.md')).toBe(false);
  });
});

describe('ownerLatest', () => {
  it('takes the owner\'s latest decisive review, any case, ignoring comments and others', () => {
    const rows = [review(1, 'APPROVED', OTHER), review(2, 'COMMENTED', HEAD), review(3, 'APPROVED', HEAD, 'someone'), review(4, 'CHANGES_REQUESTED', HEAD, 'jkheadley')];
    expect(ownerLatest(rows, 'JKHeadley')?.id).toBe(4);
  });
});

describe('precheck', () => {
  it('requires a head, refuses a changed head with the current one, a non-agent PR and a PR with no owner path', async () => {
    const { svc } = harness();
    expect((await svc.precheck(3478, undefined))?.body.error).toBe('bad-head-sha');
    expect(await svc.precheck(3478, HEAD)).toBeNull();
    expect((await harness({ head: OTHER }).svc.precheck(3478, HEAD))?.body).toMatchObject({ error: 'head-changed', currentHead: OTHER });
    expect((await harness({ own: false }).svc.precheck(3478, HEAD))?.body.error).toBe('not-agent-pr');
    expect((await harness({ files: ['src/a.ts'] }).svc.precheck(3478, HEAD))?.body.error).toBe('not-awaiting-owner-review');
    expect((await harness({ readCodeownersAt: async () => 'a/**/b @JKHeadley\n' }).svc.precheck(3478, HEAD))?.body.error).toBe('codeowners-unreadable');
  });
  it('answers 503 with the reason when unavailable, and 502 when GitHub does not answer', async () => {
    expect((await harness({ config: () => ({ enabled: false }) }).svc.precheck(3478, HEAD))?.status).toBe(503);
    expect((await harness({ readPr: async () => { throw new Error('x'); } }).svc.precheck(3478, HEAD))?.status).toBe(502);
  });
});

describe('start: GitHub is the judge', () => {
  it('a new owner approval at the head verifies 200, with secrets only in the script input', async () => {
    const { svc, calls } = harness({ reviewsSeq: [[review(1, 'APPROVED', OTHER)], [review(1, 'APPROVED', OTHER), review(2, 'APPROVED', HEAD)]] });
    const r = await svc.start({ pr: 3478, headSha: HEAD, deviceId: 'dev1' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ approved: true, already: false, reviewId: 2, commitId: HEAD });
    expect(calls.runApprover[0]).toMatchObject({ expectedLogin: 'JKHeadley', password: 'SECRET-github_justin_password', totpSecret: 'SECRET-github_justin_totp_secret', headSha: HEAD });
    expect(calls.runApprover[0]).not.toHaveProperty('holdBeforeSubmitMs');
    expect(calls.runApprover[0]).not.toHaveProperty('headless');
    expect(JSON.stringify(calls.audit)).not.toMatch(/SECRET-/);
    expect(JSON.stringify(r.body)).not.toMatch(/SECRET-/);
  });
  it('already approved at the head answers without running the script', async () => {
    const { svc, calls } = harness({ reviewsSeq: [[review(7, 'APPROVED', HEAD)]] });
    const r = await svc.start({ pr: 3478, headSha: HEAD, deviceId: null });
    expect(r.body).toMatchObject({ approved: true, already: true, reviewId: 7 });
    expect(calls.runApprover).toHaveLength(0);
  });
  it('"submitted" with nothing recorded is approval-not-recorded', async () => {
    const r = await harness({ reviewsSeq: [[], []] }).svc.start({ pr: 3478, headSha: HEAD, deviceId: null });
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ error: 'approval-not-recorded', outcome: 'submitted' });
  });
  it('an old approval at another commit is not reported as a wrong-head approval', async () => {
    const old = review(1, 'APPROVED', OTHER);
    const { svc, calls } = harness({ reviewsSeq: [[old], [old]] });
    const r = await svc.start({ pr: 3478, headSha: HEAD, deviceId: null });
    expect(r.body.error).toBe('approval-not-recorded');
    expect(calls.holds).toHaveLength(0);
  });
  it('a NEW approval at another commit is held at once (retried once) and told plainly', async () => {
    let tries = 0;
    const { svc, calls } = harness({ reviewsSeq: [[], [review(9, 'APPROVED', OTHER)]], applyHold: async (pr) => { tries++; calls.holds.push(pr); return { ok: tries > 1 }; } });
    const r = await svc.start({ pr: 3478, headSha: HEAD, deviceId: null });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'approved-at-other-head', held: true });
    expect(calls.holds).toEqual([3478, 3478]);
    const failing = harness({ reviewsSeq: [[], [review(9, 'APPROVED', OTHER)]], applyHold: async () => ({ ok: false }) });
    const r2 = await failing.svc.start({ pr: 3478, headSha: HEAD, deviceId: null });
    expect(r2.body).toMatchObject({ held: false, detail: expect.stringMatching(/open it on GitHub now/i) });
  });
  it('one approval at a time', async () => {
    const h = harness({ lock: () => false });
    expect((await h.svc.start({ pr: 3478, headSha: HEAD, deviceId: null })).body.error).toBe('approval-in-progress');
  });
  it('a slow run answers 202 with its attempt id, then the GET reads the full answer', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { svc } = harness({ reviewsSeq: [[], [review(2, 'APPROVED', HEAD)]], runApprover: async () => { await gate; return { outcome: 'submitted' }; } });
    const r = await svc.start({ pr: 3478, headSha: HEAD, deviceId: null }, 20);
    expect(r.status).toBe(202);
    const id = r.body.attemptId as string;
    expect((await svc.runView(3478, id)).state).toBe('running');
    release();
    await new Promise((res) => setTimeout(res, 20));
    expect(await svc.runView(3478, id)).toMatchObject({ state: 'approved', reviewId: 2, attemptId: id });
  });
});

describe('restart reconciliation', () => {
  it('kills a leftover approver and settles the attempt from GitHub with its own baseline', async () => {
    const stored: ApprovalRun[] = [{ id: '00000000-0000-4000-8000-000000000001', pr: 3478, headSha: HEAD, state: 'running', startedAt: Date.now(), baseline: [1], pgid: 4242 }];
    const killed: number[] = [];
    const { svc } = harness({ runsStore: { load: () => stored, save: () => {} }, killGroup: (g) => { killed.push(g); }, reviewsSeq: [[review(1, 'APPROVED', OTHER), review(5, 'APPROVED', HEAD)]] });
    const v = await svc.runView(3478);
    expect(killed).toEqual([4242]);
    expect(v).toMatchObject({ state: 'approved', reviewId: 5 });
  });
  it('a new tap waits while an earlier attempt cannot be settled', async () => {
    const stored: ApprovalRun[] = [{ id: '00000000-0000-4000-8000-000000000002', pr: 3478, headSha: HEAD, state: 'running', startedAt: Date.now(), baseline: [] }];
    const { svc, calls } = harness({ runsStore: { load: () => stored, save: () => {} }, readReviews: async () => { throw new Error('down'); } });
    const r = await svc.start({ pr: 3478, headSha: HEAD, deviceId: null });
    expect(r.body.error).toBe('approval-unsettled');
    expect(calls.runApprover).toHaveLength(0);
  });
  it('an unknown PR reads as none with a plain instruction', async () => {
    expect(await harness().svc.runView(1)).toMatchObject({ state: 'none', detail: expect.stringMatching(/Tap Approve again/) });
  });
});

describe('production helpers', () => {
  it('parsePaginated joins gh --paginate pages', () => {
    expect(parsePaginated<number>('[1,2]\n[3]')).toEqual([1, 2, 3]);
    expect(parsePaginated<number>('[1,2][3]')).toEqual([1, 2, 3]);
    expect(parsePaginated<number>('')).toEqual([]);
  });
  it('the profile lock refuses a second taker and frees on unlock', () => {
    const l = profileLock();
    const dir = path.join(tmp, 'p');
    expect(l.lock(dir)).toBe(true);
    expect(l.lock(dir)).toBe(false);
    l.unlock(dir);
    expect(l.lock(dir)).toBe(true);
    l.unlock(dir);
  });
  it('the shipped script path exists', () => {
    expect(fs.existsSync(approverScriptPath())).toBe(true);
  });
  it('the approver gets secrets on stdin only: never argv, never env', async () => {
    const script = path.join(tmp, 'probe.mjs');
    const out = path.join(tmp, 'probe.json');
    fs.writeFileSync(script, `import fs from 'node:fs';\nlet b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(out)},JSON.stringify({argv:process.argv,env:process.env,stdin:JSON.parse(b)}));process.stdout.write(JSON.stringify({outcome:'submitted',step:7})+'\\n');});\n`);
    const r = await scriptApprover(script)({ password: 'PW-SECRET', totpSecret: 'TOTP-SECRET' }, 10_000);
    expect(r).toEqual({ outcome: 'submitted', step: 7 });
    const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
    expect(JSON.stringify(seen.argv)).not.toMatch(/SECRET/);
    expect(JSON.stringify(seen.env)).not.toMatch(/SECRET/);
    expect(seen.stdin.password).toBe('PW-SECRET');
  });
  it('the deadline kills the approver and reads as timeout', async () => {
    const script = path.join(tmp, 'slow.mjs');
    fs.writeFileSync(script, 'setTimeout(() => {}, 60000);\n');
    expect(await scriptApprover(script)({}, 300)).toEqual({ outcome: 'timeout' });
  });
});

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC test vector for SHA-1 at T=59 s', () => {
    // RFC 6238 Appendix B: secret "12345678901234567890" (ASCII), T=59 → 94287082 (8 digits); 6 digits → 287082.
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(base32Decode(secret).toString('ascii')).toBe('12345678901234567890');
    expect(totpAt(secret, Math.floor(59 / 30))).toBe('287082');
  });
});
