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
import { execFileSync } from 'node:child_process';
import { validateAuditReport, parseFrontmatter } from '../../scripts/write-audit-convergence.mjs';

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

describe('audit-convergence CI ratchet', () => {
  it('every committed docs/audits/ report claiming converged actually validates', () => {
    const tracked = trackedSet();
    const reports = committedDocsMd().filter((f) => /^docs\/audits\/.+\.md$/.test(f));
    const failures: string[] = [];
    for (const f of reports) {
      if (GRANDFATHERED_AUDIT_SLUGS.includes(f)) continue;
      const content = read(f);
      if (!frontmatterKey(content, 'converged')) continue; // honestly-incomplete → skip
      const r = validateAuditReport(content, {
        root: ROOT,
        stagedSet: tracked,
        basenameSlug: path.basename(f, '.md'),
      });
      if (!r.ok) failures.push(`${f}: ${r.reason}`);
    }
    expect(failures, `unearned converged stamps:\n${failures.join('\n')}`).toEqual([]);
  });

  it('no committed docs/**/*.md OUTSIDE docs/audits/ carries an audit: frontmatter key (canonical-path-only)', () => {
    const rogue = committedDocsMd()
      .filter((f) => !/^docs\/audits\//.test(f))
      .filter((f) => !!frontmatterKey(read(f), 'audit'));
    expect(rogue, `audit reports must live under docs/audits/:\n${rogue.join('\n')}`).toEqual([]);
  });
});
