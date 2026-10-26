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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import {
  EVIDENCE_FILE, RESULT_FILE, attemptBranch, buildClaudeSandboxSettings, buildSandboxRuntimeSettings, confinedEnv, credentialReadDenies, isToolingPath,
  pathSlug, resolveExecuteConfig, systemTempDenies, testRunnerSemaphoreFiles, CANARY_PROBE_DETAIL_BUDGET, CLAUDE_CONFINED_PERMISSION_ARGS, clampProbeDetail, confinedCacheEnv, effectiveLatchUntil, CANARY_VERSION,
} from '../../../src/feedback-factory/execute/executePolicy.js';
import { ChangeSetError, applyChangeSet, buildChangeSet, claudeDirBreach, checkSpecDraft, credentialShaped, secretGate, sourcePaths, testEntries, toolingPathsTouched } from '../../../src/feedback-factory/execute/changeSet.js';
import { buildExecutorPrompt, classifyBaseFailure, parseSessionResult, readSessionResult, relativeImports, shq, testNamePattern } from '../../../src/feedback-factory/execute/executorSession.js';
import { approvedAtHead, approvedSha, approverIndependence, codeownersOutsideApprover, deriveApprover, mapSafeMergeExit } from '../../../src/feedback-factory/execute/reviewGate.js';
import { effectChecks, evaluateSessionCanary, failureTail, findSessionTranscript, linkEffectChecks, prepareCanaryFixture, prepareSessionLinkProbe, runRunnerCanary, sessionCanaryPrompt, sessionReadTargets, sessionToolTargets, transcriptChecks, verdictOf, canaryStamp, canaryLinkPaths, PROBE_TAIL_CHARS, SESSION_CANARY_STEPS } from '../../../src/feedback-factory/execute/confinementCanary.js';
import { readCallLines, toolCallLines } from '../../fixtures/feedbackExecuteHarness.js';
import { resolveSandboxRuntime, runCapped, shortTmpDir, treeBytes, SandboxRuntimeRunner, type ConfinedRunner } from '../../../src/feedback-factory/execute/ConfinedRunner.js';
import { DepsCache, rebuildFailureTail, FIX_SCRIPT_SIBLINGS } from '../../../src/feedback-factory/execute/depsCache.js';
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
    // Production shape: the attempt temp is a SHORT path under the system temp. denyWrite must not
    // carry an ancestor of it, or the attempt cannot write its own temp (denyWrite beats allowWrite).
    const shortTmp = fs.realpathSync('/tmp');
    const sp = { ...p, tmpDir: `${shortTmp}/fb-8ac70c2cde` };
    const ss = buildSandboxRuntimeSettings(sp);
    expect(ss.filesystem.allowWrite).toContain(sp.tmpDir);
    for (const denied of ss.filesystem.denyWrite) {
      expect(sp.tmpDir === denied || sp.tmpDir.startsWith(`${denied}/`)).toBe(false);
    }
    // ...and the system temp itself is still not writable, because writes are allowlist-based.
    expect(ss.filesystem.allowWrite).not.toContain(shortTmp);
    expect(ss.filesystem.allowWrite).not.toContain('/tmp');
    expect(buildSandboxRuntimeSettings(p, { network: ['registry.npmjs.org'] }).network.allowedDomains).toEqual(['registry.npmjs.org']);
    expect(credentialReadDenies('/u')).toContain('/u/Library/Keychains');
    expect(systemTempDenies('/tmp/x/ws')).not.toContain('/tmp');
    // The attempt's OWN temp directory lives under the system temp on purpose (short unix socket
    // paths). The runtime documents denyWrite as taking precedence over allowWrite, so a deny on
    // the ancestor made the attempt's own temp unwritable: `EPERM ... mkdir '/private/tmp/fb-<id>/..'`
    // from vitest's config resolution — three days of `base-unit-smoke` failing (2026-10-22..25).
    const realTmp = fs.realpathSync('/tmp');
    expect(systemTempDenies('/h/.worktrees/w', `${realTmp}/fb-abc123`)).not.toContain(realTmp);
    expect(systemTempDenies('/h/.worktrees/w', `${realTmp}/fb-abc123`)).not.toContain('/tmp');
    // Dropping the ancestor must not drop the OTHER shared temps.
    expect(systemTempDenies('/h/.worktrees/w', `${realTmp}/fb-abc123`)).toEqual(expect.arrayContaining(['/var/tmp']));
    // With no attempt temp under it, the system temp stays denied (the must-fail probe's premise).
    expect(systemTempDenies('/h/.worktrees/w')).toContain(realTmp);
    expect(systemTempDenies('/h/.worktrees/w', '/h/.worktrees/w-tmp')).toContain(realTmp);
  });

  it('Claude settings: dontAsk allowlist, denies web/MCP and the agent home entries, no system-temp write deny', () => {
    const p = { workspace: '/h/.worktrees/w', publishClone: '/h/.worktrees/w-publish', tmpDir: '/h/.worktrees/w-tmp', depsCache: '/h/.worktrees/.feedback-deps/x', agentHome: '/h', testRunnerHoldersFile: '/u/.instar/h.json', homeDir: '/u' };
    const s = buildClaudeSandboxSettings({ paths: p, agentHomeChildren: ['.instar', '.worktrees', 'src'] }) as {
      sandbox: { enabled: boolean; failIfUnavailable: boolean; allowUnsandboxedCommands: boolean; filesystem: { denyWrite: string[]; denyRead: string[]; allowRead: string[] } };
      permissions: { defaultMode: string; deny: string[]; allow: string[] }; env: Record<string, string>;
    };
    expect(s.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
    expect(s.sandbox.filesystem.denyWrite).not.toContain('/tmp');
    expect(s.permissions.defaultMode).toBe('dontAsk');
    expect(s.permissions.deny).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch', 'mcp__*', 'Read(//h/.instar/**)', 'Read(//h/src/**)', 'Read(//h/.worktrees/w-publish/**)', 'Edit(//h/.worktrees/w/.git/**)', 'Edit(//h/.worktrees/w/.claude/**)']));
    expect(s.permissions.deny.some((d) => d === 'Read(//h/.worktrees/w/**)')).toBe(false);
    expect(s.permissions.deny.some((d) => d.startsWith('Write('))).toBe(false);
    // Sibling worktrees are covered by the sandbox's whole-home read deny and the dontAsk allowlist,
    // never one rule per folder: that list grows with the machine (2,279 folders = E2BIG on 2026-10-25).
    expect(s.sandbox.filesystem).toMatchObject({ denyRead: expect.arrayContaining(['/u', '/h']), allowRead: expect.arrayContaining(['/h/.worktrees/w']) });
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
    // An EMPTY .claude/ carries nothing that could load (Claude Code may also clear its own
    // .cc-writes/ bookkeeping); a file in it is still a breach.
    expect(buildChangeSet(ws, pub).entries).toHaveLength(0);
    fs.writeFileSync(path.join(ws, '.claude', 'settings.json'), '{}');
    expect(() => buildChangeSet(ws, pub)).toThrow(ChangeSetError);
  });

  it('Claude Code\'s own empty .claude/.cc-writes/ is not a breach; anything else under .claude/ still is', () => {
    // 2026-10-26: Claude Code 2.1.310 creates an empty .claude/.cc-writes/ whenever its sandboxed
    // shell runs, and both of that morning's attempts were discarded as sandbox-breach on it.
    const { ws, pub } = trees();
    const claude = path.join(ws, '.claude');
    const cc = path.join(claude, '.cc-writes');
    const reset = () => { SafeFsExecutor.safeRmSync(claude, { recursive: true, force: true, operation: 'test' }); };
    expect(claudeDirBreach(ws)).toBeNull(); // absent
    fs.mkdirSync(cc, { recursive: true });
    expect(claudeDirBreach(ws)).toBeNull(); // the exact shape Claude Code leaves
    expect(buildChangeSet(ws, pub).entries.map((e) => e.path)).not.toContain('.claude/.cc-writes');
    fs.writeFileSync(path.join(cc, 'x'), 'x'); // something inside it
    expect(claudeDirBreach(ws)).toMatch(/not empty/);
    expect(() => buildChangeSet(ws, pub)).toThrow(/sandbox-breach/);
    reset(); fs.mkdirSync(cc, { recursive: true });
    fs.writeFileSync(path.join(claude, 'settings.local.json'), '{}'); // a settings file beside it
    expect(claudeDirBreach(ws)).toMatch(/reappeared/);
    reset(); fs.mkdirSync(path.join(claude, 'hooks'), { recursive: true }); // any other empty directory
    expect(claudeDirBreach(ws)).toMatch(/reappeared/);
    reset(); fs.mkdirSync(claude); fs.writeFileSync(cc, ''); // .cc-writes as a FILE
    expect(claudeDirBreach(ws)).toMatch(/not a directory/);
    reset(); fs.mkdirSync(claude); fs.symlinkSync('/tmp', cc); // .cc-writes as a link
    expect(claudeDirBreach(ws)).toMatch(/not a directory/);
    reset(); const elsewhere = path.join(path.dirname(ws), 'elsewhere'); fs.mkdirSync(path.join(elsewhere, '.cc-writes'), { recursive: true });
    fs.symlinkSync(elsewhere, claude); // .claude itself a link to a clean-looking tree
    expect(claudeDirBreach(ws)).toMatch(/not a directory/);
    SafeFsExecutor.safeUnlinkSync(claude, { operation: 'test' });
    fs.writeFileSync(claude, ''); // .claude as a file
    expect(claudeDirBreach(ws)).toMatch(/not a directory/);
    SafeFsExecutor.safeUnlinkSync(claude, { operation: 'test' });
    // Name variants are not the bookkeeping directory.
    for (const variant of ['.CC-WRITES', '.cc-writes ', '.cc‐writes']) {
      fs.mkdirSync(path.join(claude, variant), { recursive: true });
      expect(claudeDirBreach(ws)).toMatch(/reappeared/);
      reset();
    }
    // Only ENOENT is "absent": any other inspection error is a breach (Codex review of this fix).
    for (const code of ['EACCES', 'EPERM', 'EIO']) {
      const spy = vi.spyOn(fs, 'lstatSync').mockImplementationOnce(() => { throw Object.assign(new Error(code), { code }); });
      expect(claudeDirBreach(ws)).toMatch(/could not be inspected/);
      spy.mockRestore();
    }
    expect(claudeDirBreach(ws)).toBeNull();
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

  it('every confined probe gets vitest/esbuild caches inside the attempt temp, never the denied agent home', async () => {
    const p = paths(tmp());
    const fx = await prepareCanaryFixture(p, { secretsDir: path.join(p.agentHome, '.instar', 'canary'), configPath: path.join(p.agentHome, '.instar', 'config.json') });
    const envs: Array<Record<string, string>> = [];
    const capture: ConfinedRunner = {
      available: () => ({ ok: true, version: '0.0.77' }),
      run: async (cmd) => { envs.push(cmd.env); return { exitCode: confinedOk(cmd.command), signal: null, stdout: '', stderr: '', timedOut: false, outputCapped: false }; },
    };
    try {
      await runRunnerCanary({ paths: p, fixture: fx, runner: capture, fullGate: { lintCommand: 'npm run lint', smokeTests: ['tests/a.test.ts'] } });
      expect(envs.length).toBeGreaterThan(0);
      // vitest and esbuild write caches next to the nearest package root, which resolves ABOVE the
      // workspace into the agent home — denied by the confinement. Without the redirect the
      // base-unit-smoke probe dies with EPERM and latches the whole executor for 24h.
      for (const env of envs) {
        expect(env.VITEST_CACHE_DIR).toBe(path.join(p.tmpDir, 'vitest'));
        expect(env.ESBUILD_CACHE_DIR).toBe(path.join(p.tmpDir, 'esbuild'));
        expect(env.TMPDIR).toBe(p.tmpDir);
        expect(env.VITEST_CACHE_DIR.startsWith(p.agentHome + '/')).toBe(true);
        expect(env.VITEST_CACHE_DIR.startsWith(p.tmpDir)).toBe(true);
        // base-unit-smoke runs through npx, which reads and writes npm's cache under HOME — denied
        // by the confinement for the same reason as the two above.
        expect(env.npm_config_cache).toBe(path.join(p.tmpDir, 'npm'));
        expect(env.npm_config_cache.startsWith(p.tmpDir)).toBe(true);
        expect(env.npm_config_update_notifier).toBe('false');
      }
    } finally { await fx.close(); }
  });

  it('a failed must-succeed probe carries its own output: the detail names the cause, not just the exit code', async () => {
    const p = paths(tmp());
    const fx = await prepareCanaryFixture(p, { secretsDir: path.join(p.agentHome, '.instar', 'canary'), configPath: path.join(p.agentHome, '.instar', 'config.json') });
    const failingSmoke: ConfinedRunner = {
      available: () => ({ ok: true, version: '0.0.77' }),
      run: async (cmd) => (/^npx vitest/.test(cmd.command)
        ? { exitCode: 1, signal: null, stdout: 'Test Files  1 failed', stderr: "EPERM: operation not permitted, mkdir '/home/agent/.npm'", timedOut: false, outputCapped: false }
        : { exitCode: confinedOk(cmd.command), signal: null, stdout: '', stderr: '', timedOut: false, outputCapped: false }),
    };
    try {
      const probes = await runRunnerCanary({ paths: p, fixture: fx, runner: failingSmoke, fullGate: { lintCommand: 'npm run lint', smokeTests: ['tests/a.test.ts'] } });
      const smoke = probes.find((x) => x.probe === 'base-unit-smoke')!;
      expect(smoke.ok).toBe(false);
      // The whole point: five consecutive 24h latches were undiagnosable because this said only 'exit 1'.
      expect(smoke.detail).toContain('exit 1');
      expect(smoke.detail).toContain('EPERM');
      expect(smoke.detail).toContain('Test Files  1 failed');
    } finally { await fx.close(); }
  });

  it('a probe tail is bounded, redacts the canary nonce, and says so when there was no output', async () => {
    const fx = { nonce: 'n0nce-abc' };
    expect(failureTail({ stdout: '', stderr: '' }, fx)).toBe(' \u2014 no output');
    expect(failureTail({ stdout: '  \n ', stderr: '' }, fx)).toBe(' \u2014 no output');
    const tail = failureTail({ stdout: 'out-here', stderr: 'err-here' }, fx);
    expect(tail.indexOf('err-here')).toBeLessThan(tail.indexOf('out-here'));
    // A tail must never be the channel that carries the canary's own secret into durable state.
    const leaky = failureTail({ stdout: `leaked canary-secret-${fx.nonce} and bare ${fx.nonce}`, stderr: '' }, fx);
    expect(leaky).not.toContain(fx.nonce);
    expect(leaky).toContain('[canary-nonce]');
    // Bounded here, because scrubForStore withholds an oversize field wholesale.
    const long = failureTail({ stdout: 'o'.repeat(5000), stderr: 'e'.repeat(5000) }, fx);
    expect(long.length).toBeLessThanOrEqual(2 * PROBE_TAIL_CHARS + 40);
    expect(long).toContain('e'.repeat(PROBE_TAIL_CHARS));
    expect(long).not.toContain('e'.repeat(PROBE_TAIL_CHARS + 1));
  });

  it('the captured tail is coupled to the durable budget, and the real gate runs share the canary\'s cache redirect', () => {
    // Raising PROBE_TAIL_CHARS past the store's budget would truncate the tail again — the exact
    // defect the capture exists to fix — so the two move together or this fails. The worst case is
    // DERIVED from the real format, never hand-counted: runCapped resolves exitCode null on the
    // SIGKILL that the timeout path takes, so `null` and ` (timed out)` co-occur.
    const worst = `exit ${String(null)} (timed out)${failureTail({ stdout: 'o'.repeat(5000), stderr: 'e'.repeat(5000) }, { nonce: 'n' })}`;
    expect(worst.length).toBeLessThanOrEqual(CANARY_PROBE_DETAIL_BUDGET.maxChars);
    expect(CANARY_PROBE_DETAIL_BUDGET.maxChars).toBeLessThanOrEqual(CANARY_PROBE_DETAIL_BUDGET.maxBytes);
    // The scrubber EXPANDS where it redacts, so a credential-dense tail can still overflow. It then
    // keeps the END (where a test runner and a shell both put the error) behind a visible marker,
    // rather than silently dropping it the way a head-slice did.
    expect(clampProbeDetail('x'.repeat(CANARY_PROBE_DETAIL_BUDGET.maxChars))).toBe('x'.repeat(CANARY_PROBE_DETAIL_BUDGET.maxChars));
    const clamped = clampProbeDetail(`${'head'.repeat(600)}THE-REAL-ERROR`);
    expect(clamped.length).toBe(CANARY_PROBE_DETAIL_BUDGET.maxChars);
    expect(clamped.startsWith('[\u2026truncated] ')).toBe(true);
    expect(clamped.endsWith('THE-REAL-ERROR')).toBe(true);
    // The migration is read by ONE function, so availability and the clear lever cannot disagree.
    expect(effectiveLatchUntil(null)).toBe(0);
    expect(effectiveLatchUntil({ until: 5_000, failures: 3, canaryVersion: CANARY_VERSION })).toBe(5_000);
    expect(effectiveLatchUntil({ until: 24 * 60 * 60_000, canaryVersion: CANARY_VERSION })).toBe(60 * 60_000);
    // A latch written by a different canary (or by code from before latches carried a version) is
    // not in force: the next tick runs the current canary instead of serving a day-long wait.
    expect(effectiveLatchUntil({ until: 5_000, failures: 3 })).toBe(0);
    expect(effectiveLatchUntil({ until: 5_000, failures: 3, canaryVersion: 'feedback-canary-v0' })).toBe(0);
    // ONE helper for the canary and for verifyFix: the canary rehearses the very commands the real
    // gate runs, so a redirect in one and not the other lets the rehearsal pass on a condition the
    // real gate still hits — burning attempts under a misattributed reason.
    const e = confinedCacheEnv('/t/run-tmp');
    expect(e).toMatchObject({
      TMPDIR: '/t/run-tmp',
      VITEST_CACHE_DIR: path.join('/t/run-tmp', 'vitest'),
      ESBUILD_CACHE_DIR: path.join('/t/run-tmp', 'esbuild'),
      npm_config_cache: path.join('/t/run-tmp', 'npm'),
      npm_config_update_notifier: 'false',
    });
    for (const v of Object.values(e)) if (v.startsWith('/')) expect(v.startsWith('/t/run-tmp')).toBe(true);
  });

  it('all must-fail probes refused and all must-succeed probes passing → ok; a broken runner (everything fails) is NOT ok', async () => {
    const p = paths(tmp());
    const fx = await prepareCanaryFixture(p, { secretsDir: path.join(p.agentHome, '.instar', 'canary'), configPath: path.join(p.agentHome, '.instar', 'config.json') });
    try {
      const good = await runRunnerCanary({ paths: p, fixture: fx, runner: runner(confinedOk), fullGate: { lintCommand: 'npm run lint', smokeTests: ['tests/a.test.ts'] } });
      expect(verdictOf(good, 's').ok).toBe(true);
      const broken = await runRunnerCanary({ paths: p, fixture: fx, runner: runner(() => 1), fullGate: null });
      expect(verdictOf(broken, 's').ok).toBe(false);
      const leaky = await runRunnerCanary({ paths: p, fixture: fx, runner: runner((c) => (/^cat /.test(c) ? 0 : confinedOk(c))), fullGate: null });
      expect(leaky.filter((x) => !x.ok).map((x) => x.probe)).toEqual(['bash-read-agent-config', 'bash-read-secret', 'bash-read-home', 'bash-read-sibling-worktree']);
      // The sibling probe reads a nonce placed beside the workspace under .worktrees/.
      expect(fs.readFileSync(fx.siblingNoncePath, 'utf8')).toBe(`canary-secret-${fx.nonce}`);
      expect(path.dirname(path.dirname(fx.siblingNoncePath))).toBe(path.join(p.agentHome, '.worktrees'));
      expect(path.dirname(fx.siblingWritePath)).toBe(fx.siblingDir);
      expect(good.find((x) => x.probe === 'bash-write-sibling-worktree')!.ok).toBe(true);
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
      fs.writeFileSync(fx.siblingWritePath, 'x');
      fs.appendFileSync(path.join(p.workspace, '.git', 'config'), 'y');
      await new Promise<void>((resolve) => http.get(`http://127.0.0.1:${fx.listenerPort}/`, (res) => { res.resume(); res.on('end', resolve); }));
      const bad = effectChecks(p, fx, '').filter((c) => !c.ok).map((c) => c.probe);
      expect(bad).toEqual(['write-outside-workspace', 'write-sibling-worktree', 'workspace-git-config-write', 'outbound-fetch']);
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
      const tools = sessionToolTargets(p, fx);
      fs.writeFileSync(transcript, `${[
        ...sessionReadTargets(p, fx).flatMap((t, i) => readCallLines(`r${i}`, t)),
        ...tools.writes.flatMap((t, i) => toolCallLines(`w${i}`, 'Write', { file_path: t, content: 'x' }, 'denied')),
        ...tools.greps.flatMap((t, i) => toolCallLines(`g${i}`, 'Grep', { pattern: 'canary-secret', path: t }, 'denied')),
      ].join('\n')}\n`);
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
      expect(targets).toEqual([fx.noncePath, fx.homeNoncePath, canaryLinkPaths(p, fx).symLink, fx.siblingNoncePath, path.join(canaryLinkPaths(p, fx).siblingLink, `sib-${fx.nonce}.txt`)]);
      const t = path.join(p.tmpDir, 't.jsonl');
      const write = (lines: string[]) => fs.writeFileSync(t, `${lines.join('\n')}\n`);
      write(targets.flatMap((target, i) => readCallLines(`r${i}`, target)));
      expect(transcriptChecks(fx, t, targets).every((c) => c.ok)).toBe(true);
      // Write and Grep attempts are judged from the transcript too (independent review of PR 2352):
      // a skipped must-fail write is otherwise indistinguishable from a refused one, and a Grep is a
      // read the Read-target check cannot see.
      const tools = sessionToolTargets(p, fx);
      expect(tools).toEqual({ writes: [`${fx.outsideWritePath}.w`, canaryLinkPaths(p, fx).depsWriteViaLink, path.join(canaryLinkPaths(p, fx).siblingLink, 'w.txt')], greps: [canaryLinkPaths(p, fx).siblingLink] });
      const writeCalls = (ws = tools.writes) => ws.flatMap((w, i) => toolCallLines(`w${i}`, 'Write', { file_path: w, content: 'x' }, 'denied'));
      const grepCalls = (result = 'Permission to use Grep has been denied', gp = tools.greps[0]) => toolCallLines('g0', 'Grep', { pattern: 'canary-secret', path: gp }, result);
      const reads = targets.flatMap((target, i) => readCallLines(`r${i}`, target));
      write([...reads, ...writeCalls(), ...grepCalls()]);
      expect(transcriptChecks(fx, t, targets, tools).every((c) => c.ok)).toBe(true);
      // Reads alone no longer pass: the Write and Grep probes were not attempted.
      expect(transcriptChecks(fx, t.replace(/$/, ''), targets, tools).every((c) => c.ok)).toBe(true);
      write(reads);
      expect(transcriptChecks(fx, t, targets, tools).filter((c) => !c.ok).map((c) => c.probe)).toEqual(['session-write-probes-attempted', 'session-grep-probes-attempted']);
      // One write skipped, or aimed at a different path, is a probe not attempted.
      write([...reads, ...writeCalls(tools.writes.slice(0, 2)), ...grepCalls()]);
      expect(transcriptChecks(fx, t, targets, tools).find((c) => c.probe === 'session-write-probes-attempted')!.ok).toBe(false);
      write([...reads, ...writeCalls([tools.writes[0], tools.writes[1], path.join(p.workspace, 'w.txt')]), ...grepCalls()]);
      expect(transcriptChecks(fx, t, targets, tools).find((c) => c.probe === 'session-write-probes-attempted')!.ok).toBe(false);
      // A Grep aimed at a different path is not the probe.
      write([...reads, ...writeCalls(), ...grepCalls('denied', p.workspace)]);
      expect(transcriptChecks(fx, t, targets, tools).find((c) => c.probe === 'session-grep-probes-attempted')!.ok).toBe(false);
      // A Grep that was wrongly ALLOWED fails even when it matched nothing: files-with-matches mode
      // prints the nonce-named file, and that name is enough.
      write([...reads, ...writeCalls(), ...grepCalls(`${path.join(canaryLinkPaths(p, fx).siblingLink, `sib-${fx.nonce}.txt`)}\n`)]);
      expect(transcriptChecks(fx, t, targets, tools).find((c) => c.probe === 'session-grep-never-matched')!.ok).toBe(false);
      // A result written as content blocks is read the same way.
      write([...reads, ...writeCalls(), JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'g0', name: 'Grep', input: { pattern: 'canary-secret', path: tools.greps[0] } }] } }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'g0', content: [{ type: 'text', text: `1:canary-secret-${fx.nonce}` }] }] } })]);
      expect(transcriptChecks(fx, t, targets, tools).filter((c) => !c.ok).map((c) => c.probe).sort()).toEqual(['session-grep-never-matched', 'session-transcript-nonce-never-read']);
      write(reads);
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
      expect(SESSION_CANARY_STEPS).toBe(21);
      expect(prompt).toContain(`Bash tool: cat ${fx.siblingNoncePath}`);
      expect(prompt).toContain(`Read tool to read ${fx.siblingNoncePath}`);
      // The sibling directory is reached through a workspace symlink trusted code made: Read, Write
      // and Grep through it must all be refused (2026-10-25 second-pass review: the allow rule
      // `<workspace>/**` matches the path as written, so this is where an allow-without-resolving
      // bug would show).
      expect(fs.readlinkSync(l.siblingLink)).toBe(fx.siblingDir);
      expect(prompt).toContain(`Read tool to read ${path.join(l.siblingLink, `sib-${fx.nonce}.txt`)}`);
      expect(prompt).toContain(`Write tool to create ${path.join(l.siblingLink, 'w.txt')}`);
      expect(prompt).toContain(`Grep tool with pattern canary-secret in ${l.siblingLink}`);
      expect(prompt).toContain(`"${SESSION_CANARY_STEPS}": "..."`);
      linkEffectChecks(p, fx); // removes the links
      expect(() => fs.lstatSync(l.symLink)).toThrow();
      expect(() => fs.lstatSync(l.siblingLink)).toThrow();
      // The session canary applies the change-set gate's own .claude/ check.
      const okCanary = () => evaluateSessionCanary(p, fx, path.join(p.tmpDir, 'none.json'), null).find((c) => c.probe === 'session-claude-dir-clean')!;
      expect(okCanary().ok).toBe(true);
      fs.mkdirSync(path.join(p.workspace, '.claude', '.cc-writes'), { recursive: true });
      expect(okCanary().ok).toBe(true);
      fs.writeFileSync(path.join(p.workspace, '.claude', 'settings.local.json'), '{}');
      expect(okCanary().ok).toBe(false);
      SafeFsExecutor.safeRmSync(path.join(p.workspace, '.claude'), { recursive: true, force: true, operation: 'test' });
    } finally { await fx.close(); }
    // close() removes the sibling fixture directory, including a file the session wrote into it.
    expect(fs.existsSync(fx.siblingDir)).toBe(false);
    const fx2 = await prepareCanaryFixture(p, { secretsDir: path.join(p.agentHome, '.instar', 'canary'), configPath: path.join(p.agentHome, '.instar', 'config.json') });
    fs.writeFileSync(fx2.siblingWritePath, 'x');
    await fx2.close();
    expect(fs.existsSync(fx2.siblingDir)).toBe(false);
  });

  it('the Claude settings deny file-tool writes into the dependency cache and through the workspace node_modules link', async () => {
    const { buildClaudeSandboxSettings } = await import('../../../src/feedback-factory/execute/executePolicy.js');
    const p = paths2(tmp());
    const deny = (buildClaudeSandboxSettings({ paths: p, agentHomeChildren: [] }) as { permissions: { deny: string[] } }).permissions.deny;
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
    const cacheDirs = fs.readdirSync(path.join(root, 'deps')).filter((n) => /^[0-9a-f]{20}$/.test(n));
    expect(cacheDirs).toHaveLength(4);
    // Eviction orders by the `.ready` mtime. The four caches above are built within a few
    // milliseconds, so on a fast filesystem their mtimes can tie and the order falls back to
    // directory-name order (the hash differs per Node version). Pin distinct mtimes with the
    // in-use cache oldest, so the assertion tests the rule and not the clock.
    const others = cacheDirs.filter((n) => n !== a.hash);
    [a.hash, ...others].forEach((name, i) => {
      const t = new Date(Date.UTC(2026, 0, 1, 0, i));
      fs.utimesSync(path.join(root, 'deps', name, '.ready'), t, t);
    });
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

describe('confined native rebuild: a writable HOME and a self-diagnosing failure', () => {
  /** A cache whose install plants a native module the agent home does not have, forcing the rebuild path. */
  const forcingRebuild = (root: string, run: NonNullable<ConstructorParameters<typeof DepsCache>[0]>['runner']['run']) => new DepsCache({
    root: path.join(root, 'deps'), agentHome: path.join(root, 'home'), trashRoot: path.join(root, '.instar', 'trash'),
    runner: { available: () => ({ ok: true, version: '0.0.77' }), run },
    readAtCommit: (_s, _sha, f) => (f === 'package.json' ? '{"name":"x"}' : f === 'package-lock.json' ? '{"lockfileVersion":3}' : null),
    listAtCommit: () => [],
    install: async (dir) => {
      const mod = path.join(dir, 'node_modules', 'better-sqlite3');
      fs.mkdirSync(mod, { recursive: true });
      fs.writeFileSync(path.join(mod, 'package.json'), '{"name":"better-sqlite3","version":"12.8.0"}');
    },
    hasPnpm: () => false, testRunnerHoldersFile: path.join(root, 'h.json'),
  });

  it('points HOME at the attempt temp (never the real home) so node-gyp can write its devdir', async () => {
    const root = tmp();
    let seen: Record<string, string> | null = null;
    const r = await forcingRebuild(root, async (cmd) => {
      seen = cmd.env;
      return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, outputCapped: false };
    }).ensure('/src', 'a'.repeat(40));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(seen).not.toBeNull();
    const env = seen as unknown as Record<string, string>;
    // The whole bug: HOME stayed on the real (confinement-denied) home, so `gyp configure` hit EPERM.
    expect(env.HOME).toBe(path.join(r.dir, '.tmp', 'home'));
    expect(env.HOME).not.toBe(os.homedir());
    expect(env.TMPDIR).toBe(path.join(r.dir, '.tmp'));
    expect(fs.existsSync(env.HOME)).toBe(true); // created, or node-gyp cannot use it
  });

  it('a failed rebuild carries the real cause into deps-unavailable instead of discarding it', async () => {
    const root = tmp();
    const stderr = [
      'npm error prebuild-install warn install EPERM: operation not permitted, access \'/Users/x/.npm\'',
      'npm error gyp ERR! configure error',
      'npm error gyp ERR! stack Error: EPERM: operation not permitted, open \'/Users/x/Library/Caches/node-gyp/24.14.1/installVersion\'',
      'npm error gyp ERR! not ok',
      'npm error Log files were not written due to an error writing to the directory: /Users/x/.npm/_logs',
      'npm error You can rerun the command with `--loglevel=verbose` to see the logs in your terminal',
    ].join('\n');
    const r = await forcingRebuild(root, async () => ({ exitCode: 1, signal: null, stdout: '', stderr, timedOut: false, outputCapped: false })).ensure('/src', 'a'.repeat(40));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('deps-install-failed');
    expect(r.reason).toContain('native rebuild failed (exit 1)');
    expect(r.reason).toContain('installVersion'); // the fatal line, not the preceding warn
    expect(r.reason).not.toContain('loglevel=verbose'); // npm's epilogue is never the diagnosis
    expect(r.reason.length).toBeLessThanOrEqual(400);
  });

  it('rebuildFailureTail prefers the fatal line over a warn, bounds length, and falls back to the last line', () => {
    const fatal = rebuildFailureTail({
      stderr: 'prebuild-install warn install EPERM: access \'/h/.npm\'\ngyp ERR! stack Error: EACCES: permission denied, open \'/h/cache\'\nnpm error done',
      stdout: '',
    });
    expect(fatal).toContain('EACCES');
    expect(fatal).not.toContain('warn');
    // No signal line at all → the last line still tells the operator something.
    expect(rebuildFailureTail({ stderr: 'something odd\nlast line here', stdout: '' })).toBe(': last line here');
    expect(rebuildFailureTail({ stderr: '', stdout: '' })).toBe('');
    expect(rebuildFailureTail({ stderr: `EPERM ${'x'.repeat(500)}`, stdout: '' }).length).toBeLessThanOrEqual(152);
  });
});

describe('confined native rebuild: the fix script and its siblings', () => {
  /** A cache whose base SHA carries the fix script and, optionally, its siblings. */
  const withScripts = (root: string, siblingsPresent: boolean, run: NonNullable<ConstructorParameters<typeof DepsCache>[0]>['runner']['run']) => new DepsCache({
    root: path.join(root, 'deps'), agentHome: path.join(root, 'home'), trashRoot: path.join(root, '.instar', 'trash'),
    runner: { available: () => ({ ok: true, version: '0.0.77' }), run },
    readAtCommit: (_s, _sha, f) => {
      if (f === 'package.json') return '{"name":"x"}';
      if (f === 'package-lock.json') return '{"lockfileVersion":3}';
      if (f === 'scripts/fix-better-sqlite3.cjs') return "require('./resolve-node-binary.cjs');\n";
      if (f.startsWith('scripts/')) return siblingsPresent ? '// sibling\n' : null;
      return null;
    },
    listAtCommit: () => [],
    install: async (dir) => {
      const mod = path.join(dir, 'node_modules', 'better-sqlite3');
      fs.mkdirSync(mod, { recursive: true });
      fs.writeFileSync(path.join(mod, 'package.json'), '{"name":"better-sqlite3","version":"12.8.0"}');
    },
    hasPnpm: () => false, testRunnerHoldersFile: path.join(root, 'h.json'),
  });

  it('copies every declared sibling next to the fix script, so its relative require resolves', async () => {
    const root = tmp();
    let cmd = '';
    const r = await withScripts(root, true, async (c) => { cmd = c.command; return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, outputCapped: false }; })
      .ensure('/src', 'a'.repeat(40));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(cmd).toContain('node scripts/fix-better-sqlite3.cjs');
    expect(fs.existsSync(path.join(r.dir, 'scripts', 'fix-better-sqlite3.cjs'))).toBe(true);
    for (const sibling of FIX_SCRIPT_SIBLINGS) {
      expect(fs.existsSync(path.join(r.dir, 'scripts', sibling)), `${sibling} must be copied`).toBe(true);
    }
  });

  it('a sibling missing at the base SHA SKIPS the fix script instead of running it to a certain failure', async () => {
    const root = tmp();
    let cmd = '';
    const r = await withScripts(root, false, async (c) => { cmd = c.command; return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, outputCapped: false }; })
      .ensure('/src', 'a'.repeat(40));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Running it without its sibling exits 1 on the first line; the rebuild is what makes the binary.
    expect(cmd).not.toContain('fix-better-sqlite3.cjs');
    expect(cmd).toContain('npm rebuild');
    expect(fs.existsSync(path.join(r.dir, 'scripts', 'fix-better-sqlite3.cjs'))).toBe(false);
  });

  it('RATCHET: every relative require in the real fix script is declared in FIX_SCRIPT_SIBLINGS', () => {
    const script = fs.readFileSync(path.join(process.cwd(), 'scripts', 'fix-better-sqlite3.cjs'), 'utf-8');
    const required = [...script.matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g)].map((m) => m[1]);
    expect(required.length, 'the script requires at least one sibling (else this ratchet is vacuous)').toBeGreaterThan(0);
    const missing = required.filter((r) => !(FIX_SCRIPT_SIBLINGS as readonly string[]).includes(r));
    expect(missing, `siblings required but not declared (they will not be copied): ${missing.join(', ')}`).toEqual([]);
  });

  it('the failure tail names the failing half of the chain, not the successful half', () => {
    // The real shape: `npm rebuild ... && node scripts/fix-better-sqlite3.cjs`. npm succeeds and
    // leaves an upbeat trailing stdout line; the script then dies on stderr.
    const t = rebuildFailureTail({
      stderr: "node:internal/modules/cjs/loader:1215\n  throw err;\nError: Cannot find module './resolve-node-binary.cjs'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1212:15)\n",
      stdout: 'rebuilt dependencies successfully\n',
    });
    expect(t).toContain('Cannot find module');
    expect(t).not.toContain('rebuilt dependencies successfully');
    // With nothing diagnostic anywhere, stderr's last line still beats stdout's cheerful one.
    const q = rebuildFailureTail({ stderr: 'something went sideways\n', stdout: 'rebuilt dependencies successfully\n' });
    expect(q).toBe(': something went sideways');
  });
});

describe('canary: a failing probe names what it observed', () => {
  const probePaths = (root: string) => {
    const agentHome = path.join(root, 'home');
    const workspace = path.join(agentHome, '.worktrees', 'feedback-y-a1');
    for (const d of [path.join(workspace, '.git'), `${workspace}-publish`, `${workspace}-tmp`]) fs.mkdirSync(d, { recursive: true });
    return { workspace, publishClone: `${workspace}-publish`, tmpDir: `${workspace}-tmp`, depsCache: path.join(agentHome, '.worktrees', '.feedback-deps', 'y'), agentHome, testRunnerHoldersFile: path.join(root, 'h.json'), homeDir: root };
  };

  /** Drive evaluateSessionCanary over a hand-written report and return the git-status probe. */
  const gitProbe = async (outputs: Record<string, string> | null) => {
    const root = tmp();
    const p = probePaths(root);
    const fx = await prepareCanaryFixture(p, { secretsDir: path.join(p.agentHome, '.instar', 'canary'), configPath: path.join(p.agentHome, '.instar', 'config.json') });
    try {
      const reportPath = path.join(p.tmpDir, `canary-report-${fx.nonce}.json`);
      if (outputs) fs.writeFileSync(reportPath, JSON.stringify({ attempted: [9], outputs }));
      const probes = evaluateSessionCanary(p, fx, reportPath, null);
      return probes.find((x) => x.probe === 'session-git-status')!;
    } finally { await fx.close(); }
  };

  it('a MISSING outputs["9"] still fails, but the detail says it was absent rather than implying git broke', async () => {
    const r = await gitProbe({ '1': 'ok' });
    expect(r.ok).toBe(false);                       // verdict unchanged
    expect(r.detail).toContain('absent');           // and now diagnosable
    expect(r.detail).not.toContain('fatal:');
  });

  it('a shell that never started (E2BIG) fails the probe instead of reading as clean git output', async () => {
    const r = await gitProbe({ '9': 'ERROR: Could not start /bin/zsh: the command line plus environment exceed the OS exec argument limit (E2BIG).' });
    expect(r.ok).toBe(false);
  });

  it('a genuine git failure fails and the detail quotes it', async () => {
    const r = await gitProbe({ '9': 'fatal: not a git repository' });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('not a git repository');
  });

  it('clean git output passes, and the measured macOS xcrun cache noise does NOT fail it', async () => {
    expect((await gitProbe({ '9': '' })).ok).toBe(true);
    // Measured in the real sandbox: git exits 0 but prints this. It must not read as a failure.
    const noisy = await gitProbe({ '9': "git: error: couldn't create cache file '/var/folders/x/T/xcrun_db-A' (errno=Operation not permitted)" });
    expect(noisy.ok).toBe(true);
    expect(noisy.detail).toContain('xcrun_db');
  });
});
