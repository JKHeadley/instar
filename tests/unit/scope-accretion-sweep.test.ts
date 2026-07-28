// safe-git-allow: test-tmpdir-cleanup — afterEach removes per-test mkdtempSync tmpdir.
/**
 * ScopeAccretionSweep — Tier 1 (spec: autonomous-scope-accretion-completion.md
 * §2.2 R31/R41/R42/R48 + §2.4 R20).
 *
 * Covers: the class globs (deliverable/companion/scratch/out-of-allowlist);
 * the R42 porcelain mapping fed byte-for-byte captured REAL `git status
 * --porcelain` output; the declared-deliverable grammar fed REAL registered
 * completion-condition texts (incl. the pathless incident shape → EMPTY set);
 * the R17 deleted-flag; the 200-path clamp; R48 shared-vs-run-owned committed
 * arms; computeUnbuiltSet subtraction.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  classifyArtifactPath,
  companionParentPath,
  parseDeclaredDeliverables,
  parsePorcelainStatus,
  runAccretionSweep,
  computeUnbuiltSet,
  type SweepDeps,
} from '../../src/core/ScopeAccretionSweep.js';
import type { AutonomousRunRecord } from '../../src/core/AutonomousRunStore.js';
import { loadCapturedFixture } from '../helpers/loadCapturedFixture.js';

function record(overrides: Partial<AutonomousRunRecord> = {}): AutonomousRunRecord {
  return {
    runId: 'run-test-1',
    topicId: '9984',
    condition: 'do the thing',
    declaredDeliverables: [],
    workDir: '/repo/work',
    startedAt: '2026-07-01T00:00:00Z',
    endAt: '2026-07-03T00:00:00Z',
    registeredAt: '2026-07-01T00:00:00Z',
    scopeAccretion: { enabled: true, breakerK: 3 },
    baseRoots: [{ root: '/repo/work', startSha: 'aaaa111', shared: false }],
    worktreeFirstSeen: {},
    status: 'active',
    corroborated: {},
    negativeCache: {},
    ratifiedArtifacts: [],
    ratifications: [],
    enumerations: [],
    triggers: [],
    breaker: { accretedSetHash: '', firstSeenAt: '', consecutiveHolds: 0, lastProgressAt: '', clearedCount: 0, tripped: false },
    lastUnbuilt: [],
    ...overrides,
  };
}

describe('classifyArtifactPath (R20 class globs — glob-only, deterministic)', () => {
  it('deliverable classes', () => {
    expect(classifyArtifactPath('docs/specs/foo-bar.md')).toBe('deliverable');
    expect(classifyArtifactPath('docs/audits/mesh-audit.md')).toBe('deliverable');
    expect(classifyArtifactPath('docs/incidents/2026-07-02-outage.md')).toBe('deliverable');
    expect(classifyArtifactPath('docs/ops/restore-runbook.md')).toBe('deliverable');
    expect(classifyArtifactPath('scripts/check-thing.mjs')).toBe('deliverable');
  });
  it('companion is tied to its parent spec path', () => {
    expect(classifyArtifactPath('docs/specs/foo-bar.eli16.md')).toBe('companion');
    expect(companionParentPath('docs/specs/foo-bar.eli16.md')).toBe('docs/specs/foo-bar.md');
  });
  it('scratch conventions never block', () => {
    expect(classifyArtifactPath('tmp/spike.md')).toBe('scratch');
    expect(classifyArtifactPath('work/tmp/notes.md')).toBe('scratch');
  });
  it('out-of-allowlist docs are advisory, non-artifact paths are null', () => {
    expect(classifyArtifactPath('docs/notes/random.md')).toBe('out-of-allowlist-doc');
    expect(classifyArtifactPath('STRAY.md')).toBe('out-of-allowlist-doc');
    expect(classifyArtifactPath('src/core/Foo.ts')).toBe(null);
  });
});

describe('parseDeclaredDeliverables (R20 grammar) — captured REAL condition texts', () => {
  it('a REAL pathless condition text declares NOTHING', () => {
    // The motivating incident shape: a long "draft/produce artifacts" condition
    // with no deliverable-glob path token (spec §2.4 — drafting was the
    // abandonment, so drafts are held unless declared or ratified).
    const cond = loadCapturedFixture('scope-accretion-condition-texts', 'condition-pathless-draft-shape');
    expect(parseDeclaredDeliverables(cond)).toEqual([]);
    // A second REAL condition whose path tokens (research/…/HANDOFF.md) do NOT
    // match the deliverable globs — still declares nothing.
    const cond2 = loadCapturedFixture('scope-accretion-condition-texts', 'condition-artifact-paths');
    expect(parseDeclaredDeliverables(cond2)).toEqual([]);
    // A REAL condition mentioning docs/specs/ as a bare directory (no file token).
    const cond3 = loadCapturedFixture('scope-accretion-condition-texts', 'condition-specs-dir-mention');
    expect(parseDeclaredDeliverables(cond3)).toEqual([]);
  });

  it('extracts deliverable-glob path tokens and unions the explicit list', () => {
    const declared = parseDeclaredDeliverables(
      'Ship docs/specs/my-feature.md and scripts/check-it.sh; also touch src/core/x.ts and notes.txt',
      ['docs/audits/extra.md'],
    );
    expect(declared).toContain('docs/specs/my-feature.md');
    expect(declared).toContain('scripts/check-it.sh');
    expect(declared).toContain('docs/audits/extra.md');
    expect(declared).not.toContain('src/core/x.ts');
  });
});

describe('parsePorcelainStatus (R42 mapping) — captured REAL porcelain output', () => {
  it('maps REAL git status --porcelain output per the R42 mapping', () => {
    const porcelain = loadCapturedFixture('scope-accretion-git-porcelain', 'status-porcelain');
    const entries = parsePorcelainStatus(porcelain);
    const byPath = new Map(entries.map((e) => [e.path, e]));
    // ?? untracked and A/M = present
    expect(byPath.get('docs/specs/brand-new.md')).toMatchObject({ present: true, deleted: false });
    expect(byPath.get('docs/audits/added.md')).toMatchObject({ present: true, deleted: false });
    expect(byPath.get('docs/specs/keep-me.md')).toMatchObject({ present: true, deleted: false });
    // R = NEW path present, old path deleted
    expect(byPath.get('docs/specs/new-name.md')).toMatchObject({ present: true, deleted: false });
    expect(byPath.get('docs/specs/old-name.md')).toMatchObject({ deleted: true });
    // D = deleted (feeds R17), never silently reclassified
    expect(byPath.get('docs/specs/delete-me.md')).toMatchObject({ deleted: true });
  });

  it('ignored (!!) entries are not swept', () => {
    const entries = parsePorcelainStatus('!! node_modules/\n?? docs/specs/x.md\n');
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe('docs/specs/x.md');
  });
});

// ── The sweep over injected git output (read-only funnel shape) ────────────

function sweepDeps(gitByCall: Record<string, string>, overrides: Partial<SweepDeps> = {}): SweepDeps {
  return {
    readGit: (args: string[], cwd: string) => {
      const key = `${args[0]}:${path.resolve(cwd)}`;
      if (key in gitByCall) return gitByCall[key];
      if (args[0] in gitByCall) return gitByCall[args[0]];
      return '';
    },
    ...overrides,
  };
}

describe('runAccretionSweep (R31/R41/R48)', () => {
  it('run-owned root uses the all-branches arm; shared root is HEAD-only (R48)', () => {
    const calls: string[][] = [];
    const rec = record({
      baseRoots: [
        { root: '/repo/work', startSha: 'aaaa111', shared: false },
        { root: '/repo/home', startSha: 'bbbb222', shared: true },
      ],
    });
    runAccretionSweep(rec, {
      readGit: (args: string[], cwd: string) => {
        calls.push([cwd, ...args]);
        return '';
      },
    });
    const workLog = calls.find((c) => c[0] === '/repo/work' && c[1] === 'log');
    const homeLog = calls.find((c) => c[0] === '/repo/home' && c[1] === 'log');
    expect(workLog).toBeDefined();
    expect(workLog).toContain('--branches');
    expect(workLog).toContain('--not');
    expect(workLog).toContain('aaaa111');
    expect(homeLog).toBeDefined();
    expect(homeLog!.join(' ')).toContain('bbbb222..HEAD');
    expect(homeLog).not.toContain('--branches');
    // SHA-anchored, never --since (backdated commit dates are author-settable).
    expect(calls.every((c) => !c.some((a) => a.startsWith('--since')))).toBe(true);
  });

  it('classifies committed + porcelain artifacts; committed-then-missing gets deleted:true (R17)', () => {
    const rec = record();
    const res = runAccretionSweep(rec, sweepDeps({
      log: 'docs/specs/created-then-deleted.md\nsrc/core/Ignored.ts\n',
      status: '?? docs/specs/still-here.md\n',
      worktree: '',
    }));
    const byPath = new Map(res.artifacts.map((a) => [a.path, a]));
    // Committed spec no longer on disk (tmp root does not contain it) → deleted stays flagged.
    expect(byPath.get('docs/specs/created-then-deleted.md')).toMatchObject({ cls: 'deliverable', deleted: true, committed: true });
    expect(byPath.get('docs/specs/still-here.md')).toMatchObject({ cls: 'deliverable', committed: false });
    expect(byPath.has('src/core/Ignored.ts')).toBe(false);
  });

  it('out-of-allowlist docs set the advisory suspected flag without entering the set', () => {
    const res = runAccretionSweep(record(), sweepDeps({
      log: 'docs/notes/random.md\n',
      status: '',
      worktree: '',
    }));
    expect(res.suspected).toBe(true);
    expect(res.artifacts).toHaveLength(0);
  });

  it('an orphan companion (.eli16 with no swept parent) sets suspected; companions never block', () => {
    const res = runAccretionSweep(record(), sweepDeps({
      log: 'docs/specs/lonely.eli16.md\n',
      status: '',
      worktree: '',
    }));
    expect(res.suspected).toBe(true);
    const unbuilt = computeUnbuiltSet(res, [], [], {});
    expect(unbuilt).toHaveLength(0); // companion alone never blocks (§2.4)
  });

  it('clamps the artifact set to maxPaths and flags truncation', () => {
    const many = Array.from({ length: 300 }, (_, i) => `docs/specs/spec-${i}.md`).join('\n');
    const res = runAccretionSweep(record(), { ...sweepDeps({ log: many, status: '', worktree: '' }), maxPaths: 200 });
    expect(res.artifacts.length).toBeLessThanOrEqual(200);
    expect(res.truncated).toBe(true);
  });

  it('a git failure degrades (flag) instead of throwing — fail toward judge-only', () => {
    const res = runAccretionSweep(record(), {
      readGit: () => {
        throw new Error('git exploded');
      },
    });
    expect(res.degraded).toBe(true);
    expect(res.artifacts).toHaveLength(0);
  });

  it('scratch paths are ledgered but never block', () => {
    const res = runAccretionSweep(record(), sweepDeps({
      log: 'tmp/spike.md\n',
      status: '',
      worktree: '',
    }));
    const unbuilt = computeUnbuiltSet(res, [], [], {});
    expect(unbuilt).toHaveLength(0);
  });
});

describe('computeUnbuiltSet (§2.8 step 1-2 subtraction)', () => {
  it('subtracts declared, ratified, and corroborated deliverables', () => {
    const res = runAccretionSweep(record(), sweepDeps({
      log: 'docs/specs/a.md\ndocs/specs/b.md\ndocs/specs/c.md\ndocs/specs/d.md\n',
      status: '',
      worktree: '',
    }));
    const unbuilt = computeUnbuiltSet(
      res,
      ['docs/specs/a.md'],
      ['docs/specs/b.md'],
      { 'docs/specs/c.md': { by: 'merged-pr' } },
    );
    expect(unbuilt.map((a) => a.path)).toEqual(['docs/specs/d.md']);
  });

  it('a DELETED accreted deliverable stays in the unbuilt set (deletion is not an exit, R17)', () => {
    const res = runAccretionSweep(record(), sweepDeps({
      log: 'docs/specs/vanished.md\n',
      status: '',
      worktree: '',
    }));
    const unbuilt = computeUnbuiltSet(res, [], [], {});
    expect(unbuilt).toHaveLength(1);
    expect(unbuilt[0]).toMatchObject({ path: 'docs/specs/vanished.md', deleted: true });
  });
});
