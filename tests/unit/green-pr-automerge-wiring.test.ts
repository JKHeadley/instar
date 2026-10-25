/**
 * Tier-1 wiring-integrity tests for buildGreenPrDeps (mergerunner-auto-arm-
 * handoff M2 + Blocker 4). Proves the constructed deps are REAL (not no-ops) and
 * the config-threading chain survives end-to-end:
 *   - mergeStrategy + armTimeoutMs reach the CONSTRUCTED MergeRunner (the runner
 *     is no longer hardcoded to --admin).
 *   - listOpenPrs requests the widened projection (autoMergeRequest) and derives
 *     PrSummary.autoMergeArmed.
 *   - refetchPr returns the widened shape (state + mergeCommitOid + autoMergeRequest).
 *   - disarmArmedEpisodes is a real gh --disable-auto seam (confirmed-disabled).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

import { artifactSha256 } from '../../scripts/lib/instar-dev-trace.mjs';
import { buildGreenPrDeps, buildGuardLatchStore, isAnalyzableGreenPrRepo, resolveGreenPrAgentNamespace, resolveGreenPrPaths, GH_PR_JSON_FIELDS, LIST_PR_JSON_FIELDS, REFETCH_PR_JSON_FIELDS, reportUnknownGhJsonField, type GreenPrWiringOpts } from '../../src/monitoring/greenPrAutomergeWiring.js';
import { installedSafeMergePath } from '../../src/core/installedSafeMerge.js';
import { DefaultMergeRunner } from '../../src/monitoring/MergeRunner.js';

let dir: string;
let safeMergePath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpr-wiring-'));
  safeMergePath = path.join(dir, 'safe-merge.mjs');
  fs.writeFileSync(safeMergePath, '// fake\n');
});
afterEach(() => { try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test-cleanup' }); } catch { /* ignore */ } });

/** A fake gh exec recording the calls; returns canned JSON per command shape. */
function fakeGh(responses: Record<string, { stdout: string; code?: number; stderr?: string }>) {
  const calls: string[][] = [];
  const ghExec = async (args: string[]) => {
    calls.push(args);
    // Match on a stable key: the first 2 args + any --json field list.
    const jsonIdx = args.indexOf('--json');
    const key = `${args[0]} ${args[1]}${jsonIdx >= 0 ? ' ' + args[jsonIdx + 1] : ''}`;
    for (const k of Object.keys(responses)) {
      if (key.startsWith(k)) return { stdout: responses[k].stdout, stderr: responses[k].stderr ?? '', code: responses[k].code ?? 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };
  return { ghExec, calls };
}

function baseOpts(over: Partial<GreenPrWiringOpts> = {}): GreenPrWiringOpts {
  return {
    repoPath: dir,
    safeMergePath,
    stateDir: dir,
    machineId: 'm1',
    repo: 'JKHeadley/instar',
    agentNamespace: 'echo',
    mergeTimeoutMs: 1_500_000,
    mergeKillGraceMs: 60_000,
    holdsLease: () => true,
    leaseEpoch: () => 0,
    postAttentionAggregate: async () => {},
    auditPath: path.join(dir, 'audit.jsonl'),
    githubRuntime: () => ({
      executable: '/opt/homebrew/bin/gh',
      env: {
        PATH: '/opt/homebrew/bin:/usr/bin:/bin',
        GH_TOKEN: 'agent-token',
        GITHUB_TOKEN: 'agent-token',
      },
    }),
    ...over,
  };
}

describe('buildGreenPrDeps — config-threading (M2)', () => {
  it('uses the shared authenticated runtime on the default gh read path', async () => {
    const marker = path.join(dir, 'green-gh-env.txt');
    const fakeExecutable = path.join(dir, 'gh');
    fs.writeFileSync(fakeExecutable, `#!/bin/sh\nprintf '%s|%s' "$GH_TOKEN" "$GITHUB_TOKEN" > "${marker}"\nprintf '[]'\n`, { mode: 0o700 });
    const opts = baseOpts({
      ghExec: undefined,
      githubRuntime: () => ({
        executable: fakeExecutable,
        env: {
          ...process.env,
          PATH: dir,
          GH_TOKEN: 'agent-token',
          GITHUB_TOKEN: 'agent-token',
        },
      }),
    });
    const deps = buildGreenPrDeps(opts, buildGuardLatchStore(opts));
    await expect(deps.listOpenPrs()).resolves.toEqual([]);
    expect(fs.readFileSync(marker, 'utf8')).toBe('agent-token|agent-token');
  });

  it('threads mergeStrategy:auto + armTimeoutMs into the CONSTRUCTED MergeRunner', () => {
    const { ghExec } = fakeGh({});
    const latches = buildGuardLatchStore(baseOpts({ ghExec }));
    const deps = buildGreenPrDeps(baseOpts({ ghExec, mergeStrategy: 'auto', armTimeoutMs: 45_000 }), latches);
    const runner = deps.runner as DefaultMergeRunner;
    expect(runner.resolvedStrategy).toBe('auto');
    expect(runner.resolvedArmTimeoutMs).toBe(45_000);
  });

  it('threads mergeStrategy:admin when configured', () => {
    const { ghExec } = fakeGh({});
    const latches = buildGuardLatchStore(baseOpts({ ghExec }));
    const deps = buildGreenPrDeps(baseOpts({ ghExec, mergeStrategy: 'admin' }), latches);
    expect((deps.runner as DefaultMergeRunner).resolvedStrategy).toBe('admin');
  });

  it('defaults to the auto strategy with a 60s arm deadline when unset', () => {
    const { ghExec } = fakeGh({});
    const latches = buildGuardLatchStore(baseOpts({ ghExec }));
    const deps = buildGreenPrDeps(baseOpts({ ghExec }), latches);
    const runner = deps.runner as DefaultMergeRunner;
    expect(runner.resolvedStrategy).toBe('auto');
    expect(runner.resolvedArmTimeoutMs).toBe(60_000);
  });
});

describe('resolveGreenPrAgentNamespace', () => {
  it('prefers the explicit watcher prefix over project identity', () => {
    expect(resolveGreenPrAgentNamespace('agent', 'instar-codey')).toBe('agent');
  });

  it('preserves the project-name fallback for existing installs', () => {
    expect(resolveGreenPrAgentNamespace('', 'echo')).toBe('echo');
    expect(resolveGreenPrAgentNamespace(undefined, undefined)).toBe('agent');
  });
});

describe('buildGreenPrDeps — widened projections (Blocker 4)', () => {
  it('listOpenPrs requests autoMergeRequest in the projection and derives autoMergeArmed', async () => {
    const rows = JSON.stringify([
      { number: 1, title: 'a', labels: [], isDraft: false, headRefName: 'echo/x', headRefOid: 'h1', mergeable: 'MERGEABLE', statusCheckRollup: [], autoMergeRequest: { enabledAt: 't', expectedHeadOid: 'h1' } },
      { number: 2, title: 'b', labels: [], isDraft: false, headRefName: 'echo/y', headRefOid: 'h2', mergeable: 'MERGEABLE', statusCheckRollup: [], autoMergeRequest: null },
    ]);
    const { ghExec, calls } = fakeGh({ 'pr list': { stdout: rows } });
    const latches = buildGuardLatchStore(baseOpts({ ghExec }));
    const deps = buildGreenPrDeps(baseOpts({ ghExec }), latches);
    const prs = await deps.listOpenPrs();
    // The list projection requested autoMergeRequest.
    const listCall = calls.find((c) => c[0] === 'pr' && c[1] === 'list')!;
    const jsonFields = listCall[listCall.indexOf('--json') + 1];
    expect(jsonFields).toContain('autoMergeRequest');
    expect(prs[0].autoMergeArmed).toBe(true);
    expect(prs[1].autoMergeArmed).toBe(false);
  });

  it('refetchPr returns the widened shape (state + mergeCommitOid + autoMergeRequest), mapping gh\'s mergeCommit.oid', async () => {
    // gh's PR JSON has `mergeCommit: { oid }` — there is NO `mergeCommitOid` field.
    const view = JSON.stringify({ title: 't', labels: [], isDraft: false, headRefOid: 'h1', state: 'MERGED', mergeCommit: { oid: 'squashBase' }, autoMergeRequest: { expectedHeadOid: 'h1' } });
    const { ghExec, calls } = fakeGh({ 'pr view': { stdout: view } });
    const latches = buildGuardLatchStore(baseOpts({ ghExec }));
    const deps = buildGreenPrDeps(baseOpts({ ghExec }), latches);
    const r = await deps.refetchPr(1);
    expect(r).not.toBeNull();
    expect(r!.state).toBe('MERGED');
    expect(r!.mergeCommitOid).toBe('squashBase');
    expect(r!.autoMergeRequest?.expectedHeadOid).toBe('h1');
    // The view projection requested the widened fields — by gh's names.
    const viewCall = calls.find((c) => c[0] === 'pr' && c[1] === 'view')!;
    const jsonFields = viewCall[viewCall.indexOf('--json') + 1].split(',');
    expect(jsonFields).toContain('mergeCommit');
    expect(jsonFields).toContain('autoMergeRequest');
    expect(jsonFields).not.toContain('mergeCommitOid');
  });

  it('refetchPr: an unmerged PR (mergeCommit null) yields mergeCommitOid null', async () => {
    const view = JSON.stringify({ title: 't', labels: [], isDraft: false, headRefOid: 'h1', state: 'OPEN', mergeCommit: null, autoMergeRequest: null });
    const { ghExec } = fakeGh({ 'pr view': { stdout: view } });
    const deps = buildGreenPrDeps(baseOpts({ ghExec }), buildGuardLatchStore(baseOpts({ ghExec })));
    const r = await deps.refetchPr(1);
    expect(r!.state).toBe('OPEN');
    expect(r!.mergeCommitOid).toBeNull();
  });
});

describe('gh --json projections are pinned to fields gh actually supports (2026-10-24 vanished-every-PR fix)', () => {
  // gh answers `Unknown JSON field: "<name>"` + exit 1 for a field outside this set;
  // refetchPr then returned null and the watcher audited skipped:vanished for EVERY
  // PR (PR #2334 sat green and unmerged). No network: the pin is a constant check.
  it('every field in the refetchPr and listOpenPrs projections is a known gh PR JSON field', () => {
    for (const f of REFETCH_PR_JSON_FIELDS) expect(GH_PR_JSON_FIELDS, `refetchPr field ${f}`).toContain(f);
    for (const f of LIST_PR_JSON_FIELDS) expect(GH_PR_JSON_FIELDS, `listOpenPrs field ${f}`).toContain(f);
    expect(GH_PR_JSON_FIELDS).not.toContain('mergeCommitOid');
    expect(REFETCH_PR_JSON_FIELDS).toContain('mergeCommit');
  });

  it('the LIVE gh calls carry exactly the pinned projections (no stray literal field list)', async () => {
    const view = JSON.stringify({ title: 't', labels: [], isDraft: false, headRefOid: 'h1', state: 'OPEN' });
    const { ghExec, calls } = fakeGh({ 'pr view': { stdout: view }, 'pr list': { stdout: '[]' } });
    const deps = buildGreenPrDeps(baseOpts({ ghExec }), buildGuardLatchStore(baseOpts({ ghExec })));
    await deps.refetchPr(1);
    await deps.listOpenPrs();
    const fieldsOf = (c: string[]) => c[c.indexOf('--json') + 1].split(',');
    const viewCall = calls.find((c) => c[0] === 'pr' && c[1] === 'view')!;
    const listCall = calls.find((c) => c[0] === 'pr' && c[1] === 'list')!;
    expect(fieldsOf(viewCall)).toEqual([...REFETCH_PR_JSON_FIELDS]);
    expect(fieldsOf(listCall)).toEqual([...LIST_PR_JSON_FIELDS]);
    for (const f of [...fieldsOf(viewCall), ...fieldsOf(listCall)]) expect(GH_PR_JSON_FIELDS).toContain(f);
  });

  it('an "Unknown JSON field" exit is a LOUD degradation naming the field (once per field), and still fails toward null', async () => {
    const stderr = 'Unknown JSON field: "mergeCommitOid"\nAvailable fields:\n  additions\n';
    const { ghExec } = fakeGh({ 'pr view': { stdout: '', stderr, code: 1 } });
    const logged: string[] = [];
    const reported: Array<{ feature: string; reason: string }> = [];
    const opts = baseOpts({ ghExec, logger: (m) => logged.push(m), reportDegradation: (e) => reported.push({ feature: e.feature, reason: e.reason }) });
    const deps = buildGreenPrDeps(opts, buildGuardLatchStore(opts));
    expect(await deps.refetchPr(2334)).toBeNull(); // fail-safe direction kept: never merge on a bad read
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('"mergeCommitOid"');
    expect(logged[0]).toContain('refetchPr');
    expect(reported).toHaveLength(1);
    expect(reported[0].feature).toBe('GreenPrAutoMerger.refetchPr.unknownJsonField');
    expect(reported[0].reason).toContain('"mergeCommitOid"');
    // Same field again → the read still fails closed, but the report is not repeated.
    expect(await deps.refetchPr(2335)).toBeNull();
    expect(logged).toHaveLength(1);
    expect(reported).toHaveLength(1);
  });

  it('a non-zero exit WITHOUT an unknown-field message (a vanished PR, auth failure) reports nothing', async () => {
    const { ghExec } = fakeGh({ 'pr view': { stdout: '', stderr: 'GraphQL: Could not resolve to a PullRequest with the number of 99.', code: 1 } });
    const reported: unknown[] = [];
    const opts = baseOpts({ ghExec, reportDegradation: (e) => reported.push(e) });
    const deps = buildGreenPrDeps(opts, buildGuardLatchStore(opts));
    expect(await deps.refetchPr(99)).toBeNull();
    expect(reported).toHaveLength(0);
    expect(reportUnknownGhJsonField('some other error', 'refetchPr', undefined, () => { throw new Error('must not be called'); })).toBeNull();
  });
});

describe('buildGreenPrDeps — disarm seam (Blocker 3)', () => {
  it('disarmArmedEpisodes runs gh pr merge --disable-auto and confirms via an autoMergeRequest re-read', async () => {
    const { ghExec, calls } = fakeGh({
      'pr merge': { stdout: '' },
      'pr view autoMergeRequest': { stdout: JSON.stringify({ autoMergeRequest: null }) }, // confirmed disabled
    });
    const latches = buildGuardLatchStore(baseOpts({ ghExec }));
    const deps = buildGreenPrDeps(baseOpts({ ghExec }), latches);
    const ok = await deps.disarmArmedEpisodes(99);
    expect(ok).toBe(true);
    const mergeCall = calls.find((c) => c[0] === 'pr' && c[1] === 'merge')!;
    expect(mergeCall).toContain('--disable-auto');
  });

  it('reports NOT confirmed-disabled when the re-read still shows auto-merge armed', async () => {
    const { ghExec } = fakeGh({
      'pr merge': { stdout: '' },
      'pr view autoMergeRequest': { stdout: JSON.stringify({ autoMergeRequest: { expectedHeadOid: 'h' } }) }, // still armed
    });
    const latches = buildGuardLatchStore(baseOpts({ ghExec }));
    const deps = buildGreenPrDeps(baseOpts({ ghExec }), latches);
    expect(await deps.disarmArmedEpisodes(99)).toBe(false);
  });
});

describe('the watcher runs the INSTALLED safe-merge, never the checkout copy (ACT-150)', () => {
  it('resolveGreenPrPaths: repoPath is the working checkout, safeMergePath is the installed package copy', () => {
    const p = resolveGreenPrPaths(dir);
    expect(p.repoPath).toBe(dir);
    expect(p.safeMergePath).toBe(installedSafeMergePath());
    expect(p.safeMergePath).not.toBe(path.join(dir, 'scripts', 'safe-merge.mjs'));
    expect(fs.existsSync(p.safeMergePath)).toBe(true);
  });

  it('installedSafeMergePath is <package>/scripts/safe-merge.mjs beside dist/', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    expect(installedSafeMergePath()).toBe(path.join(root, 'scripts', 'safe-merge.mjs'));
  });

  it('the CONSTRUCTED MergeRunner gets the installed path (wiring integrity)', () => {
    const { ghExec } = fakeGh({});
    const { repoPath, safeMergePath: installed } = resolveGreenPrPaths(dir);
    const opts = baseOpts({ ghExec, repoPath, safeMergePath: installed });
    const deps = buildGreenPrDeps(opts, buildGuardLatchStore(opts));
    expect((deps.runner as DefaultMergeRunner).resolvedSafeMergePath).toBe(installedSafeMergePath());
  });

  it('isAnalyzableGreenPrRepo still requires the instar source checkout (git + its safe-merge marker) AND the installed copy', () => {
    const installed = installedSafeMergePath();
    // No .git → not analyzable.
    expect(isAnalyzableGreenPrRepo(dir, installed)).toBe(false);
    fs.mkdirSync(path.join(dir, '.git'));
    // A git repo that is not an instar checkout → not analyzable.
    expect(isAnalyzableGreenPrRepo(dir, installed)).toBe(false);
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.writeFileSync(path.join(dir, 'scripts', 'safe-merge.mjs'), '// stale checkout copy\n');
    expect(isAnalyzableGreenPrRepo(dir, installed)).toBe(true);
    // The installed copy missing → not analyzable, even with the checkout copy present.
    expect(isAnalyzableGreenPrRepo(dir, path.join(dir, 'nope', 'safe-merge.mjs'))).toBe(false);
  });
});

describe('buildGreenPrDeps — codeOwnedPaths reads CODEOWNERS from the base branch on GitHub (directive 2026-10-22)', () => {
  const CODEOWNERS = '# ownership\ndocs/STANDARDS-REGISTRY.md   @JKHeadley\n.github/CODEOWNERS @JKHeadley\n';
  const ghFor = (o: { codeowners?: { code: number; stdout?: string; stderr?: string }; files?: string[]; filesCode?: number }) => {
    const calls: string[][] = [];
    const ghExec = async (args: string[]) => {
      calls.push(args);
      const p = args[1] ?? '';
      if (p.includes('/contents/.github/CODEOWNERS')) {
        const c = o.codeowners ?? { code: 0, stdout: CODEOWNERS };
        return { stdout: c.stdout ?? '', stderr: c.stderr ?? '', code: c.code };
      }
      if (p.endsWith('/files')) return { stdout: (o.files ?? []).join('\n'), stderr: '', code: o.filesCode ?? 0 };
      return { stdout: '', stderr: '', code: 0 };
    };
    return { ghExec, calls };
  };
  const prOf = { number: 9, title: 't', labels: [], isDraft: false, headRefName: 'echo/x', headRefOid: 'h', baseRefName: 'main', mergeable: 'MERGEABLE', statusRollup: 'SUCCESS' };
  const depsWith = (g: ReturnType<typeof ghFor>) => buildGreenPrDeps(baseOpts({ ghExec: g.ghExec }), buildGuardLatchStore(baseOpts({ ghExec: g.ghExec })));

  it('a constitution file is code-owned; CODEOWNERS is read at the PR base ref', async () => {
    const g = ghFor({ files: ['docs/STANDARDS-REGISTRY.md', 'src/a.ts'] });
    const v = await depsWith(g).codeOwnedPaths(prOf as never);
    expect(v).toEqual({ touches: true, files: ['docs/STANDARDS-REGISTRY.md'], protectedFiles: [], unverifiable: false });
    expect(g.calls.some((c) => c[1] === 'repos/JKHeadley/instar/contents/.github/CODEOWNERS?ref=main')).toBe(true);
  });

  it('protected-but-not-code-owned paths (safe-merge, the watcher, .github/workflows) are not code-owned', async () => {
    const g = ghFor({ files: ['scripts/safe-merge.mjs', 'src/monitoring/GreenPrAutoMerger.ts', '.github/workflows/ci.yml'] });
    expect(await depsWith(g).codeOwnedPaths(prOf as never)).toEqual({
      touches: false, files: [], protectedFiles: ['scripts/safe-merge.mjs', 'src/monitoring/GreenPrAutoMerger.ts', '.github/workflows/ci.yml'], unverifiable: false,
    });
  });

  it('an unreadable CODEOWNERS or file list is unverifiable; a 404 CODEOWNERS owns nothing', async () => {
    expect((await depsWith(ghFor({ codeowners: { code: 1, stderr: 'HTTP 500' }, files: ['a'] })).codeOwnedPaths(prOf as never)).unverifiable).toBe(true);
    expect((await depsWith(ghFor({ filesCode: 1 })).codeOwnedPaths(prOf as never)).unverifiable).toBe(true);
    expect(await depsWith(ghFor({ codeowners: { code: 1, stderr: 'gh: Not Found (HTTP 404)' }, files: ['docs/STANDARDS-REGISTRY.md'] })).codeOwnedPaths(prOf as never))
      .toEqual({ touches: false, files: [], protectedFiles: [], unverifiable: false });
  });

  it('independentReviewAtHead reads the PR\'s trace and artifact at the head ref and applies the shared judge', async () => {
    const TRACE = '.instar/instar-dev-traces/t.json';
    const ART = 'upgrades/side-effects/a.md';
    const ARTIFACT = 'x'.repeat(300) + '\n\n## Second-pass review\n\n**Reviewer:** codey\n';
    const TC = '7'.repeat(40);
    const traceBody = (over: Record<string, unknown> = {}) => JSON.stringify({ phase: 'complete', artifactPath: ART, coveredFiles: ['scripts/safe-merge.mjs'], secondPass: 'true', reviewerConcurred: true, artifactSha256: artifactSha256(ARTIFACT), ...over });
    const mk = (traceText: string | null, files = [TRACE, 'scripts/safe-merge.mjs'], changedSinceTrace: string[] = [TRACE]) => {
      const calls: string[][] = [];
      const ghExec = async (args: string[]) => {
        calls.push(args);
        const p = args[1] ?? '';
        if (p.endsWith('/files')) return { stdout: files.join('\n'), stderr: '', code: 0 };
        if (p === `repos/JKHeadley/instar/contents/${TRACE}?ref=h`) return traceText == null ? { stdout: '', stderr: 'HTTP 404', code: 1 } : { stdout: traceText, stderr: '', code: 0 };
        if (p === `repos/JKHeadley/instar/contents/${ART}?ref=h`) return { stdout: ARTIFACT, stderr: '', code: 0 };
        if (p === `repos/JKHeadley/instar/commits?sha=h&path=${encodeURIComponent(TRACE)}&per_page=1`) return { stdout: `${TC}\n`, stderr: '', code: 0 };
        if (p === `repos/JKHeadley/instar/compare/${TC}...h`) return { stdout: changedSinceTrace.join('\n'), stderr: '', code: 0 };
        return { stdout: '', stderr: 'HTTP 404', code: 1 };
      };
      return { ghExec, calls };
    };
    const ok = mk(traceBody());
    expect(await depsWith(ok).independentReviewAtHead!(prOf as never, ['scripts/safe-merge.mjs'])).toEqual({ ok: true, unverifiable: false });
    expect(ok.calls.some((c) => c[1] === `repos/JKHeadley/instar/contents/${TRACE}?ref=h`)).toBe(true);
    expect((await depsWith(mk(traceBody({ coveredFiles: ['src/x.ts'] }))).independentReviewAtHead!(prOf as never, ['scripts/safe-merge.mjs'])).problem).toMatch(/not-covered/);
    expect((await depsWith(mk(traceBody({ reviewerConcurred: false }))).independentReviewAtHead!(prOf as never, ['scripts/safe-merge.mjs'])).ok).toBe(false);
    // Not at the head (pushed later) → absent from the head ref.
    expect((await depsWith(mk(null)).independentReviewAtHead!(prOf as never, ['scripts/safe-merge.mjs'])).ok).toBe(false);
    expect((await depsWith(mk(traceBody(), ['scripts/safe-merge.mjs'])).independentReviewAtHead!(prOf as never, ['scripts/safe-merge.mjs'])).problem).toBe('no-trace-in-pr');
    // Bound to the head: a flagged file changed after the trace's last commit needs a new review.
    const stale = await depsWith(mk(traceBody(), undefined, ['scripts/safe-merge.mjs'])).independentReviewAtHead!(prOf as never, ['scripts/safe-merge.mjs']);
    expect(stale).toMatchObject({ ok: false, problem: expect.stringMatching(/flagged-changed-after-trace:scripts\/safe-merge\.mjs/) });
    // GitHub's compare lists at most 300 files: a list that long may hide a flagged path → unverifiable.
    const many = Array.from({ length: 300 }, (_, i) => `src/gen/f${i}.ts`);
    const truncated = await depsWith(mk(traceBody(), undefined, many)).independentReviewAtHead!(prOf as never, ['scripts/safe-merge.mjs']);
    expect(truncated).toEqual({ ok: false, unverifiable: true, problem: 'review-binding-truncated' });
    const under = await depsWith(mk(traceBody(), undefined, many.slice(0, 299))).independentReviewAtHead!(prOf as never, ['scripts/safe-merge.mjs']);
    expect(under).toEqual({ ok: true, unverifiable: false });
  });
});
