// safe-git-allow: test file — execFileSync('git', ...) builds sandbox repo
//   fixtures (init, add, commit). No production code path.
// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Unit tests — duplicate-build guard check library
 * (scripts/lib/duplicate-build-check.mjs; spec docs/specs/duplicate-build-guard.md §4).
 *
 * Covers, per spec §4:
 *  - target extraction (exact + the deterministic Jaccard fuzzy floor,
 *    including a missing `## Decision points touched` section);
 *  - the TOTAL verdict ladder incl. every `cause`, the non-substrate-degraded
 *    cell, and WEAK-only → silent clear;
 *  - fail-open on EVERY error path (bad spec, gh crash, git error, timeout,
 *    torn ledger line → non-blocking verdict + CLI exit 0);
 *  - §3.2a type-validation drops (a malformed untrusted value is dropped,
 *    never shelled — not a blanket leading-`-` reject);
 *  - ledger write-first-then-scan simultaneous-append race (exactly one of
 *    two builders yields; earlier startedAt wins; lexicographic tiebreak);
 *  - liveness conjunction (pid-reuse ≠ live; old-but-live still fires);
 *  - terminal removal + compaction;
 *  - fuzzy byte-cap enforcement BEFORE similarity;
 *  - the FD6 Jaccard calibration corpus (recall on known dups + a precision
 *    floor on known non-dups at the shipped threshold constant).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
// @ts-expect-error: .mjs script, not typed
import {
  JACCARD_THRESHOLD,
  MAX_TARGETS,
  PR_BODY_CAP_BYTES,
  LEDGER_REL_PATH,
  AUDIT_REL_PATH,
  extractTargets,
  normalizeTokens,
  tokenSetJaccard,
  capBytes,
  clampUntrusted,
  isValidToken,
  isValidRepoRelPath,
  isValidPrNumber,
  isValidRef,
  appendLedgerMarker,
  removeLedgerMarker,
  compactLedger,
  parseLedgerLines,
  scanLedgerForOverlap,
  isEntryLive,
  getProcStartToken,
  runDuplicateBuildCheck,
  recordDisposition,
  readStub,
  writeStub,
  checkErroredAutoStub,
  specSlugFromPath,
} from '../../scripts/lib/duplicate-build-check.mjs';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LIB_PATH = path.join(REPO_ROOT, 'scripts', 'lib', 'duplicate-build-check.mjs');

// ── fixtures ────────────────────────────────────────────────────────────────

const SUBSTRATE_SPEC = `---
spec: demo-guard
---

# Demo Guard — a substrate-introducing spec

## 1. Problem statement (verified)

The demo subsystem records nothing about widget refresh, so a widget refresh
that fails is invisible and cannot be graded or retried by the scheduler.

## 2. Scope of THIS increment

A deterministic widget-refresh recorder shipping \`src/data/provenanceCoverage.ts\`
entries and the \`DemoCoverageEntry\` symbol wired from \`src/monitoring/DemoRecorder.ts\`.

## Decision points touched
- **Refresh RECORDING** (\`demo-census-point\`) — invariant.
`;

const PROSE_SPEC = `# Prose-only note

## Problem statement

Nothing concrete is named here; there are no code paths, identifiers, or
census entries in this document — purely narrative prose about direction.

## Scope

Also prose. No substrate is introduced by this document at all.
`;

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

/** A minimal git sandbox repo whose HEAD branch is `main`. */
function mkSandboxRepo(): string {
  const dir = mkTmp('dupcheck-repo-');
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 't']);
  fs.mkdirSync(path.join(dir, 'src', 'data'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'data', 'other.ts'), 'export const other = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'init']);
  git(dir, ['branch', '-M', 'main']);
  return dir;
}

function mkAgentHome(): string {
  const home = mkTmp('dupcheck-home-');
  fs.mkdirSync(path.join(home, '.worktrees'), { recursive: true });
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  return home;
}

function writeSpec(root: string, content: string, name = 'demo-guard.md'): string {
  const p = path.join(root, 'docs', 'specs', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

const EMPTY_PR_SOURCE = () => ({ ok: true, prs: [], rawHash: 'empty' });

type CheckOpts = Record<string, unknown>;

/** Run the check with hermetic defaults (no gh, no agent-home surprises). */
function check(root: string, specPath: string, extra: CheckOpts = {}) {
  return runDuplicateBuildCheck({
    specPath,
    root,
    env: {},
    openPrSource: EMPTY_PR_SOURCE,
    agentHome: null,
    noCache: true,
    ...extra,
  });
}

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    try {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/duplicate-build-check.test.ts:cleanup' });
    } catch { /* ignore */ }
  }
});
function track<T extends string>(dir: T): T {
  cleanups.push(dir);
  return dir;
}

// ── §3.1 target extraction ───────────────────────────────────────────────────

describe('target extraction (§3.1)', () => {
  it('extracts census ids, substrate files, and symbols as STRONG-exact targets', () => {
    const { targets, substrateIntroducing } = extractTargets(SUBSTRATE_SPEC);
    const byKind = (k: string) => targets.filter((t: any) => t.kind === k).map((t: any) => t.value);
    expect(byKind('census-id')).toContain('demo-census-point');
    expect(byKind('file')).toContain('src/data/provenanceCoverage.ts');
    expect(byKind('file')).toContain('src/monitoring/DemoRecorder.ts');
    expect(byKind('symbol')).toContain('DemoCoverageEntry');
    expect(substrateIntroducing).toBe(true);
  });

  it('generic backticked prose words never become census-id targets (precision)', () => {
    const spec = SUBSTRATE_SPEC.replace('`demo-census-point`', '`demo-census-point` and `invariant` and `verify`');
    const { targets } = extractTargets(spec);
    const ids = targets.filter((t: any) => t.kind === 'census-id').map((t: any) => t.value);
    expect(ids).toContain('demo-census-point');
    expect(ids).not.toContain('invariant');
    expect(ids).not.toContain('verify');
  });

  it('a missing `## Decision points touched` section still yields a usable fingerprint', () => {
    const noDp = SUBSTRATE_SPEC.replace(/## Decision points touched[\s\S]*$/, '');
    const { fingerprint, targets } = extractTargets(noDp);
    expect(fingerprint.size).toBeGreaterThan(5);
    // file/symbol targets survive; only the census-id section is gone
    expect(targets.some((t: any) => t.kind === 'file')).toBe(true);
    expect(targets.some((t: any) => t.kind === 'census-id')).toBe(false);
  });

  it('a prose-only spec yields no strong targets (substrateIntroducing=false) but a fingerprint', () => {
    const { targets, substrateIntroducing, fingerprint } = extractTargets(PROSE_SPEC);
    expect(targets).toHaveLength(0);
    expect(substrateIntroducing).toBe(false);
    expect(fingerprint.size).toBeGreaterThan(3);
  });

  it('drops (never shells) a path value failing its type validation — §3.2a', () => {
    const evil = SUBSTRATE_SPEC + '\nAlso touches `src/evil/../../outside/x.ts` on the way.\n';
    const { targets, dropped } = extractTargets(evil);
    expect(targets.map((t: any) => t.value)).not.toContain('src/evil/../../outside/x.ts');
    expect(dropped).toBeGreaterThanOrEqual(1);
  });

  it('caps the target set at MAX_TARGETS', () => {
    const many = SUBSTRATE_SPEC + '\n' +
      Array.from({ length: 40 }, (_, i) => `Adds \`src/gen/file${i}.ts\`.`).join('\n');
    const { targets } = extractTargets(many);
    expect(targets.length).toBeLessThanOrEqual(MAX_TARGETS);
  });
});

// ── §3.2a validators (type validation, not blanket leading-dash rejects) ─────

describe('type validators (§3.2a)', () => {
  it('validates by TYPE for the argument position', () => {
    expect(isValidToken('messaging-tone-gate')).toBe(true);
    expect(isValidToken('DP_EXTERNAL_HOG')).toBe(true);
    expect(isValidToken('-upload-pack=e')).toBe(false); // option-shaped → dropped
    expect(isValidToken('a b')).toBe(false);
    expect(isValidRepoRelPath('src/data/provenanceCoverage.ts')).toBe(true);
    expect(isValidRepoRelPath('../etc/passwd')).toBe(false);
    expect(isValidRepoRelPath('/abs/path.ts')).toBe(false);
    expect(isValidRepoRelPath('src/a/../b.ts')).toBe(false);
    expect(isValidPrNumber(1458)).toBe(true);
    expect(isValidPrNumber(-1)).toBe(false);
    expect(isValidPrNumber('1458' as unknown as number)).toBe(false);
    expect(isValidRef('origin/main')).toBe(true);
    expect(isValidRef('echo/dup-build-guard')).toBe(true);
    expect(isValidRef('-option')).toBe(false);
    expect(isValidRef('a..b')).toBe(false);
    expect(isValidRef('a@{1}')).toBe(false);
  });

  it('clampUntrusted strips control/escape chars and clamps length', () => {
    const raw = 'ok\u0000\u001b[31mred\u001b[0m\u0007text' + 'x'.repeat(1000);
    const out = clampUntrusted(raw);
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.startsWith('ok')).toBe(true);
  });
});

// ── FD6 fuzzy floor: calibration corpus + byte caps ──────────────────────────

describe('FD6 fuzzy floor — calibration corpus', () => {
  const corpus = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'dup-build-calibration.json'), 'utf-8'),
  );
  const score = (pair: any) => tokenSetJaccard(
    normalizeTokens(capBytes(`${pair.a.title} ${pair.a.body}`, 12 * 1024)),
    normalizeTokens(capBytes(`${pair.b.title} ${pair.b.body}`, 12 * 1024)),
  );

  it('has full RECALL on the known-duplicate pairs at the shipped threshold', () => {
    for (const pair of corpus.duplicates) {
      const s = score(pair);
      expect(s, `dup pair "${pair.name}" scored ${s} < threshold ${JACCARD_THRESHOLD}`).toBeGreaterThanOrEqual(JACCARD_THRESHOLD);
    }
  });

  it('holds a PRECISION floor of ≥0.75 on the known-non-duplicate pairs', () => {
    const total = corpus.nonDuplicates.length;
    expect(total).toBeGreaterThanOrEqual(6); // the corpus must stay adversarially meaningful
    const below = corpus.nonDuplicates.filter((p: any) => score(p) < JACCARD_THRESHOLD).length;
    expect(below / total).toBeGreaterThanOrEqual(0.75);
  });

  it('includes the real 2026-07-12 incident pair and it is caught', () => {
    const incident = corpus.duplicates.find((p: any) => p.name.includes('incident'));
    expect(incident).toBeTruthy();
    expect(score(incident)).toBeGreaterThanOrEqual(JACCARD_THRESHOLD);
  });
});

describe('FD6 byte caps are enforced BEFORE similarity math', () => {
  it('capBytes truncates by BYTES, not characters', () => {
    const s = 'é'.repeat(5000); // 2 bytes each
    const capped = capBytes(s, 1000);
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(1000);
  });

  it('a matching PR body whose overlap sits entirely past the 8KB cap does NOT fuzzy-match', () => {
    const root = track(mkSandboxRepo());
    const specPath = writeSpec(root, SUBSTRATE_SPEC);
    const filler = 'zqx unrelated filler words padding nothing alike whatsoever '.repeat(200); // > 8KB
    expect(Buffer.byteLength(filler, 'utf8')).toBeGreaterThan(PR_BODY_CAP_BYTES);
    const matchTail =
      ' demo subsystem records nothing about widget refresh; widget refresh recorder grading retries scheduler substrate';
    const beyondCap = check(root, specPath, {
      openPrSource: () => ({
        ok: true,
        rawHash: 'h1',
        prs: [{ number: 7, title: 'unrelated title', headRefName: null, body: filler + matchTail, files: [] }],
      }),
    });
    expect(beyondCap.evidence.filter((e: any) => e.strength === 'fuzzy')).toHaveLength(0);

    // control: the SAME overlap text within the cap DOES match
    const withinCap = check(root, specPath, {
      openPrSource: () => ({
        ok: true,
        rawHash: 'h2',
        prs: [{ number: 8, title: 'widget refresh recorder', headRefName: null, body: matchTail.repeat(4), files: [] }],
      }),
    });
    expect(withinCap.evidence.some((e: any) => e.strength === 'fuzzy')).toBe(true);
  });
});

// ── §3.3 the TOTAL verdict ladder ─────────────────────────────────────────────

describe('the TOTAL verdict ladder (§3.3, FD4)', () => {
  let root: string;
  let specPath: string;
  beforeEach(() => {
    root = track(mkSandboxRepo());
    specPath = writeSpec(root, SUBSTRATE_SPEC);
  });

  it('clear: no overlap + all concurrency sources scanned (ledger via agent home)', () => {
    const home = track(mkAgentHome());
    const r = check(root, specPath, { agentHome: home, allowedRoots: [path.join(home, '.worktrees')] });
    expect(r.verdict).toBe('clear');
    expect(r.degraded).toBe(false);
    expect(r.cause).toBeNull();
  });

  it('likely-duplicate: an open PR touching a STRONG substrate file (cause: concurrency)', () => {
    const r = check(root, specPath, {
      openPrSource: () => ({
        ok: true,
        rawHash: 'h',
        prs: [{ number: 1458, title: 'Another effort', headRefName: null, body: 'different words entirely', files: ['src/data/provenanceCoverage.ts'] }],
      }),
    });
    expect(r.verdict).toBe('likely-duplicate');
    expect(r.cause).toBe('concurrency');
    expect(r.evidence.some((e: any) => e.source === 'open-pr' && e.strength === 'strong' && e.prNumber === 1458)).toBe(true);
  });

  it('likely-duplicate: a recently-merged commit touching a STRONG target file', () => {
    fs.writeFileSync(path.join(root, 'src', 'data', 'provenanceCoverage.ts'), 'export const census = [];\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'feat: add provenance census (other tracking id)']);
    const r = check(root, specPath, { mainRef: 'main' });
    expect(r.verdict).toBe('likely-duplicate');
    expect(r.evidence.some((e: any) => e.source === 'merged-commit' && e.strength === 'strong')).toBe(true);
  });

  it('verify (cause: fuzzy): a fuzzy-only open-PR hit never escalates to likely-duplicate', () => {
    const r = check(root, specPath, {
      openPrSource: () => ({
        ok: true,
        rawHash: 'h',
        prs: [{
          number: 9,
          title: 'Widget refresh recorder for the demo subsystem',
          headRefName: null,
          body: 'Records widget refresh outcomes so a failed refresh is visible and can be graded and retried by the scheduler.',
          files: ['src/unrelated/elsewhere.ts'],
        }],
      }),
    });
    expect(r.verdict).toBe('verify');
    expect(r.cause).toBe('fuzzy');
  });

  it('verify (cause: main-only): a STRONG target present only on main-state (old commit, outside lookback)', () => {
    fs.writeFileSync(path.join(root, 'src', 'data', 'provenanceCoverage.ts'), 'export const census = [];\n');
    git(root, ['add', '-A']);
    execFileSync('git', ['commit', '-qm', 'old census commit'], {
      cwd: root,
      encoding: 'utf-8',
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
      },
    });
    const r = check(root, specPath, { mainRef: 'main' });
    expect(r.verdict).toBe('verify');
    expect(r.cause).toBe('main-only');
    // never a block source: no strong concurrency evidence
    expect(r.evidence.filter((e: any) => e.strength === 'strong')).toHaveLength(0);
  });

  it('verify (cause: degraded): a degraded scan on a SUBSTRATE-introducing spec', () => {
    const r = check(root, specPath, { agentHome: null }); // ledger unresolvable → degraded
    expect(r.verdict).toBe('verify');
    expect(r.cause).toBe('degraded');
    expect(r.degraded).toBe(true);
  });

  it('the non-substrate-degraded cell: degraded scan on a PROSE spec → clear + degraded audit flag', () => {
    const prosePath = writeSpec(root, PROSE_SPEC, 'prose.md');
    const r = check(root, prosePath, { agentHome: null });
    expect(r.verdict).toBe('clear');
    expect(r.degraded).toBe(true); // inspectable, not silent
    expect(r.notes.join(' ')).toMatch(/degraded NON-substrate/i);
  });

  it('WEAK-only overlap → SILENT clear + a quiet note, never verify', () => {
    const home = track(mkAgentHome());
    const r = check(root, specPath, {
      agentHome: home,
      allowedRoots: [path.join(home, '.worktrees')],
      weakChangedFiles: ['src/shared/util.ts'],
      openPrSource: () => ({
        ok: true,
        rawHash: 'h',
        prs: [{ number: 12, title: 'totally different feature', headRefName: null, body: 'nothing alike in vocabulary here at all', files: ['src/shared/util.ts'] }],
      }),
    });
    expect(r.verdict).toBe('clear');
    expect(r.notes.join(' ')).toMatch(/quiet note: 1 open PR/);
  });

  it('real-overlap causes OUTRANK the environmental degraded tag; causes[] carries the set', () => {
    // degraded (no agent home) + fuzzy PR hit at once → cause is `fuzzy`
    const r = check(root, specPath, {
      agentHome: null,
      openPrSource: () => ({
        ok: true,
        rawHash: 'h',
        prs: [{
          number: 13,
          title: 'Widget refresh recorder for the demo subsystem',
          headRefName: null,
          body: 'Records widget refresh outcomes so a failed refresh is visible and can be graded and retried by the scheduler.',
          files: [],
        }],
      }),
    });
    expect(r.verdict).toBe('verify');
    expect(r.cause).toBe('fuzzy');
    expect(r.causes).toContain('degraded');
    expect(r.causes).toContain('fuzzy');
  });

  it('stage 2: an open PR ADDING a census identity in its diff is a STRONG match', () => {
    const r = check(root, specPath, {
      openPrSource: () => ({
        ok: true,
        rawHash: 'h',
        prs: [{ number: 21, title: 'demo-census-point wiring', headRefName: null, body: 'unrelated body words', files: [] }],
      }),
      prDiffSource: () => ({ ok: true, addedText: "  { id: 'demo-census-point', status: 'wired' },\n" }),
    });
    expect(r.verdict).toBe('likely-duplicate');
    expect(r.evidence.some((e: any) => e.source === 'open-pr' && /ADDING identity/.test(e.detail))).toBe(true);
  });

  it('stage 2 diff failure degrades to verify for a title-matched PR, never silent clear', () => {
    const r = check(root, specPath, {
      agentHome: track(mkAgentHome()),
      openPrSource: () => ({
        ok: true,
        rawHash: 'h',
        prs: [{ number: 22, title: 'demo-census-point wiring', headRefName: null, body: 'unrelated body words', files: [] }],
      }),
      prDiffSource: () => ({ ok: false }), // cap-exceed / timeout
    });
    expect(['verify', 'likely-duplicate']).toContain(r.verdict);
    expect(r.verdict).toBe('verify');
    expect(r.degradedSources.some((s: string) => s.includes('pr-diff-22'))).toBe(true);
  });
});

// ── §3.3 fail-open TOTALITY ──────────────────────────────────────────────────

describe('fail-open on EVERY error path (§3.3, FD5)', () => {
  it('a bad/missing spec → check-errored, never a throw', () => {
    const root = track(mkSandboxRepo());
    const r = runDuplicateBuildCheck({ specPath: path.join(root, 'nope.md'), root, env: {} });
    expect(r.verdict).toBe('check-errored');
    expect(r.cause).toBe('check-error');
  });

  it('CLI: bad spec → exit 0 with a check-errored verdict (non-blocking)', () => {
    const root = track(mkSandboxRepo());
    const res = spawnSync(process.execPath, [LIB_PATH, 'does/not/exist.md', '--json', '--root', root], {
      encoding: 'utf-8',
      env: { ...process.env, CI: '1' },
    });
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout).verdict).toBe('check-errored');
  });

  it('CLI: gh missing entirely (PATH stripped to node+git only) → degraded verdict, exit 0', () => {
    const root = track(mkSandboxRepo());
    const specPath = writeSpec(root, SUBSTRATE_SPEC);
    // Build a bin dir holding ONLY node + git + ps so gh is genuinely absent.
    const bin = track(mkTmp('dupcheck-bin-'));
    for (const tool of ['git', 'ps']) {
      try {
        const real = execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf-8' }).trim();
        fs.symlinkSync(real, path.join(bin, tool));
      } catch { /* tool not found — test still meaningful */ }
    }
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    const res = spawnSync(process.execPath, [LIB_PATH, path.relative(root, specPath), '--json', '--root', root], {
      encoding: 'utf-8',
      cwd: root,
      env: { PATH: bin, HOME: process.env.HOME ?? '' },
    });
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.verdict).toBe('verify'); // degraded substrate scan → verify, LOUD (never silent clear)
    expect(out.degradedSources).toContain('open-prs');
  });

  it('a torn ledger last line on a substrate spec raises verify (never fails the scan)', () => {
    const root = track(mkSandboxRepo());
    const specPath = writeSpec(root, SUBSTRATE_SPEC);
    const home = track(mkAgentHome());
    fs.appendFileSync(path.join(home, LEDGER_REL_PATH), '{"id":"x","truncated-mid-wri');
    const r = check(root, specPath, { agentHome: home, allowedRoots: [path.join(home, '.worktrees')] });
    expect(r.verdict).toBe('verify');
    expect(r.degradedSources).toContain('ledger-torn-line');
  });

  it('a zero total budget degrades sources instead of hanging or throwing', () => {
    const root = track(mkSandboxRepo());
    const specPath = writeSpec(root, SUBSTRATE_SPEC);
    const r = check(root, specPath, { totalBudgetMs: 0, agentHome: track(mkAgentHome()) });
    expect(['verify', 'check-errored']).toContain(r.verdict);
  });

  it('git errors (not a git repo) degrade loudly, never throw', () => {
    const root = track(mkTmp('dupcheck-nogit-'));
    fs.mkdirSync(path.join(root, 'docs', 'specs'), { recursive: true });
    const specPath = writeSpec(root, SUBSTRATE_SPEC);
    const r = check(root, specPath);
    expect(r.verdict).toBe('verify'); // substrate + degraded (no main ref)
    expect(r.degradedSources).toContain('merged-lookback-no-main');
  });

  it('INSTAR_DUP_BUILD_CHECK=off → total no-op (skipped)', () => {
    const root = track(mkSandboxRepo());
    const specPath = writeSpec(root, SUBSTRATE_SPEC);
    const r = runDuplicateBuildCheck({ specPath, root, env: { INSTAR_DUP_BUILD_CHECK: 'off' } });
    expect(r.verdict).toBe('skipped');
  });

  it('open-PR scan is skipped under CI (by design, loud in degradedSources)', () => {
    const root = track(mkSandboxRepo());
    const specPath = writeSpec(root, SUBSTRATE_SPEC);
    const r = runDuplicateBuildCheck({ specPath, root, env: { CI: '1' }, agentHome: track(mkAgentHome()), noCache: true });
    expect(r.degradedSources).toContain('open-prs-skipped-ci');
  });
});

// ── §3.2(1) ledger semantics ─────────────────────────────────────────────────

describe('sibling ledger — write-first-then-scan, race, liveness, lifecycle', () => {
  let home: string;
  let jail: string;
  const realToken = getProcStartToken(process.pid);

  beforeEach(() => {
    home = track(mkAgentHome());
    jail = path.join(home, '.worktrees');
  });

  function liveEntry(overrides: Record<string, unknown> = {}) {
    const wt = fs.mkdtempSync(path.join(jail, 'sib-'));
    return {
      id: Math.random().toString(16).slice(2),
      agent: 'test',
      host: 'test-host',
      branch: 'echo/sibling',
      specSlug: 'other-slug',
      targets: ['src/data/provenanceCoverage.ts'],
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      pid: process.pid,
      procStartToken: realToken,
      worktreePath: wt,
      ...overrides,
    };
  }

  it('simultaneous-append race: exactly one of two builders yields (earlier startedAt wins)', () => {
    const tA = new Date(Date.now() - 10_000).toISOString();
    const tB = new Date().toISOString();
    const a = liveEntry({ id: 'aaa', branch: 'a', startedAt: tA });
    const b = liveEntry({ id: 'bbb', branch: 'b', startedAt: tB });
    appendLedgerMarker(home, a);
    appendLedgerMarker(home, b);
    const opts = { allowedRoots: [jail] };
    const scanA = scanLedgerForOverlap(home, a, opts);
    const scanB = scanLedgerForOverlap(home, b, opts);
    expect(scanA.losses).toHaveLength(0); // A started earlier — A wins
    expect(scanB.losses).toHaveLength(1); // B yields
  });

  it('simultaneous-append tie: lexicographic (pid, branch) tiebreak — exactly one yields', () => {
    const t = new Date().toISOString();
    const a = liveEntry({ id: 'aaa', branch: 'aaa-branch', startedAt: t });
    const b = liveEntry({ id: 'bbb', branch: 'zzz-branch', startedAt: t });
    appendLedgerMarker(home, a);
    appendLedgerMarker(home, b);
    const opts = { allowedRoots: [jail] };
    const scanA = scanLedgerForOverlap(home, a, opts);
    const scanB = scanLedgerForOverlap(home, b, opts);
    const yields = [scanA.losses.length > 0, scanB.losses.length > 0].filter(Boolean);
    expect(yields).toHaveLength(1); // exactly one
    expect(scanB.losses.length).toBe(1); // same pid → 'aaa-branch' < 'zzz-branch' → B yields
  });

  it('liveness is a CONJUNCTION: a live pid with the WRONG procStartToken is NOT live (pid-reuse)', () => {
    const e = liveEntry({ procStartToken: 'Mon Jan 1 00:00:00 1990' });
    expect(isEntryLive(e, { allowedRoots: [jail] })).toBe(false);
  });

  it('a provably dead pid is not live', () => {
    const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf-8' });
    const deadPid = (child as unknown as { pid?: number }).pid ?? 999999;
    const e = liveEntry({ pid: deadPid, procStartToken: 'anything' });
    expect(isEntryLive(e, { allowedRoots: [jail] })).toBe(false);
  });

  it('an OLD but still-live entry STILL fires (age alone never marks live work stale)', () => {
    const old = liveEntry({ startedAt: new Date(Date.now() - 10 * 24 * 3600_000).toISOString() });
    appendLedgerMarker(home, old);
    const self = liveEntry({ id: 'self', worktreePath: fs.mkdtempSync(path.join(jail, 'self-')) });
    const scan = scanLedgerForOverlap(home, self, { allowedRoots: [jail] });
    expect(scan.losses).toHaveLength(1);
  });

  it('a worktreePath OUTSIDE the allowed roots is rejected (planted-marker jail §3.2a)', () => {
    const outside = track(mkTmp('dupcheck-outside-'));
    const e = liveEntry({ worktreePath: outside });
    expect(isEntryLive(e, { allowedRoots: [jail] })).toBe(false);
  });

  it('a symlinked worktreePath is rejected', () => {
    const real = fs.mkdtempSync(path.join(jail, 'real-'));
    const link = path.join(jail, 'link-sib');
    fs.symlinkSync(real, link);
    const e = liveEntry({ worktreePath: link });
    expect(isEntryLive(e, { allowedRoots: [jail] })).toBe(false);
  });

  it('a missing worktreePath (ENOENT mid-scan) is skipped, not fatal', () => {
    const gone = path.join(jail, 'gone-sib');
    const e = liveEntry({ worktreePath: gone });
    expect(isEntryLive(e, { allowedRoots: [jail] })).toBe(false);
  });

  it('terminal removal: the marker is removed at the terminal transition', () => {
    const e = liveEntry({ id: 'to-remove' });
    appendLedgerMarker(home, e);
    expect(removeLedgerMarker(home, 'to-remove')).toBe(true);
    const raw = fs.readFileSync(path.join(home, LEDGER_REL_PATH), 'utf-8');
    expect(raw).not.toContain('to-remove');
  });

  it('compaction sweeps provably-dead orphans but preserves live entries and a torn last line', () => {
    const live = liveEntry({ id: 'live-one' });
    appendLedgerMarker(home, live);
    appendLedgerMarker(home, liveEntry({ id: 'dead-one', procStartToken: 'WRONG TOKEN' }));
    fs.appendFileSync(path.join(home, LEDGER_REL_PATH), '{"id":"torn","mid-wri');
    const res = compactLedger(home, { allowedRoots: [jail] });
    expect(res.compacted).toBe(true);
    const raw = fs.readFileSync(path.join(home, LEDGER_REL_PATH), 'utf-8');
    expect(raw).toContain('live-one');
    expect(raw).not.toContain('dead-one');
    expect(raw).toContain('"torn"'); // a torn LAST line may be a sibling mid-append — preserved
  });

  it('parseLedgerLines skips unparseable lines and flags a torn LAST line', () => {
    const parsed = parseLedgerLines('{"id":"a"}\nnot json at all\n{"id":"b"}\n{"torn');
    expect(parsed.entries.map((e: any) => e.id)).toEqual(['a', 'b']);
    expect(parsed.skipped).toBe(2);
    expect(parsed.tornLast).toBe(true);
  });

  it('the ledger file is created mode 0600', () => {
    appendLedgerMarker(home, liveEntry({ id: 'mode-check' }));
    const mode = fs.statSync(path.join(home, LEDGER_REL_PATH)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('end-to-end: a live local sibling on shared targets → likely-duplicate', () => {
    const root = track(mkSandboxRepo());
    const specPath = writeSpec(root, SUBSTRATE_SPEC);
    appendLedgerMarker(home, liveEntry({ startedAt: new Date(Date.now() - 3600_000).toISOString() }));
    const r = check(root, specPath, {
      agentHome: home,
      allowedRoots: [jail],
      pid: process.pid,
      procStartToken: realToken,
    });
    expect(r.verdict).toBe('likely-duplicate');
    expect(r.evidence.some((e: any) => e.source === 'local-sibling' && e.strength === 'strong')).toBe(true);
  });
});

// ── cache + audit + disposition ──────────────────────────────────────────────

describe('cache, audit trail, disposition', () => {
  it('identical inputs share ONE computation; a main-HEAD move re-keys', () => {
    const root = track(mkSandboxRepo());
    const specPath = writeSpec(root, SUBSTRATE_SPEC);
    const home = track(mkAgentHome());
    const opts = { agentHome: home, allowedRoots: [path.join(home, '.worktrees')], noCache: false };
    const first = check(root, specPath, opts);
    expect(first.cached).toBe(false);
    const second = check(root, specPath, opts);
    expect(second.cached).toBe(true);
    expect(second.verdict).toBe(first.verdict);
    // move main HEAD → re-keyed → recomputed
    fs.writeFileSync(path.join(root, 'src', 'data', 'other.ts'), 'export const other = 2;\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', 'bump']);
    const third = check(root, specPath, opts);
    expect(third.cached).toBe(false);
  });

  it('every verdict lands in logs/dup-build-check.jsonl as METADATA ONLY (no PR body text)', () => {
    const root = track(mkSandboxRepo());
    const specPath = writeSpec(root, SUBSTRATE_SPEC);
    const SECRET_BODY = 'THIS-BODY-TEXT-MUST-NEVER-REACH-THE-AUDIT';
    check(root, specPath, {
      openPrSource: () => ({
        ok: true,
        rawHash: 'h',
        prs: [{ number: 31, title: 'x', headRefName: null, body: SECRET_BODY, files: ['src/data/provenanceCoverage.ts'] }],
      }),
    });
    const audit = fs.readFileSync(path.join(root, AUDIT_REL_PATH), 'utf-8');
    expect(audit).toContain('"verdict":"likely-duplicate"');
    expect(audit).toContain('"prNumber":31');
    expect(audit).not.toContain(SECRET_BODY);
  });

  it('a likely-duplicate proceed REQUIRES a reason + ≥1 acknowledged evidence id (§3.4)', () => {
    const root = track(mkSandboxRepo());
    writeStub(root, {
      verdict: 'likely-duplicate',
      cause: 'concurrency',
      evidence: [{ id: 'EV-1', source: 'open-pr', strength: 'strong', detail: 'x', prNumber: 1 }],
      specSlug: 'demo-guard',
    });
    const noAck = recordDisposition(root, { decision: 'proceed', reason: 'looked at it' });
    expect(noAck.ok).toBe(false);
    const noReason = recordDisposition(root, { decision: 'proceed', reason: '', acknowledgedEvidenceIds: ['EV-1'] });
    expect(noReason.ok).toBe(false);
    const good = recordDisposition(root, { decision: 'proceed', reason: 'EV-1 is a different subsystem', acknowledgedEvidenceIds: ['EV-1'] });
    expect(good.ok).toBe(true);
    expect(readStub(root).disposition.decision).toBe('proceed');
  });

  it('the §3.4 check-errored auto-stub carries the exact fail-open disposition', () => {
    const stub = checkErroredAutoStub();
    expect(stub.verdict).toBe('check-errored');
    expect(stub.cause).toBe('check-error');
    expect(stub.disposition.decision).toBe('proceed');
    expect(stub.disposition.reason).toBe('auto: check errored (fail-open)');
  });

  it('specSlugFromPath derives a stable slug', () => {
    expect(specSlugFromPath('docs/specs/duplicate-build-guard.md')).toBe('duplicate-build-guard');
    expect(specSlugFromPath('Weird NAME.md')).toBe('weird-name');
  });
});
