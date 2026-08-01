/**
 * CI ratchet (audit-convergence-enforcement §3) — the merged-state backstop for
 * the client-side precommit gate. Runs the validator's `--check` logic over EVERY
 * committed `docs/audits/**\/*.md` claiming `converged:`, and enforces the
 * canonical-path-only rule over every committed `docs/**\/*.md`. Catches a stamp
 * that slipped a local `--no-verify`, a stale worktree, or a GitHub web edit.
 *
 * Grandfathering: pre-gate stamped reports are pinned by FULL repo-relative path
 * in GRANDFATHERED_AUDIT_SLUGS (extended only by PR — adversarial-R4 minor: a
 * slug-only key would over-exempt a same-slug file in a subdir). The two existing
 * docs/audits/ reports carry no YAML frontmatter, so a `converged:`-keyed check
 * ignores them untouched — no allowlist entry needed for them.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { validateAuditReport, parseFrontmatter, responseChangedFromBase, stampConverged } from '../../scripts/write-audit-convergence.mjs';
import { articleIds, parseRegistryStructure } from '../../scripts/standards-registry-article-core.mjs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

// Full repo-relative paths of pre-gate stamped reports. Extend ONLY by PR.
const GRANDFATHERED_AUDIT_SLUGS: string[] = [];

function committedDocsMd(): string[] {
  const out = execFileSync('git', ['ls-files', 'docs/**/*.md'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}
function trackedSet(): Set<string> {
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
}
function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}
function frontmatterKey(content: string, key: string): string | undefined {
  try { return parseFrontmatter(content).fields[key]; } catch { return undefined; }
}
function gitShow(sha: string, rel: string, root = ROOT): string | null {
  try { return execFileSync('git', ['show', `${sha}:${rel}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
}
function gitFileMode(sha: string, rel: string, root = ROOT): string | null {
  try {
    const row = execFileSync('git', ['ls-tree', sha, '--', rel], { cwd: root, encoding: 'utf8' }).trim();
    return row ? row.split(/\s+/, 1)[0] : null;
  } catch { return null; }
}
function changeContext(env: NodeJS.ProcessEnv = process.env, root = ROOT): { base: string; head: string } | null {
  const kind = env.AUDIT_CHANGE_KIND;
  const baseInput = env.AUDIT_CHANGE_BASE_SHA;
  const head = env.AUDIT_CHANGE_HEAD_SHA;
  if (!kind && !baseInput && !head) return null;
  if (!kind || !baseInput || !head) throw new Error('audit change context is partial; kind/base/head are all required');
  execFileSync('git', ['cat-file', '-e', `${baseInput}^{commit}`], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['cat-file', '-e', `${head}^{commit}`], { cwd: root, stdio: 'ignore' });
  const base = kind === 'pull_request'
    ? execFileSync('git', ['merge-base', baseInput, head], { cwd: root, encoding: 'utf8' }).trim()
    : baseInput;
  return { base, head };
}

describe('audit-convergence CI ratchet', () => {
  it('every committed docs/audits/ report claiming converged actually validates', () => {
    const tracked = trackedSet();
    const reports = committedDocsMd().filter((f) => /^docs\/audits\/.+\.md$/.test(f));
    const failures: string[] = [];
    const change = changeContext();
    for (const f of reports) {
      if (GRANDFATHERED_AUDIT_SLUGS.includes(f)) continue;
      const content = change ? gitShow(change.head, f) : read(f);
      if (!content) continue;
      if (!frontmatterKey(content, 'converged')) continue; // honestly-incomplete → skip
      const baseReport = change ? gitShow(change.base, f) : content;
      const responseChanged = change ? responseChangedFromBase(content, baseReport) : false;
      const fields = parseFrontmatter(content).fields;
      const standardsRef = fields['standard-response-ref'];
      const candidateMode = responseChanged && standardsRef ? gitFileMode(change!.head, standardsRef) : null;
      const baseMode = responseChanged && standardsRef ? gitFileMode(change!.base, standardsRef) : null;
      const r = validateAuditReport(content, {
        root: ROOT,
        stagedSet: tracked,
        basenameSlug: path.basename(f, '.md'),
        requiredStandardsRef: 'docs/STANDARDS-REGISTRY.md',
        standardEvidence: responseChanged ? {
          responseChanged: true,
          candidateText: standardsRef ? gitShow(change!.head, standardsRef) ?? '' : '',
          baseText: standardsRef ? gitShow(change!.base, standardsRef) ?? '' : '',
          candidateRegular: candidateMode === '100644' || candidateMode === '100755',
          candidateTracked: candidateMode !== null,
          baseRegular: baseMode === '100644' || baseMode === '100755',
          baseTracked: baseMode !== null,
        } : { responseChanged: false },
      });
      if (!r.ok) failures.push(`${f}: ${r.reason}`);
    }
    expect(failures, `unearned converged stamps:\n${failures.join('\n')}`).toEqual([]);
  });

  it('derives PR merge-base, push range, and exact Git tree file modes in a synthetic repository', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-change-context-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    try {
      git('init', '-q');
      git('config', 'user.email', 'audit@example.test');
      git('config', 'user.name', 'audit-test');
      fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'docs', 'STANDARDS.md'), 'base\n');
      git('add', '.');
      git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');
      git('checkout', '-qb', 'feature');
      fs.writeFileSync(path.join(repo, 'docs', 'STANDARDS.md'), 'feature\n');
      git('commit', '-qam', 'feature');
      const feature = git('rev-parse', 'HEAD');
      git('checkout', '-q', 'main');
      git('reset', '--hard', '-q', base);
      fs.writeFileSync(path.join(repo, 'main-only.txt'), 'advanced\n');
      git('add', '.');
      git('commit', '-qm', 'advanced base');
      const advancedBase = git('rev-parse', 'HEAD');

      expect(changeContext({ AUDIT_CHANGE_KIND: 'pull_request', AUDIT_CHANGE_BASE_SHA: advancedBase, AUDIT_CHANGE_HEAD_SHA: feature }, repo)).toEqual({ base, head: feature });
      expect(changeContext({ AUDIT_CHANGE_KIND: 'push', AUDIT_CHANGE_BASE_SHA: base, AUDIT_CHANGE_HEAD_SHA: feature }, repo)).toEqual({ base, head: feature });
      expect(changeContext({ AUDIT_CHANGE_KIND: '', AUDIT_CHANGE_BASE_SHA: '', AUDIT_CHANGE_HEAD_SHA: '' }, repo)).toBeNull();
      expect(gitFileMode(feature, 'docs/STANDARDS.md', repo)).toBe('100644');

      git('checkout', '-q', 'feature');
      fs.unlinkSync(path.join(repo, 'docs', 'STANDARDS.md'));
      fs.symlinkSync('../main-only.txt', path.join(repo, 'docs', 'STANDARDS.md'));
      git('add', 'docs/STANDARDS.md');
      git('commit', '-qm', 'symlink candidate');
      expect(gitFileMode(git('rev-parse', 'HEAD'), 'docs/STANDARDS.md', repo)).toBe('120000');
    } finally {
      SafeFsExecutor.safeRmSync(repo, { recursive: true, force: true, operation: 'audit-convergence-reports.test.ts:synthetic-repo-cleanup' });
    }
  });

  it('accepts a multi-commit push range but refuses a later response-only PR borrowing its registry delta', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-range-lifecycle-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    const standardsRel = 'docs/STANDARDS-REGISTRY.md';
    const auditRel = 'docs/audits/range-lifecycle.md';
    const registry = (meaning: string) => `## Governance\n\n### Existing Rule\n\n**Article ID.** \`existing-rule\`\n\n**Rule.** ${meaning}\n\n### Second Rule\n\n**Article ID.** \`second-rule\`\n\n**Rule.** Unchanged second meaning.\n`;
    const unstampedAudit = (rationale: string) => `---
audit: "range-lifecycle"
converged: ""
exemption: "non-ci-expressible — semantic adequacy remains an ordinary reviewer judgment"
blind-spot-class: "range-evidence-reuse"
standard-response-kind: "amended"
standard-response-ref: "${standardsRel}"
standard-response-article-id: "existing-rule"
standard-response-article: "Existing Rule"
standard-response-rationale: "${rationale}"
---

# Range lifecycle

## Meta-insight

How it arose: The audit response and its standards amendment can legitimately land in separate commits within one push range.
Why prior controls missed it: A response-only later change could otherwise borrow an older registry delta without change-local corroboration.

## Round 1
Search angles: inspected the complete synthetic commit range and exact registry block.
Surface delta: one audit report and one standards article.

| location | behavior | bucket | disposition |
|----------|----------|--------|-------------|
| docs/STANDARDS-REGISTRY.md | amended rule | provenance | fixed:synthetic-range |

New findings this round: 1

## Round 2
Search angles: revalidated the head snapshot against its range base.
Surface delta: unchanged from Round 1.

New findings this round: 0
`;
    const validateRange = (base: string, head: string) => {
      const content = gitShow(head, auditRel, repo)!;
      const baseReport = gitShow(base, auditRel, repo);
      const responseChanged = responseChangedFromBase(content, baseReport);
      const candidateMode = gitFileMode(head, standardsRel, repo);
      const baseMode = gitFileMode(base, standardsRel, repo);
      return validateAuditReport(content, {
        root: repo,
        basenameSlug: 'range-lifecycle',
        requiredStandardsRef: standardsRel,
        standardEvidence: {
          responseChanged,
          candidateText: gitShow(head, standardsRel, repo) ?? '',
          baseText: gitShow(base, standardsRel, repo) ?? '',
          candidateRegular: candidateMode === '100644' || candidateMode === '100755',
          candidateTracked: candidateMode !== null,
          baseRegular: baseMode === '100644' || baseMode === '100755',
          baseTracked: baseMode !== null,
        },
      });
    };

    try {
      git('init', '-q');
      git('config', 'user.email', 'audit@example.test');
      git('config', 'user.name', 'audit-test');
      fs.mkdirSync(path.join(repo, 'docs', 'audits'), { recursive: true });
      fs.writeFileSync(path.join(repo, standardsRel), registry('Original meaning.'));
      git('add', '.');
      git('commit', '-qm', 'base registry');
      const rangeBase = git('rev-parse', 'HEAD');

      fs.writeFileSync(path.join(repo, standardsRel), registry('Amended constitutional meaning.'));
      git('commit', '-qam', 'amend registry');
      fs.writeFileSync(
        path.join(repo, auditRel),
        stampConverged(unstampedAudit('The article needed a substantive amendment discovered by this audit.'), 2, '2026-07-31T20:00:00.000Z'),
      );
      git('add', auditRel);
      git('commit', '-qm', 'add converged audit');
      const multiCommitHead = git('rev-parse', 'HEAD');
      const push = changeContext({ AUDIT_CHANGE_KIND: 'push', AUDIT_CHANGE_BASE_SHA: rangeBase, AUDIT_CHANGE_HEAD_SHA: multiCommitHead }, repo)!;
      const pushed = validateRange(push.base, push.head);
      expect(pushed, pushed.reason).toMatchObject({ ok: true, responseKind: 'amended' });

      const current = fs.readFileSync(path.join(repo, auditRel), 'utf8');
      const responseOnly = current
        .replace('standard-response-article-id: "existing-rule"', 'standard-response-article-id: "second-rule"')
        .replace('standard-response-article: "Existing Rule"', 'standard-response-article: "Second Rule"')
        .replace(
          'The article needed a substantive amendment discovered by this audit.',
          'This rewritten response tries to borrow the older delta for a different article.',
        );
      expect(responseOnly).not.toBe(current);
      const responseOnlyStamped = stampConverged(responseOnly, 2, '2026-07-31T21:00:00.000Z');
      expect(responseChangedFromBase(responseOnlyStamped, current)).toBe(true);
      fs.writeFileSync(path.join(repo, auditRel), responseOnlyStamped);
      git('commit', '-qam', 'response-only rewrite');
      const responseOnlyHead = git('rev-parse', 'HEAD');
      const pr = changeContext({ AUDIT_CHANGE_KIND: 'pull_request', AUDIT_CHANGE_BASE_SHA: multiCommitHead, AUDIT_CHANGE_HEAD_SHA: responseOnlyHead }, repo)!;
      const borrowed = validateRange(pr.base, pr.head);
      expect(borrowed.ok).toBe(false);
      expect(borrowed.reason).toMatch(/amended requires a substantive article-block delta/);
    } finally {
      SafeFsExecutor.safeRmSync(repo, { recursive: true, force: true, operation: 'audit-convergence-reports.test.ts:range-lifecycle-cleanup' });
    }
  });

  it('inventories standard responses by blind-spot class and warns on repeated no-change or stale current references', () => {
    const reports = committedDocsMd().filter((f) => /^docs\/audits\/.+\.md$/.test(f));
    const inventory = new Map<string, { created: number; amended: number; 'no-change': number }>();
    const warnings: string[] = [];

    for (const f of reports) {
      const content = read(f);
      if (!frontmatterKey(content, 'converged')) continue;
      const fields = parseFrontmatter(content).fields;
      const blindSpot = fields['blind-spot-class'];
      const kind = fields['standard-response-kind'] as 'created' | 'amended' | 'no-change';
      if (!blindSpot || !['created', 'amended', 'no-change'].includes(kind)) continue;
      const counts = inventory.get(blindSpot) ?? { created: 0, amended: 0, 'no-change': 0 };
      counts[kind]++;
      inventory.set(blindSpot, counts);

      const ref = fields['standard-response-ref'];
      const articleId = fields['standard-response-article-id'];
      const title = fields['standard-response-article'];
      const refPath = ref ? path.join(ROOT, ref) : '';
      let resolves = false;
      if (ref && fs.existsSync(refPath) && fs.lstatSync(refPath).isFile()) {
        const matches = parseRegistryStructure(read(ref))
          .flatMap((section) => section.blocks)
          .filter((block) => block.name === title && articleIds(block).includes(articleId));
        resolves = matches.length === 1;
      }
      if (!resolves) warnings.push(`${f}: frozen standards ref/title/id no longer resolves in current HEAD`);
    }

    for (const [blindSpot, counts] of [...inventory].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`[audit-meta-inventory] ${blindSpot}: created=${counts.created} amended=${counts.amended} no-change=${counts['no-change']}`);
      if (counts['no-change'] >= 2) {
        warnings.push(`${blindSpot}: ${counts['no-change']} no-change reports — is the standard adequate but enforcement repeatedly absent?`);
      }
    }
    for (const warning of warnings) console.warn(`[audit-meta-inventory] WARNING — ${warning}`);
    expect(inventory.size).toBeGreaterThan(0);
  });

  it('no committed docs/**/*.md OUTSIDE docs/audits/ carries an audit: frontmatter key (canonical-path-only)', () => {
    const rogue = committedDocsMd()
      .filter((f) => !/^docs\/audits\//.test(f))
      .filter((f) => !!frontmatterKey(read(f), 'audit'));
    expect(rogue, `audit reports must live under docs/audits/:\n${rogue.join('\n')}`).toEqual([]);
  });
});
