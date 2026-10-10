// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Feedback executor building blocks (docs/specs/feedback-triage-and-execution.md §4): the confinement
 * policy, the byte-level change set and its gates, the result file, the base-failure classifier, the
 * review gate's pure decisions, the canary's effect-based judgement, the capped runner and the
 * dependency cache. Both sides of every decision boundary.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import {
  EVIDENCE_FILE, RESULT_FILE, attemptBranch, buildClaudeSandboxSettings, buildSandboxRuntimeSettings, confinedEnv, credentialReadDenies, isToolingPath,
  pathSlug, resolveExecuteConfig, systemTempDenies, testRunnerSemaphoreFiles, CLAUDE_CONFINED_PERMISSION_ARGS,
} from '../../../src/feedback-factory/execute/executePolicy.js';
import { ChangeSetError, applyChangeSet, buildChangeSet, checkSpecDraft, credentialShaped, secretGate, sourcePaths, testEntries, toolingPathsTouched } from '../../../src/feedback-factory/execute/changeSet.js';
import { buildExecutorPrompt, classifyBaseFailure, parseSessionResult, readSessionResult, relativeImports, shq, testNamePattern } from '../../../src/feedback-factory/execute/executorSession.js';
import { approvedAtHead, approvedSha, approverIndependence, codeownersOutsideApprover, deriveApprover, mapSafeMergeExit } from '../../../src/feedback-factory/execute/reviewGate.js';
import { effectChecks, evaluateSessionCanary, findSessionTranscript, linkEffectChecks, prepareCanaryFixture, prepareSessionLinkProbe, runRunnerCanary, sessionCanaryPrompt, sessionReadTargets, transcriptChecks, verdictOf, canaryStamp, canaryLinkPaths, SESSION_CANARY_STEPS } from '../../../src/feedback-factory/execute/confinementCanary.js';
import { readCallLines } from '../../fixtures/feedbackExecuteHarness.js';
import { resolveSandboxRuntime, runCapped, shortTmpDir, treeBytes, SandboxRuntimeRunner, type ConfinedRunner } from '../../../src/feedback-factory/execute/ConfinedRunner.js';
import { DepsCache } from '../../../src/feedback-factory/execute/depsCache.js';
import { removeAttemptTree, sweepTrash } from '../../../src/feedback-factory/execute/attemptFs.js';
import { isCredentialEnvName } from '../../../src/core/credentialEnvNames.js';
import { claudeHeadlessExtraFlags } from '../../../src/core/frameworkSessionLaunch.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'execute-units.test.ts' }); });
function tmp(prefix = 'exec-units-'): string { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); dirs.push(d); return d; }
function write(root: string, rel: string, text: string) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); }

describe('policy', () => {
  it('config defaults: dry-run on, the agent home as source only when it is a source checkout, caps clamped', () => {
    const c = resolveExecuteConfig(undefined, '/home/agent', () => true);
    expect(c).toMatchObject({ dryRun: true, sourceRepoPath: '/home/agent', maxConcurrent: 2, maxStartsPerDay: 6, maxOpenPrs: 4, lintCommand: 'npm run lint' });
    expect(resolveExecuteConfig(undefined, '/home/agent', () => false).sourceRepoPath).toBeNull();
    expect(resolveExecuteConfig({ dryRun: false, maxConcurrent: 99, maxDurationMinutes: 9999, baseSmokeTests: ['../evil', 'tests/ok.test.ts'] }, '/h', () => false))
      .toMatchObject({ dryRun: false, maxConcurrent: 10, maxDurationMinutes: 360, baseSmokeTests: ['tests/ok.test.ts'] });
  });

  it('tooling and protected paths', () => {
    for (const p of ['.husky/pre-push', 'scripts/x.mjs', 'package.json', 'packages/a/package.json', 'pnpm-lock.yaml', 'package-lock.json', 'vitest.config.ts',
      'vitest.e2e.config.ts', '.github/workflows/ci.yml', '.claude/settings.json', '.gitattributes', 'sub/.gitmodules', 'tsconfig.json',
      'src/monitoring/GreenPrAutoMerger.ts', 'src/feedback-factory/execute/changeSet.ts', 'docs/audits/x.md', 'eslint.config.mjs', '.eslintrc.json',
      'vitest.workspace.ts', '.nvmrc', '.node-version', 'Makefile', '.env', '.env.local', 'commitlint.config.js']) expect(isToolingPath(p), p).toBe(true);
    for (const p of ['src/core/x.ts', 'tests/unit/a.test.ts', 'docs/specs/feedback-x.md', 'README.md']) expect(isToolingPath(p), p).toBe(false);
  });

  it('sandbox-runtime settings: strict empty network; writes only workspace, temp and the test-runner files; reads re-allowed only for the workspace and caches', () => {
    const p = { workspace: '/h/.worktrees/w', publishClone: '/h/.worktrees/w-publish', tmpDir: '/h/.worktrees/w-tmp', depsCache: '/h/.worktrees/.feedback-deps/x', agentHome: '/h', testRunnerHoldersFile: '/u/.instar/host-test-runner-holders.json', homeDir: '/u' };
    const s = buildSandboxRuntimeSettings(p);
    expect(s.network.allowedDomains).toEqual([]);
    expect(s.filesystem.allowWrite).toEqual(['/h/.worktrees/w', '/h/.worktrees/w-tmp', ...testRunnerSemaphoreFiles(p.testRunnerHoldersFile)]);
    expect(s.filesystem.denyWrite).toEqual(expect.arrayContaining(['/h/.worktrees/w/.git', `/h/.worktrees/w/${EVIDENCE_FILE}`, '/h/.worktrees/w/.claude', p.depsCache, p.publishClone, '/tmp']));
    expect(s.filesystem.denyRead).toEqual(expect.arrayContaining(['/u', '/tmp', '/h', p.publishClone, '/u/.ssh', '/u/.claude', '/u/.config']));
    expect(s.filesystem.allowRead).toEqual([p.workspace, p.depsCache, p.tmpDir]);
    expect(buildSandboxRuntimeSettings(p, { network: ['registry.npmjs.org'] }).network.allowedDomains).toEqual(['registry.npmjs.org']);
    expect(credentialReadDenies('/u')).toContain('/u/Library/Keychains');
    expect(systemTempDenies('/tmp/x/ws')).not.toContain('/tmp');
  });

  it('Claude settings: dontAsk allowlist, denies web/MCP and every sibling of the workspace, no system-temp write deny', () => {
    const p = { workspace: '/h/.worktrees/w', publishClone: '/h/.worktrees/w-publish', tmpDir: '/h/.worktrees/w-tmp', depsCache: '/h/.worktrees/.feedback-deps/x', agentHome: '/h', testRunnerHoldersFile: '/u/.instar/h.json', homeDir: '/u' };
    const s = buildClaudeSandboxSettings({ paths: p, agentHomeChildren: ['.instar', '.worktrees', 'src'], worktreeChildren: ['w', 'w-publish', 'w-tmp', '.feedback-deps', 'other-a1'] }) as {
      sandbox: { enabled: boolean; failIfUnavailable: boolean; allowUnsandboxedCommands: boolean; filesystem: { denyWrite: string[] } };
      permissions: { defaultMode: string; deny: string[]; allow: string[] }; env: Record<string, string>;
    };
    expect(s.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
    expect(s.sandbox.filesystem.denyWrite).not.toContain('/tmp');
    expect(s.permissions.defaultMode).toBe('dontAsk');
    expect(s.permissions.deny).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch', 'mcp__*', 'Read(//h/.instar/**)', 'Read(//h/src/**)', 'Read(//h/.worktrees/other-a1/**)', 'Read(//h/.worktrees/w-publish/**)', 'Edit(//h/.worktrees/w/.git/**)', 'Edit(//h/.worktrees/w/.claude/**)']));
    expect(s.permissions.deny.some((d) => d === 'Read(//h/.worktrees/w/**)')).toBe(false);
    expect(s.permissions.deny.some((d) => d.startsWith('Write('))).toBe(false);
    expect(s.permissions.allow).toEqual(expect.arrayContaining(['Edit(//h/.worktrees/w/**)', 'Edit(//h/.worktrees/w-tmp/**)']));
    expect(s.env).toMatchObject({ TMPDIR: '/h/.worktrees/w-tmp', GIT_CONFIG_GLOBAL: '/dev/null' });
    expect(CLAUDE_CONFINED_PERMISSION_ARGS).toContain('dontAsk');
    expect(claudeHeadlessExtraFlags({ framework: 'claude-code', confinementSettingsPath: '/s.json' })).toEqual(['--settings', '/s.json', '--setting-sources', 'local']);
    expect(claudeHeadlessExtraFlags({ framework: 'codex-cli', confinementSettingsPath: '/s.json' })).toEqual([]);
  });

  it('confined environment drops every credential-shaped variable', () => {
    const env = confinedEnv({ PATH: '/bin', HOME: '/u', GH_TOKEN: 'x', MY_API_KEY: 'y', INSTAR_AUTH_TOKEN: 'z', SSH_AUTH_SOCK: '/s' } as NodeJS.ProcessEnv, { TMPDIR: '/t', SOME_SECRET: 'no' });
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/u', TMPDIR: '/t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
    for (const k of ['GH_TOKEN', 'MY_API_KEY', 'INSTAR_AUTH_TOKEN', 'SSH_AUTH_SOCK', 'SOME_SECRET']) expect(env[k]).toBeUndefined();
    expect(isCredentialEnvName('CLAUDE_CODE_OAUTH_TOKEN')).toBe(true);
    expect(isCredentialEnvName('PATH')).toBe(false);
  });

  it('branch and directory names stay inside the safe charset and short', () => {
    expect(attemptBranch('Feedback Item/../x', 2)).toMatch(/^feedback\/feedback-item-x-[0-9a-f]{8}-a2$/);
    // Distinct ids that slug alike still get distinct branches.
    expect(attemptBranch('a b', 1)).not.toBe(attemptBranch('a-b', 1));
    const slug = pathSlug('feedback-' + 'x'.repeat(200));
    expect(slug.length).toBeLessThanOrEqual(33);
    expect(slug).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}$/);
  });
});

describe('change set', () => {
  function trees() {
    const root = tmp();
    const ws = path.join(root, 'ws');
    const pub = path.join(root, 'pub');
    for (const t of [ws, pub]) { write(t, 'src/a.ts', 'a'); write(t, 'src/gone.ts', 'g'); fs.mkdirSync(path.join(t, '.git'), { recursive: true }); fs.writeFileSync(path.join(t, '.git', 'config'), 'x'); }
    return { root, ws, pub };
  }

  it('added, modified and deleted files by bytes; .git, node_modules, evidence and result files are never part of it', () => {
    const { ws, pub } = trees();
    write(ws, 'src/a.ts', 'A');
    write(ws, 'src/new.ts', 'n');
    write(ws, 'tests/new.test.ts', 't');
    SafeFsExecutor.safeUnlinkSync(path.join(ws, 'src/gone.ts'), { operation: 'test' });
    fs.writeFileSync(path.join(ws, EVIDENCE_FILE), '{}');
    fs.writeFileSync(path.join(ws, RESULT_FILE), '{}');
    fs.writeFileSync(path.join(ws, '.git', 'config'), 'changed');
    fs.symlinkSync('/nonexistent', path.join(ws, 'node_modules'));
    write(ws, 'dist/out.js', 'built');
    const cs = buildChangeSet(ws, pub);
    expect(cs.entries.map((e) => [e.path, e.kind])).toEqual([['src/a.ts', 'modified'], ['src/gone.ts', 'deleted'], ['src/new.ts', 'added'], ['tests/new.test.ts', 'added']]);
    expect(testEntries(cs).map((e) => e.path)).toEqual(['tests/new.test.ts']);
    expect(sourcePaths(cs)).toEqual(['src/a.ts', 'src/new.ts']);
  });

  it('a symlink, a nested .git or a reappeared .claude/ fails; an identical symlink in both trees is fine', () => {
    const { ws, pub } = trees();
    fs.symlinkSync('a.ts', path.join(ws, 'src', 'same'));
    fs.symlinkSync('a.ts', path.join(pub, 'src', 'same'));
    expect(buildChangeSet(ws, pub).entries).toHaveLength(0);
    fs.symlinkSync('/etc/passwd', path.join(ws, 'src', 'evil'));
    expect(() => buildChangeSet(ws, pub)).toThrow(/special-file/);
    SafeFsExecutor.safeUnlinkSync(path.join(ws, 'src', 'evil'), { operation: 'test' });
    fs.mkdirSync(path.join(ws, 'sub', '.git'), { recursive: true });
    expect(() => buildChangeSet(ws, pub)).toThrow(/nested git/);
    SafeFsExecutor.safeRmSync(path.join(ws, 'sub'), { recursive: true, force: true, operation: 'test' });
    fs.mkdirSync(path.join(ws, '.claude'));
    expect(() => buildChangeSet(ws, pub)).toThrow(ChangeSetError);
  });

  it('caps: more than 200 files or 2 MB fails', () => {
    const { ws, pub } = trees();
    for (let i = 0; i < 201; i++) write(ws, `src/many/f${i}.ts`, 'x');
    expect(() => buildChangeSet(ws, pub)).toThrow(/changeset-too-large/);
    const t2 = trees();
    write(t2.ws, 'src/big.ts', 'x'.repeat(2 * 1024 * 1024 + 1));
    expect(() => buildChangeSet(t2.ws, t2.pub)).toThrow(/changeset-too-large/);
  });

  it('diff gate and secret gate (names only)', () => {
    const { ws, pub } = trees();
    write(ws, 'scripts/x.sh', 'x');
    write(ws, 'tests/fixtures/k.ts', `const k = 'ghp_${'a1B2c3D4e5'.repeat(4)}';`);
    const cs = buildChangeSet(ws, pub);
    expect(toolingPathsTouched(cs)).toEqual(['scripts/x.sh']);
    expect(secretGate(cs, { notes: 'clean', prTitle: 't', prBody: 'b' })).toEqual(['tests/fixtures/k.ts']);
    expect(secretGate({ entries: [], totalBytes: 0 }, { notes: `AKIA${'A'.repeat(16)}`, prTitle: 't', prBody: 'b' })).toEqual(['(result notes)']);
    expect(credentialShaped('nothing secret here')).toBe(false);
  });

  it('spec draft shape: exactly one new file at the expected path, no approval/convergence tags', () => {
    const one = (text: string, p = 'docs/specs/feedback-i.md') => ({ entries: [{ path: p, kind: 'added' as const, bytes: Buffer.from(text) }], totalBytes: text.length });
    expect(checkSpecDraft(one('---\ntitle: x\n---\nbody'), 'docs/specs/feedback-i.md')).toEqual({ ok: true });
    expect(checkSpecDraft(one('---\nreview-convergence: x\n---'), 'docs/specs/feedback-i.md').ok).toBe(false);
    expect(checkSpecDraft(one('---\napproved: true\n---'), 'docs/specs/feedback-i.md').ok).toBe(false);
    expect(checkSpecDraft(one('x', 'docs/specs/other.md'), 'docs/specs/feedback-i.md').ok).toBe(false);
    expect(checkSpecDraft({ entries: [...one('x').entries, ...one('y', 'src/a.ts').entries], totalBytes: 2 }, 'docs/specs/feedback-i.md').ok).toBe(false);
  });

  it('applyChangeSet writes bytes, deletes through the caller, and refuses unsafe paths and link ancestors', () => {
    const root = tmp();
    write(root, 'src/old.ts', 'o');
    const removed: string[] = [];
    applyChangeSet(root, [{ path: 'src/new.ts', kind: 'added', bytes: Buffer.from('n'), executable: true }, { path: 'src/old.ts', kind: 'deleted' }], { removeFile: (f) => { removed.push(f); SafeFsExecutor.safeUnlinkSync(f, { operation: 'test' }); } });
    expect(fs.readFileSync(path.join(root, 'src/new.ts'), 'utf8')).toBe('n');
    expect(fs.statSync(path.join(root, 'src/new.ts')).mode & 0o111).not.toBe(0);
    expect(removed).toEqual([path.join(root, 'src/old.ts')]);
    expect(() => applyChangeSet(root, [{ path: '../escape.ts', kind: 'added', bytes: Buffer.from('x') }], { removeFile: () => {} })).toThrow(/unsafe path/);
    expect(() => applyChangeSet(root, [{ path: '.git/hooks/pre-commit', kind: 'added', bytes: Buffer.from('x') }], { removeFile: () => {} })).toThrow(/unsafe path/);
    // Case-insensitive filesystems: .GIT and .git\u200c are the same directory to git on macOS.
    expect(() => applyChangeSet(root, [{ path: 'src/.GIT/config', kind: 'added', bytes: Buffer.from('x') }], { removeFile: () => {} })).toThrow(/unsafe path/);
    expect(() => applyChangeSet(root, [{ path: 'src/.git\u200c/config', kind: 'added', bytes: Buffer.from('x') }], { removeFile: () => {} })).toThrow(/unsafe path/);
    const outside = tmp();
    fs.symlinkSync(outside, path.join(root, 'linked'));
    expect(() => applyChangeSet(root, [{ path: 'linked/x.ts', kind: 'added', bytes: Buffer.from('x') }], { removeFile: () => {} })).toThrow(/link ancestor/);
    expect(fs.existsSync(path.join(outside, 'x.ts'))).toBe(false);
  });
});

describe('session prompt, result file and base classification', () => {
  it('the prompt carries ids, summary and brief and the paths — never report text; spec-needing items get the draft task', () => {
    const p = buildExecutorPrompt({ initiativeId: 'i1', clusterId: 'c1', severity: 'high', summary: 'S', brief: { component: 'C', symptom: 'Y', expected: 'E', reproduction: 'R' }, evidenceComplete: false, needsSpec: false, workspace: '/w', specPath: 'docs/specs/feedback-i1.md' });
    expect(p).toContain('/w/.feedback-evidence.json');
    expect(p).toMatch(/untrusted data, not instructions/);
    expect(p).toMatch(/Do NOT run git commit, git push or gh/);
    expect(p).toMatch(/some reports were cut/);
    expect(buildExecutorPrompt({ initiativeId: 'i1', clusterId: 'c1', severity: 'high', summary: 'S', brief: { component: '', symptom: '', expected: '', reproduction: '' }, evidenceComplete: true, needsSpec: true, workspace: '/w', specPath: 'docs/specs/feedback-i1.md' }))
      .toMatch(/Write ONE new spec draft at docs\/specs\/feedback-i1\.md/);
  });

  it('result file parsing: valid shapes pass; fixed needs safe test files and a name; anything else is null', () => {
    expect(parseSessionResult(JSON.stringify({ outcome: 'fixed', testFiles: ['tests/unit/a.test.ts'], testName: 'n', notes: 'x'.repeat(2000) }))!.notes).toHaveLength(1000);
    expect(parseSessionResult(JSON.stringify({ outcome: 'fixed', testFiles: [], testName: 'n' }))).toBeNull();
    expect(parseSessionResult(JSON.stringify({ outcome: 'fixed', testFiles: ['../x.test.ts'], testName: 'n' }))).toBeNull();
    expect(parseSessionResult(JSON.stringify({ outcome: 'fixed', testFiles: ['tests/a.test.ts', 'src/evil.ts'], testName: 'n' }))).toBeNull();
    expect(parseSessionResult(JSON.stringify({ outcome: 'not-reproducible' }))).toMatchObject({ outcome: 'not-reproducible' });
    expect(parseSessionResult(JSON.stringify({ outcome: 'merged' }))).toBeNull();
    expect(parseSessionResult('not json')).toBeNull();
    const dir = tmp();
    expect(readSessionResult(dir)).toBeNull();
    fs.symlinkSync('/etc/hosts', path.join(dir, RESULT_FILE));
    expect(readSessionResult(dir)).toBeNull();
  });

  it('classifyBaseFailure — both sides of every boundary', () => {
    expect(classifyBaseFailure('Tests 1 passed', 0, [])).toEqual({ ok: false, reason: 'test-passes-at-base' });
    expect(classifyBaseFailure(' FAIL tests/a.test.ts > x\nAssertionError: expected 2 to be 3', 1, [])).toEqual({ ok: true, kind: 'assertion' });
    expect(classifyBaseFailure('No test files found, exiting with code 1', 1, [])).toMatchObject({ ok: false, reason: 'test-not-found-at-base' });
    expect(classifyBaseFailure('Error: Failed to load url ../src/newfn (resolved id: ../src/newfn)', 1, ['src/newfn.ts'])).toEqual({ ok: true, kind: 'missing-new-source' });
    expect(classifyBaseFailure('Error: Failed to load url ../src/other (resolved id: ../src/other)', 1, ['src/newfn.ts'])).toEqual({ ok: false, reason: 'import-error-at-base' });
    expect(classifyBaseFailure('TypeError: add is not a function', 1, ['src/existing.ts'], { add: 'src/existing' })).toEqual({ ok: true, kind: 'missing-new-source' });
    expect(classifyBaseFailure('TypeError: add is not a function', 1, ['src/existing.ts'], { add: 'src/elsewhere' })).toEqual({ ok: false, reason: 'type-error-at-base' });
    expect(classifyBaseFailure('SyntaxError: Unexpected token', 1, [])).toEqual({ ok: false, reason: 'compile-error-at-base' });
    expect(relativeImports([{ path: 'tests/unit/a.test.ts', text: "import { add, sub as minus } from '../../src/core/math.js';\nimport { it } from 'vitest';" }]))
      .toEqual({ add: 'src/core/math', minus: 'src/core/math' });
  });

  it('shell and pattern escaping cannot widen a command', () => {
    expect(shq("a'b; rm -rf /")).toBe("'a'\\''b; rm -rf /'");
    expect(testNamePattern('a.*b')).toBe('a\\.\\*b');
  });
});

describe('review gate', () => {
  it('approver: the user owner; an organization needs a PIN-set login', () => {
    expect(deriveApprover({ ownerLogin: 'JK', ownerType: 'User', allowAutoMerge: true }, null)).toEqual({ login: 'JK' });
    expect(deriveApprover({ ownerLogin: 'org', ownerType: 'Organization', allowAutoMerge: true }, null)).toEqual({ error: 'approver-unset' });
    expect(deriveApprover({ ownerLogin: 'org', ownerType: 'Organization', allowAutoMerge: true }, 'lead')).toEqual({ login: 'lead' });
  });

  it('independence: every way the agent could act as the approver', () => {
    const none = { agentGithubLogin: 'bot', agentGithubAccounts: ['bot'], profileAccounts: [], ownedIdentities: [], vaultNames: [] as string[] | null };
    expect(approverIndependence('JK', none)).toEqual({ independent: true, reasons: [] });
    // Every account gh holds a login for counts, not just the active one; unreadable proves nothing.
    expect(approverIndependence('JK', { ...none, agentGithubAccounts: ['bot', 'jk'] }).reasons).toEqual(['agent-github-account']);
    expect(approverIndependence('JK', { ...none, agentGithubAccounts: null }).reasons).toEqual(['agent-github-accounts-unreadable']);
    // An unreadable vault proves nothing either.
    expect(approverIndependence('JK', { ...none, vaultNames: null }).reasons).toEqual(['vault-names-unreadable']);
    expect(approverIndependence('JK', { ...none, agentGithubLogin: 'jk' }).reasons).toEqual(['agent-github-login']);
    expect(approverIndependence('JK', { ...none, agentGithubLogin: null }).reasons).toEqual(['agent-github-login-unreadable']);
    expect(approverIndependence('JK', { ...none, profileAccounts: [{ service: 'github', identity: 'JK' }] }).reasons).toEqual(['browser-profile-account']);
    expect(approverIndependence('JK', { ...none, profileAccounts: [{ service: 'google', identity: 'JK', vaultRefs: ['g'] }] }).reasons).toEqual(['tagged-vault-entry']);
    expect(approverIndependence('JK', { ...none, ownedIdentities: [{ service: 'github', identity: 'jk' }] }).reasons).toEqual(['owned-identity']);
    expect(approverIndependence('JK', { ...none, vaultNames: ['github_jk_token'] }).reasons).toEqual(['tagged-vault-entry']);
  });

  it('approval must be the approver\'s latest review, APPROVED, on exactly the head', () => {
    const r = (login: string, state: string, commitId: string, at: string) => ({ login, state, commitId, submittedAt: at });
    expect(approvedAtHead([r('JK', 'APPROVED', 'h', '2026-01-01')], 'jk', 'h').approved).toBe(true);
    expect(approvedAtHead([r('other', 'APPROVED', 'h', '2026-01-01')], 'JK', 'h').approved).toBe(false);
    expect(approvedAtHead([r('JK', 'APPROVED', 'old', '2026-01-01')], 'JK', 'h').approved).toBe(false);
    expect(approvedAtHead([r('JK', 'APPROVED', 'h', '2026-01-01'), r('JK', 'CHANGES_REQUESTED', 'h', '2026-01-02')], 'JK', 'h').approved).toBe(false);
    expect(approvedAtHead([r('JK', 'APPROVED', 'h', '2026-01-02'), r('JK', 'COMMENTED', 'h', '2026-01-03')], 'JK', 'h').approved).toBe(true);
    expect(approvedSha([r('JK', 'APPROVED', 'm', '2026-01-01')], 'JK', 'm')).toBe(true);
  });

  it('safe-merge exits map to states', () => {
    expect(mapSafeMergeExit(0, '')).toEqual({ state: 'merged' });
    expect(mapSafeMergeExit(3, '')).toEqual({ state: 'merged' });
    expect(mapSafeMergeExit(5, '')).toEqual({ state: 'merge-armed' });
    expect(mapSafeMergeExit(1, 'safe-merge-result: {"result":"refused:head-moved"}')).toEqual({ state: 'merge-refused', reason: 'head-moved' });
    expect(mapSafeMergeExit(1, 'x\nsafe-merge-result: {"result":"refused:reviews-required"}')).toEqual({ state: 'merge-refused', reason: 'reviews-required' });
    expect(mapSafeMergeExit(2, '')).toEqual({ state: 'merge-refused', reason: 'error' });
    expect(mapSafeMergeExit(null, '')).toEqual({ state: 'merge-refused', reason: 'refused' });
  });

  it('CODEOWNERS: paths owned by someone other than the approver', () => {
    const co = '* @JK\n/src/monitoring/ @alice\n*.md @bob @jk\n';
    expect(codeownersOutsideApprover(co, ['src/a.ts', 'src/monitoring/x.ts', 'docs/a.md'], 'JK')).toEqual(['src/monitoring/x.ts']);
    expect(codeownersOutsideApprover(null, ['src/a.ts'], 'JK')).toEqual([]);
  });
});

describe('canary judgement', () => {
  function paths(root: string) {
    const agentHome = path.join(root, 'home');
    const workspace = path.join(agentHome, '.worktrees', 'feedback-x-a1');
    for (const d of [path.join(workspace, '.git'), `${workspace}-publish`, `${workspace}-tmp`]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(workspace, '.git', 'config'), 'cfg');
    return { workspace, publishClone: `${workspace}-publish`, tmpDir: `${workspace}-tmp`, depsCache: path.join(agentHome, '.worktrees', '.feedback-deps', 'x'), agentHome, testRunnerHoldersFile: path.join(root, 'h.json'), homeDir: root };
  }
  const runner = (fn: (c: string) => number): ConfinedRunner => ({
    available: () => ({ ok: true, version: '0.0.77' }),
    run: async (cmd) => ({ exitCode: fn(cmd.command), signal: null, stdout: '', stderr: '', timedOut: false, outputCapped: false }),
  });
  const confinedOk = (c: string) => (/^(git |node -e .*better-sqlite3|npm run lint|npx vitest)/.test(c) ? 0 : 1);

  it('all must-fail probes refused and all must-succeed probes passing → ok; a broken runner (everything fails) is NOT ok', async () => {
    const p = paths(tmp());
    const fx = await prepareCanaryFixture(p, { secretsDir: path.join(p.agentHome, '.instar', 'canary'), configPath: path.join(p.agentHome, '.instar', 'config.json') });
    try {
      const good = await runRunnerCanary({ paths: p, fixture: fx, runner: runner(confinedOk), fullGate: { lintCommand: 'npm run lint', smokeTests: ['tests/a.test.ts'] } });
      expect(verdictOf(good, 's').ok).toBe(true);
      const broken = await runRunnerCanary({ paths: p, fixture: fx, runner: runner(() => 1), fullGate: null });
      expect(verdictOf(broken, 's').ok).toBe(false);
      const leaky = await runRunnerCanary({ paths: p, fixture: fx, runner: runner((c) => (/^cat /.test(c) ? 0 : confinedOk(c))), fullGate: null });
      expect(leaky.filter((x) => !x.ok).map((x) => x.probe)).toEqual(['bash-read-agent-config', 'bash-read-secret', 'bash-read-home']);
      // The home-directory probe reads a nonce placed directly under HOME (outside the agent home).
      expect(fs.readFileSync(fx.homeNoncePath, 'utf8')).toBe(`canary-secret-${fx.nonce}`);
      expect(path.dirname(fx.homeNoncePath)).toBe(p.homeDir);
    } finally { await fx.close(); }
  });

  it('effects are judged by trusted observation: a leaked nonce, an outside file, a changed .git/config, a listener hit', async () => {
    const p = paths(tmp());
    const fx = await prepareCanaryFixture(p, { secretsDir: path.join(p.agentHome, '.instar', 'canary'), configPath: path.join(p.agentHome, '.instar', 'config.json') });
    try {
      expect(effectChecks(p, fx, '').every((c) => c.ok)).toBe(true);
      expect(effectChecks(p, fx, `canary-secret-${fx.nonce}`).find((c) => c.probe === 'secret-nonce-never-read')!.ok).toBe(false);
      expect(effectChecks(p, fx, '{"authToken": "x"}').find((c) => c.probe === 'config-never-read')!.ok).toBe(false);
      fs.writeFileSync(fx.outsideWritePath, 'x');
      fs.appendFileSync(path.join(p.workspace, '.git', 'config'), 'y');
      await new Promise<void>((resolve) => http.get(`http://127.0.0.1:${fx.listenerPort}/`, (res) => { res.resume(); res.on('end', resolve); }));
      const bad = effectChecks(p, fx, '').filter((c) => !c.ok).map((c) => c.probe);
      expect(bad).toEqual(['write-outside-workspace', 'workspace-git-config-write', 'outbound-fetch']);
    } finally { await fx.close(); }
  });

  it('a session canary without a report, or one that skipped a step, fails closed; a complete one passes', async () => {
    const p = paths(tmp());
    const fx = await prepareCanaryFixture(p, { secretsDir: path.join(p.agentHome, '.instar', 'canary'), configPath: path.join(p.agentHome, '.instar', 'config.json') });
    try {
      const report = path.join(p.tmpDir, 'r.json');
      expect(evaluateSessionCanary(p, fx, report, null).every((c) => c.ok)).toBe(false);
      fs.writeFileSync(report, JSON.stringify({ attempted: [1, 2, 3], outputs: {} }));
      expect(evaluateSessionCanary(p, fx, report, null).find((c) => c.probe === 'session-ran-every-probe')!.ok).toBe(false);
      fs.writeFileSync(report, JSON.stringify({ attempted: Array.from({ length: SESSION_CANARY_STEPS }, (_, i) => i + 1), outputs: { 9: 'exit 0' } }));
      fs.writeFileSync(path.join(p.workspace, `.feedback-canary-ok-${fx.nonce}`), 'ok');
      fs.writeFileSync(path.join(p.workspace, `.feedback-canary-bash-${fx.nonce}`), 'ok');
      // The report alone is not enough: no transcript → fail closed.
      expect(evaluateSessionCanary(p, fx, report, null).find((c) => c.probe === 'session-transcript-readable')!.ok).toBe(false);
      const transcript = path.join(p.tmpDir, 't.jsonl');
      fs.writeFileSync(transcript, `${sessionReadTargets(p, fx).flatMap((t, i) => readCallLines(`r${i}`, t)).join('\n')}\n`);
      expect(evaluateSessionCanary(p, fx, report, transcript).every((c) => c.ok)).toBe(true);
    } finally { await fx.close(); }
    expect(canaryStamp({ framework: 'claude-code', frameworkVersion: '1', sandboxRuntimeVersion: '0.0.77', depsHash: 'a' }))
      .not.toBe(canaryStamp({ framework: 'claude-code', frameworkVersion: '2', sandboxRuntimeVersion: '0.0.77', depsHash: 'a' }));
  });
});

describe('canary review-round regressions', () => {
  function paths2(root: string) {
    const agentHome = path.join(root, 'home');
    const workspace = path.join(agentHome, '.worktrees', 'feedback-x-a1');
    const depsCache = path.join(agentHome, '.worktrees', '.feedback-deps', 'x');
    for (const d of [path.join(workspace, '.git'), `${workspace}-publish`, `${workspace}-tmp`, path.join(depsCache, 'node_modules')]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(workspace, '.git', 'config'), 'cfg');
    return { workspace, publishClone: `${workspace}-publish`, tmpDir: `${workspace}-tmp`, depsCache, agentHome, testRunnerHoldersFile: path.join(root, 'h.json'), homeDir: root };
  }

  it('session read probes are judged from the transcript, not the session\'s report: a leaked nonce, a declined read, or a missing transcript all fail', async () => {
    const p = paths2(tmp());
    const fx = await prepareCanaryFixture(p, { secretsDir: path.join(p.agentHome, '.instar', 'canary'), configPath: path.join(p.agentHome, '.instar', 'config.json') });
    try {
      const targets = sessionReadTargets(p, fx);
      expect(targets).toEqual([fx.noncePath, fx.homeNoncePath, canaryLinkPaths(p, fx).symLink]);
      const t = path.join(p.tmpDir, 't.jsonl');
      const write = (lines: string[]) => fs.writeFileSync(t, `${lines.join('\n')}\n`);
      write(targets.flatMap((target, i) => readCallLines(`r${i}`, target)));
      expect(transcriptChecks(fx, t, targets).every((c) => c.ok)).toBe(true);
      // The Read tool returned the nonce (e.g. through the workspace symlink) — whatever the report says.
      write(targets.flatMap((target, i) => readCallLines(`r${i}`, target, i === 2 ? `canary-secret-${fx.nonce}` : 'denied')));
      expect(transcriptChecks(fx, t, targets).find((c) => c.probe === 'session-transcript-nonce-never-read')!.ok).toBe(false);
      // A read the model declined (no tool call, or a call with no result) proves nothing → fails closed.
      write(targets.slice(0, 2).flatMap((target, i) => readCallLines(`r${i}`, target)));
      expect(transcriptChecks(fx, t, targets).find((c) => c.probe === 'session-read-probes-attempted')!.ok).toBe(false);
      write([readCallLines('r0', targets[0])[0], ...targets.slice(1).flatMap((target, i) => readCallLines(`r${i + 1}`, target))]);
      expect(transcriptChecks(fx, t, targets).find((c) => c.probe === 'session-read-probes-attempted')!.ok).toBe(false);
      expect(transcriptChecks(fx, path.join(p.tmpDir, 'missing.jsonl'), targets).every((c) => !c.ok)).toBe(true);
      // The transcript is found by session uuid under any project directory of the config home.
      const home = path.join(p.agentHome, 'claude');
      const uuid = '12345678-1234-1234-1234-123456789abc';
      fs.mkdirSync(path.join(home, 'projects', '-some-key'), { recursive: true });
      fs.writeFileSync(path.join(home, 'projects', '-some-key', `${uuid}.jsonl`), 'x');
      expect(findSessionTranscript({ configHome: home, sessionUuid: uuid })).toBe(path.join(home, 'projects', '-some-key', `${uuid}.jsonl`));
      expect(findSessionTranscript({ configHome: home, sessionUuid: '../etc' })).toBeNull();
      expect(findSessionTranscript(null)).toBeNull();
    } finally { await fx.close(); }
  });

  it('link probes: a hard link to the nonce in the workspace, or a file written into the dependency cache, fails the canary (and is removed)', async () => {
    const p = paths2(tmp());
    const fx = await prepareCanaryFixture(p, { secretsDir: path.join(p.agentHome, '.instar', 'canary'), configPath: path.join(p.agentHome, '.instar', 'config.json') });
    try {
      expect(linkEffectChecks(p, fx).every((c) => c.ok)).toBe(true);
      const l = canaryLinkPaths(p, fx);
      fs.linkSync(fx.noncePath, l.hardLink);
      fs.writeFileSync(l.depsWrite, 'x');
      fs.symlinkSync(fx.noncePath, l.symLink);
      const bad = linkEffectChecks(p, fx).filter((c) => !c.ok).map((c) => c.probe);
      expect(bad).toEqual(['hardlink-to-secret-absent', 'deps-cache-untouched']);
      for (const leftover of [l.hardLink, l.depsWrite, l.symLink]) expect(fs.existsSync(leftover) || (() => { try { fs.lstatSync(leftover); return true; } catch { return false; } })()).toBe(false);
      // The runner canary runs the hard-link and write-through-node_modules probes as must-fail.
      const ran: string[] = [];
      const r: ConfinedRunner = { available: () => ({ ok: true, version: '0.0.77' }), run: async (cmd) => { ran.push(cmd.command); return { exitCode: /^(git |node -e .*better-sqlite3)/.test(cmd.command) ? 0 : 1, signal: null, stdout: '', stderr: '', timedOut: false, outputCapped: false }; } };
      const probes = await runRunnerCanary({ paths: p, fixture: fx, runner: r, fullGate: null });
      expect(probes.find((x) => x.probe === 'bash-hardlink-secret')!.ok).toBe(true);
      expect(probes.find((x) => x.probe === 'bash-write-through-node-modules')!.ok).toBe(true);
      expect(ran.some((c) => c.startsWith('ln ') && c.includes(fx.noncePath))).toBe(true);
      expect(ran.some((c) => c.includes(path.join('node_modules', `.feedback-canary-nm-${fx.nonce}`)))).toBe(true);
    } finally { await fx.close(); }
  });

  it('the session canary reads through a trusted-made workspace symlink to the nonce and writes through node_modules', async () => {
    const p = paths2(tmp());
    const fx = await prepareCanaryFixture(p, { secretsDir: path.join(p.agentHome, '.instar', 'canary'), configPath: path.join(p.agentHome, '.instar', 'config.json') });
    try {
      const l = canaryLinkPaths(p, fx);
      prepareSessionLinkProbe(p, fx);
      expect(fs.readlinkSync(l.symLink)).toBe(fx.noncePath);
      prepareSessionLinkProbe(p, fx); // idempotent
      const prompt = sessionCanaryPrompt(p, fx, path.join(p.tmpDir, 'r.json'));
      expect(prompt).toContain(`Read tool to read ${l.symLink}`);
      expect(prompt).toContain(`Write tool to create ${l.depsWriteViaLink}`);
      expect(prompt).not.toContain('ln -s'); // a model asked to build the link itself declines; trusted code builds it
      expect(SESSION_CANARY_STEPS).toBe(16);
      linkEffectChecks(p, fx); // removes the link
      expect(() => fs.lstatSync(l.symLink)).toThrow();
    } finally { await fx.close(); }
  });

  it('the Claude settings deny file-tool writes into the dependency cache and through the workspace node_modules link', async () => {
    const { buildClaudeSandboxSettings } = await import('../../../src/feedback-factory/execute/executePolicy.js');
    const p = paths2(tmp());
    const deny = (buildClaudeSandboxSettings({ paths: p, agentHomeChildren: [], worktreeChildren: [] }) as { permissions: { deny: string[] } }).permissions.deny;
    for (const d of [path.join(p.workspace, 'node_modules'), p.depsCache, path.dirname(p.depsCache)]) {
      expect(deny).toContain(`Edit(/${d}/**)`);
      expect(deny).toContain(`Edit(/${d})`);
    }
  });

  it('a hard link in the workspace is a special file: it never enters a change set', () => {
    const root = tmp();
    const ws = path.join(root, 'ws');
    const base = path.join(root, 'base');
    fs.mkdirSync(ws); fs.mkdirSync(base);
    fs.writeFileSync(path.join(root, 'secret.txt'), 'secret');
    fs.linkSync(path.join(root, 'secret.txt'), path.join(ws, 'innocent.ts'));
    expect(() => buildChangeSet(ws, base)).toThrow(/hard link/);
  });
});

describe('runner and filesystem helpers', () => {
  it('runCapped enforces the wall clock and the output cap and never throws on a non-zero exit', async () => {
    const env = { PATH: process.env.PATH ?? '' };
    expect((await runCapped(process.execPath, ['-e', 'process.exit(3)'], { cwd: os.tmpdir(), env, timeoutMs: 10_000 })).exitCode).toBe(3);
    expect((await runCapped(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { cwd: os.tmpdir(), env, timeoutMs: 200 })).timedOut).toBe(true);
    const big = await runCapped(process.execPath, ['-e', 'setInterval(()=>process.stdout.write("x".repeat(1<<20)),1)'], { cwd: os.tmpdir(), env, timeoutMs: 20_000 });
    expect(big.outputCapped).toBe(true);
  });

  it('the sandbox runtime is refused unless the exact pinned version resolves', () => {
    const missing = resolveSandboxRuntime(tmp());
    expect(missing).toEqual({ error: 'sandbox-runtime-not-installed' });
    const fake = tmp();
    write(fake, 'node_modules/@anthropic-ai/sandbox-runtime/package.json', JSON.stringify({ version: '9.9.9' }));
    expect(resolveSandboxRuntime(fake)).toEqual({ error: 'sandbox-runtime-version-mismatch:9.9.9' });
    write(fake, 'node_modules/@anthropic-ai/sandbox-runtime/package.json', JSON.stringify({ version: '0.0.77' }));
    expect(resolveSandboxRuntime(fake)).toEqual({ error: 'sandbox-runtime-cli-missing' });
    write(fake, 'node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js', '');
    expect(resolveSandboxRuntime(fake)).toMatchObject({ version: '0.0.77' });
    expect(new SandboxRuntimeRunner({ settingsDir: tmp(), resolve: () => ({ error: 'sandbox-runtime-not-installed' }) }).available()).toEqual({ ok: false, reason: 'sandbox-runtime-not-installed' });
    expect(shortTmpDir().length).toBeLessThan(20);
  });

  it('attempt trees move into the agent trash and are deleted; treeBytes measures without following links', () => {
    const root = tmp();
    const trash = path.join(root, '.instar', 'state', 'trash');
    write(root, 'attempt/a.txt', 'abc');
    fs.symlinkSync('/etc', path.join(root, 'attempt', 'link'));
    expect(treeBytes(path.join(root, 'attempt'))).toBe(3);
    removeAttemptTree(path.join(root, 'attempt'), trash, 'test');
    expect(fs.existsSync(path.join(root, 'attempt'))).toBe(false);
    expect(fs.readdirSync(trash)).toHaveLength(0);
    removeAttemptTree(path.join(root, 'missing'), trash, 'test');
    write(trash, 'left/x', 'x');
    expect(sweepTrash(trash, 'test')).toBe(1);
  });
});

describe('dependency cache', () => {
  it('builds from the base SHA manifests only, reuses a ready cache, evicts all but the two newest unless in use', async () => {
    const root = tmp();
    const installs: Array<{ dir: string; tool: string }> = [];
    const files: Record<string, string> = { 'package.json': '{"name":"x"}', 'package-lock.json': '{"lockfileVersion":3}', 'packages/a/package.json': '{"name":"a"}' };
    const cache = new DepsCache({
      root: path.join(root, 'deps'), agentHome: path.join(root, 'home'), trashRoot: path.join(root, '.instar', 'trash'),
      runner: { available: () => ({ ok: true, version: '0.0.77' }), run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, outputCapped: false }) },
      readAtCommit: (_s, _sha, f) => files[f] ?? null, listAtCommit: () => ['packages/a/package.json', 'packages/a/index.js'],
      install: async (dir, tool) => { installs.push({ dir, tool }); fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true }); },
      hasPnpm: () => false, testRunnerHoldersFile: path.join(root, 'h.json'),
    });
    const a = await cache.ensure('/src', 'a'.repeat(40));
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(installs).toEqual([{ dir: a.dir, tool: 'npm' }]);
    expect(fs.readFileSync(path.join(a.dir, 'packages/a/package.json'), 'utf8')).toBe('{"name":"a"}');
    expect(fs.existsSync(path.join(a.dir, 'packages/a/index.js'))).toBe(false);
    expect((await cache.ensure('/src', 'b'.repeat(40))).ok).toBe(true);
    expect(installs).toHaveLength(1); // same manifests → same hash → reused
    for (const v of ['1', '2', '3']) { files['package-lock.json'] = `{"v":${v}}`; await cache.ensure('/src', 'c'.repeat(40)); }
    expect(fs.readdirSync(path.join(root, 'deps')).filter((n) => /^[0-9a-f]{20}$/.test(n))).toHaveLength(4);
    expect(cache.evict(new Set([a.hash]))).toBe(1);
    expect(cache.sizeBytes()).toBeGreaterThan(0);
  });

  it('a missing lockfile or a failed install is deps-unavailable and leaves no partial cache', async () => {
    const root = tmp();
    const cache = new DepsCache({
      root: path.join(root, 'deps'), agentHome: root, trashRoot: path.join(root, '.instar', 'trash'),
      runner: { available: () => ({ ok: true, version: '0.0.77' }), run: async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, outputCapped: false }) },
      readAtCommit: (_s, _sha, f) => (f === 'package.json' ? '{}' : f === 'package-lock.json' ? '{}' : null), listAtCommit: () => [],
      install: async () => { throw new Error('registry down'); }, hasPnpm: () => false, testRunnerHoldersFile: path.join(root, 'h.json'),
    });
    const r = await cache.ensure('/src', 'a'.repeat(40));
    expect(r).toMatchObject({ ok: false });
    expect(fs.readdirSync(path.join(root, 'deps'))).toHaveLength(0);
    const noLock = new DepsCache({ ...(cache as unknown as { opts: ConstructorParameters<typeof DepsCache>[0] }).opts, readAtCommit: () => null });
    expect(await noLock.ensure('/src', 'a'.repeat(40))).toEqual({ ok: false, reason: 'lockfile-missing-at-base' });
  });
});
