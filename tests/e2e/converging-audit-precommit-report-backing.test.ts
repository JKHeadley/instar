// safe-git-allow: test file — execFileSync('git') builds the fixture repo; fs.rmSync is per-test tmpdir cleanup.
/**
 * Tier 3 (E2E) — runs the REAL scripts/instar-dev-precommit.js in a fixture git
 * repo and proves the Report-Backed Converging Audit
 * (docs/specs/CONVERGING-AUDIT-DEFAULT.md, Part B) behaves correctly under both
 * flag states — and is BYTE-IDENTICAL to today when the flag is unset.
 *
 * The precommit hardcodes ROOT to its own parent dir (path.resolve(__dirname,
 * '..')), so to exercise it against a fixture we COPY the real script + its tiny
 * dependency set into the fixture's scripts/ tree (preserving the relative
 * import layout) and invoke the COPY. The copy is the real, unmodified gate
 * logic — only its ROOT relocates to the fixture.
 *
 * Three assertions, all driving the actual gate:
 *   1. env UNSET            → a timestamp-tagged + approved spec + staged source
 *                            COMMITS cleanly (today's behavior, byte-identical).
 *   2. env=1, NO report     → the same commit is BLOCKED (report required).
 *   3. env=1, report PRESENT → the commit succeeds again.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

// The real gate script + its self-contained dependency set (no node_modules).
const COPY_FILES = [
  'scripts/instar-dev-precommit.js',
  'scripts/eli16-overview-check.mjs',
  'scripts/lib/classify-tier.mjs',
  'scripts/lib/convergence-recognition.mjs',
  'scripts/lib/operator-surface.mjs',
  'scripts/lib/self-action-detect.mjs',
  'skills/instar-dev/scripts/verify-proposal-derived-runbook.mjs',
  'docs/STANDARDS-REGISTRY.md',
];

const PARENT_PRINCIPLE = 'Structure beats Willpower'; // resolves to a real registry heading

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

let repo: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'converge-precommit-'));

  // Copy the real gate script + deps into the fixture, preserving layout so the
  // script's relative imports + ROOT resolution land inside the fixture.
  for (const rel of COPY_FILES) {
    const src = path.join(REPO_ROOT, rel);
    const dest = path.join(repo, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  git(repo, ['init', '-q', '-b', 'main']);
  // A non-fix branch so the causal-autopsy advisory stays quiet (it never blocks
  // anyway, but keeps the gate output clean).
  git(repo, ['checkout', '-q', '-b', 'feature/converge-test']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'scaffold gate + deps']);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

/** Lay out a converged + approved spec, its ELI16 companion, a side-effects
 * artifact, a fresh complete trace, and a staged in-scope source file. Returns
 * the report-file path so a test can create/omit it. */
function stageConvergedChange(): { reportRel: string } {
  const slug = 'fixture-feature';
  const specRel = `docs/specs/${slug}.md`;
  const eli16Rel = `docs/specs/${slug}.eli16.md`;
  const artifactRel = `upgrades/side-effects/${slug}.md`;
  const reportRel = `docs/specs/reports/${slug}-convergence.md`;
  const sourceRel = 'src/FixtureFeature.ts';

  // Canonical converging-audit format: timestamp STRING tag (not boolean true).
  const specBody =
    `---\n` +
    `title: Fixture Feature\n` +
    `slug: ${slug}\n` +
    `parent-principle: "${PARENT_PRINCIPLE}"\n` +
    `review-convergence: "2026-06-10T18:10:05Z"\n` +
    `cross-model-review: "codex-cli:gpt-5.5"\n` +
    `approved: true\n` +
    `approved-by: Justin\n` +
    `approved-date: 2026-06-10\n` +
    `---\n\n# Fixture Feature\n\nA complete feature with no deferrals.\n`;
  writeFixture(specRel, specBody);

  // ELI16 ≥ 800 chars of trimmed content.
  writeFixture(eli16Rel, '# Fixture Feature — plain English\n\n' + 'This change adds a small fixture feature. '.repeat(40) + '\n');

  // Side-effects artifact ≥ 200 chars.
  writeFixture(artifactRel, '# Side effects\n\n' + 'No external side effects; this is a pure in-repo fixture used only by a test. '.repeat(6) + '\n');

  // The in-scope source file.
  writeFixture(sourceRel, 'export const fixtureFeature = () => 42;\n');

  // Compute the artifact sha for the trace.
  const artifactSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, artifactRel), 'utf8')).digest('hex');

  // Fresh, complete trace (mtime is now → within the 60-min window).
  const trace = {
    phase: 'complete',
    slug,
    coveredFiles: [sourceRel],
    artifactPath: artifactRel,
    sideEffectsPath: artifactRel,
    artifactSha256: artifactSha,
    specPath: specRel,
    createdAt: new Date().toISOString(),
  };
  writeFixture(`.instar/instar-dev-traces/${slug}.json`, JSON.stringify(trace, null, 2) + '\n');

  // Stage everything EXCEPT the report (tests control the report's presence).
  git(repo, ['add', specRel, eli16Rel, artifactRel, sourceRel, `.instar/instar-dev-traces/${slug}.json`]);

  return { reportRel };
}

function writeFixture(rel: string, content: string): void {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Run the copied real precommit; return { code, out }. The gate writes its
 * diagnostics to STDERR (both on pass and block), so we MERGE stderr into stdout
 * (`2>&1`) to capture the success-path "OK …" line too — execFileSync otherwise
 * returns only stdout on a clean exit. */
function runPrecommit(env: Record<string, string> = {}): { code: number; out: string } {
  const childEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    ...env,
  };
  try {
    const out = execFileSync(
      'sh',
      ['-c', 'node "$0" 2>&1', path.join(repo, 'scripts/instar-dev-precommit.js')],
      { cwd: repo, encoding: 'utf8', env: childEnv },
    );
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stderr?: string; stdout?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('E2E: instar-dev-precommit report-backing (Report-Backed Converging Audit)', () => {
  it('env UNSET: a timestamp-tagged + approved spec with NO report COMMITS cleanly (byte-identical to today)', () => {
    stageConvergedChange();
    // No report file on disk; env is unset.
    const r = runPrecommit();
    expect(r.code).toBe(0);
    expect(r.out).toContain('OK');
    // The default path must NOT mention the report requirement at all.
    expect(r.out).not.toContain('report-backed');
    expect(r.out).not.toContain('converging-audit\nreport is missing');
  });

  it('env=1, NO report: the SAME commit is BLOCKED for the missing report', () => {
    stageConvergedChange(); // report deliberately not created
    const r = runPrecommit({ INSTAR_DEV_REQUIRE_CONVERGENCE_REPORT: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('converging-audit');
    expect(r.out).toContain('report is missing');
    expect(r.out).toContain('fixture-feature-convergence.md');
  });

  it('env=1, report PRESENT: the commit succeeds again', () => {
    const { reportRel } = stageConvergedChange();
    writeFixture(reportRel, '# Convergence report\n\n' + 'Round 1 converged. '.repeat(20) + '\n');
    git(repo, ['add', reportRel]);
    const r = runPrecommit({ INSTAR_DEV_REQUIRE_CONVERGENCE_REPORT: '1' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('OK');
    expect(r.out).toContain('report-backed');
  });

  it('Part D: the success diagnostic surfaces the cross-model-review value (observe-only)', () => {
    stageConvergedChange();
    const r = runPrecommit();
    expect(r.code).toBe(0);
    expect(r.out).toContain('cross-model: codex-cli:gpt-5.5');
  });

  it('env=1 but spec NOT converged: still blocks on the convergence tag (not the report) — same as today', () => {
    // Replace the spec with one that has NO convergence tag.
    const slug = 'fixture-feature';
    const specRel = `docs/specs/${slug}.md`;
    writeFixture(
      specRel,
      `---\ntitle: Fixture Feature\nslug: ${slug}\nparent-principle: "${PARENT_PRINCIPLE}"\napproved: true\napproved-by: Justin\napproved-date: 2026-06-10\n---\n\n# body\n`,
    );
    stageConvergedChangeReusing(specRel);
    const r = runPrecommit({ INSTAR_DEV_REQUIRE_CONVERGENCE_REPORT: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('not tagged review-convergence');
  });
});

/** Variant of stageConvergedChange that keeps a caller-written spec but stages
 * the rest of the support files + trace. */
function stageConvergedChangeReusing(specRel: string): void {
  const slug = 'fixture-feature';
  const eli16Rel = `docs/specs/${slug}.eli16.md`;
  const artifactRel = `upgrades/side-effects/${slug}.md`;
  const sourceRel = 'src/FixtureFeature.ts';

  writeFixture(eli16Rel, '# Fixture Feature — plain English\n\n' + 'This change adds a small fixture feature. '.repeat(40) + '\n');
  writeFixture(artifactRel, '# Side effects\n\n' + 'No external side effects; this is a pure in-repo fixture used only by a test. '.repeat(6) + '\n');
  writeFixture(sourceRel, 'export const fixtureFeature = () => 42;\n');

  const artifactSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, artifactRel), 'utf8')).digest('hex');

  const trace = {
    phase: 'complete',
    slug,
    coveredFiles: [sourceRel],
    artifactPath: artifactRel,
    sideEffectsPath: artifactRel,
    artifactSha256: artifactSha,
    specPath: specRel,
    createdAt: new Date().toISOString(),
  };
  writeFixture(`.instar/instar-dev-traces/${slug}.json`, JSON.stringify(trace, null, 2) + '\n');
  git(repo, ['add', specRel, eli16Rel, artifactRel, sourceRel, `.instar/instar-dev-traces/${slug}.json`]);
}
