/**
 * Unit tests — release-relevant-paths.mjs (the shared "needs a release note?"
 * predicate consumed by the Layer-1 PR gate and the local pre-push gate).
 *
 * This predicate is the single point that decides whether the release-fragment
 * gate applies at all. A false EXEMPT re-opens the 2026-06-27 silent-skip; a
 * false RELEVANT blocks a legit PR. So both sides AND adversarial evasion cases
 * are covered, plus the anti-drift ownership guard.
 */

import { describe, it, expect } from 'vitest';
import {
  isReleaseRelevant,
  classifyPaths,
  canonicalizePath,
  shippedTopLevelRoots,
} from '../../scripts/release-relevant-paths.mjs';

describe('isReleaseRelevant — positive (release-relevant) roots', () => {
  for (const p of [
    'src/foo.ts',
    'src/monitoring/ReleaseReadinessSentinel.ts',
    'scripts/check-release-fragment.mjs',
    '.husky/pre-push',
    'package.json',
    'package-lock.json',
    '.github/workflows/publish.yml',
    'skills/build/SKILL.md',
    'skills/foo/run.mjs',
    'skills/foo/helper.sh',
    'skills/foo/helper.cjs', // broadened: .cjs is not silently exempt
    'skills/foo/run.py',
    'skills/foo/templates/thing.md',
    // SHIPPED .claude paths (package.json `files`) — behavior that reaches the fleet.
    '.claude/hooks/before-prompt-recall.js',
    '.claude/hooks/instar/some-hook.sh',
    '.claude/skills/build/SKILL.md',
    '.claude/skills/autonomous/run.mjs',
  ]) {
    it(`relevant: ${p}`, () => expect(isReleaseRelevant(p)).toBe(true));
  }
});

describe('isReleaseRelevant — exempt (no release note needed)', () => {
  for (const p of [
    'src/foo.test.ts',
    'tests/unit/whatever.test.ts',
    'tests/fixtures/x.json',
    'docs/specs/SOME-SPEC.md',
    'docs/foo.md',
    'README.md',
    'upgrades/next/foo.md', // the fragment itself is not "release-relevant work"
    'upgrades/NEXT.md',
    '.instar/config.json',
    '.github/ISSUE_TEMPLATE/bug.md',
    'skills/foo/notes.md', // a stray skill doc, not SKILL.md / templates
    '.claude/skills/notes.md', // a non-SKILL.md doc under a skill
    '.claude/skills/some-local-skill/SKILL.md', // NOT one of the shipped skills → agent-local, exempt
    '.claude/settings.json', // agent-local config, not shipped behavior gated here
    'assets/logo.png',
    'examples/demo.ts',
    'site/index.html',
  ]) {
    it(`exempt: ${p}`, () => expect(isReleaseRelevant(p)).toBe(false));
  }
});

describe('isReleaseRelevant — adversarial evasion (must NOT silently exempt)', () => {
  it('case-folded src is still relevant', () => {
    expect(isReleaseRelevant('Src/Foo.TS')).toBe(true);
    expect(isReleaseRelevant('SRC/bar.ts')).toBe(true);
  });
  it('leading ./ is normalized', () => {
    expect(isReleaseRelevant('./src/foo.ts')).toBe(true);
  });
  it('trailing slash does not evade', () => {
    expect(isReleaseRelevant('src/foo.ts/')).toBe(true);
  });
  it('a `..` traversal path biases toward relevant (safe direction)', () => {
    expect(isReleaseRelevant('src/../src/evil.ts')).toBe(true);
    expect(isReleaseRelevant('../escape.ts')).toBe(true);
  });
  it('a runtime file shaped like a test path is NOT exempted just for "test" in the name', () => {
    // Only a real *.test.* suffix is exempt; "src/testing/harness.ts" ships behavior.
    expect(isReleaseRelevant('src/testing/harness.ts')).toBe(true);
  });
  it('empty / junk input is exempt, not a throw', () => {
    expect(isReleaseRelevant('')).toBe(false);
    expect(isReleaseRelevant('   ')).toBe(false);
    // @ts-expect-error intentional bad input
    expect(isReleaseRelevant(null)).toBe(false);
  });
});

describe('canonicalizePath', () => {
  it('flags traversal', () => {
    expect(canonicalizePath('src/../x.ts')).toEqual({ escaped: true, path: 'src/../x.ts' });
  });
  it('normalizes separators + leading ./', () => {
    expect(canonicalizePath('./a//b')).toEqual({ escaped: false, path: 'a/b' });
  });
  it('returns null for empty', () => {
    expect(canonicalizePath('')).toBeNull();
    expect(canonicalizePath('   ')).toBeNull();
  });
});

describe('classifyPaths', () => {
  it('splits a mixed list', () => {
    const { relevant, exempt } = classifyPaths([
      'src/a.ts',
      'docs/b.md',
      'scripts/c.mjs',
      'src/a.test.ts',
    ]);
    expect(relevant.sort()).toEqual(['scripts/c.mjs', 'src/a.ts']);
    expect(exempt.sort()).toEqual(['docs/b.md', 'src/a.test.ts']);
  });
});

describe('anti-drift ownership guard (D6)', () => {
  // The CURRENT shipped top-level roots from package.json `files`. Each must be
  // explicitly classifiable by the predicate. If a NEW shipped root appears that
  // the predicate doesn't classify as relevant-or-exempt deterministically, this
  // test fails — forcing the author to classify it rather than let it silently
  // fall through as a false-negative.
  it('every shipped top-level root is explicitly classified', () => {
    // Mirror of package.json `files` top-levels at authoring time.
    const filesWhitelist = [
      'dist', 'dashboard', 'upgrades', 'src/templates', 'src/data',
      'src/threadline/data', 'skills', 'playbook-scripts', 'scripts',
      '.claude/skills/setup-wizard', '.claude/skills/secret-setup',
      '.claude/skills/autonomous', '.claude/skills/build', '.claude/hooks', 'src/scaffold',
    ];
    const roots = shippedTopLevelRoots(filesWhitelist);
    // Known classification of each shipped root (relevant unless documented exempt).
    const KNOWN: Record<string, 'relevant' | 'exempt'> = {
      dist: 'exempt',       // build output, never hand-edited
      dashboard: 'exempt',  // static assets; behavior changes ride src/
      upgrades: 'exempt',   // the release-notes machinery itself
      src: 'relevant',
      skills: 'relevant',
      'playbook-scripts': 'exempt', // data scripts, no runtime gate surface
      scripts: 'relevant',
      '.claude': 'relevant', // .claude/hooks/** + shipped .claude/skills/<name>/ are release-relevant
    };
    for (const root of roots) {
      expect(KNOWN[root], `shipped root "${root}" is unclassified — classify it in release-relevant-paths + here`).toBeDefined();
    }
  });
});
