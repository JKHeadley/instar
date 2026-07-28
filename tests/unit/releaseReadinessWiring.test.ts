/**
 * Wiring-integrity tests — releaseReadinessWiring (Testing Integrity Standard).
 *
 * Proves the dependency factory builds REAL functions (not nulls/no-ops), that
 * the repo-gate and canonical-remote allow-list behave, and that state
 * round-trips. The sentinel's decision logic is covered separately in
 * ReleaseReadinessSentinel.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  buildReleaseReadinessDeps,
  isAnalyzableRepo,
  resolveCanonicalRemote,
  loadReadinessState,
  saveReadinessState,
  CANONICAL_REMOTE_RE,
} from '../../src/monitoring/releaseReadinessWiring.js';
import { ReleaseReadinessSentinel } from '../../src/monitoring/ReleaseReadinessSentinel.js';

describe('releaseReadinessWiring', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-wiring-')); });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/releaseReadinessWiring.test.ts:afterEach' });
  });

  it('canonical-remote allow-list matches the real upstream, rejects look-alikes', () => {
    expect(CANONICAL_REMOTE_RE.test('https://github.com/JKHeadley/instar.git')).toBe(true);
    expect(CANONICAL_REMOTE_RE.test('git@github.com:JKHeadley/instar')).toBe(true);
    // iter-3 V3: a look-alike host must NOT match.
    expect(CANONICAL_REMOTE_RE.test('git@evil.com:JKHeadley/instar.git')).toBe(false);
    expect(CANONICAL_REMOTE_RE.test('https://gitlab.com/JKHeadley/instar.git')).toBe(false);
  });

  it('isAnalyzableRepo is false for a non-instar / non-git dir', () => {
    expect(isAnalyzableRepo(tmpDir)).toBe(false);
    fs.mkdirSync(path.join(tmpDir, '.git'));
    expect(isAnalyzableRepo(tmpDir)).toBe(false); // still no scripts/analyze-release.js
  });

  it('isAnalyzableRepo is true for a dir with .git + scripts/analyze-release.js + package.json', () => {
    fs.mkdirSync(path.join(tmpDir, '.git'));
    fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'scripts', 'analyze-release.js'), '// x');
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    expect(isAnalyzableRepo(tmpDir)).toBe(true);
  });

  it('resolveCanonicalRemote flags a configured non-canonical remote as overridden', () => {
    SafeGitExecutor.run(['init', '-q'], { cwd: tmpDir, operation: 't:init' });
    SafeGitExecutor.run(['remote', 'add', 'origin', 'git@evil.com:JKHeadley/instar.git'], { cwd: tmpDir, operation: 't:remote' });
    const r = resolveCanonicalRemote(tmpDir, 'origin');
    expect(r.overridden).toBe(true);
  });

  it('resolveCanonicalRemote auto-detects the canonical remote without override', () => {
    SafeGitExecutor.run(['init', '-q'], { cwd: tmpDir, operation: 't:init' });
    SafeGitExecutor.run(['remote', 'add', 'up', 'https://github.com/JKHeadley/instar.git'], { cwd: tmpDir, operation: 't:remote' });
    const r = resolveCanonicalRemote(tmpDir);
    expect(r.remote).toBe('up');
    expect(r.overridden).toBe(false);
  });

  it('state round-trips through save/load and survives corruption', () => {
    const statePath = path.join(tmpDir, 'state', 'release-readiness.json');
    const state = ReleaseReadinessSentinel.emptyState();
    state.episodes.push({ oldestSha: 'abc', firstDetectedMs: 123 });
    saveReadinessState(statePath, state);
    const loaded = loadReadinessState(statePath);
    expect(loaded.episodes).toHaveLength(1);
    expect(loaded.episodes[0].oldestSha).toBe('abc');
    // Corrupt the file → load returns a fresh state rather than throwing.
    fs.writeFileSync(statePath, '{ not json');
    expect(loadReadinessState(statePath).episodes).toHaveLength(0);
  });

  it('buildReleaseReadinessDeps returns real callable functions for every dep', () => {
    const deps = buildReleaseReadinessDeps({
      repoPath: tmpDir,
      statePath: path.join(tmpDir, 'state', 'release-readiness.json'),
      auditPath: path.join(tmpDir, 'audit.jsonl'),
      port: 4099,
      authToken: 'test',
    });
    for (const key of [
      'fetchCanonical', 'runAnalyzer', 'oldestUnreleasedCommit', 'guideBlocksPublish',
      'draftGuide', 'postAttention', 'resolveAttention', 'loadState', 'saveState',
      'isAncestor', 'audit', 'now',
    ] as const) {
      expect(typeof deps[key]).toBe('function');
    }
    // now() is real; loadState() yields a usable empty state; audit() writes a line.
    expect(typeof deps.now()).toBe('number');
    expect(deps.loadState().episodes).toEqual([]);
    deps.audit({ kind: 'release-readiness', event: 'test' });
    expect(fs.readFileSync(path.join(tmpDir, 'audit.jsonl'), 'utf-8')).toContain('"event":"test"');
  });

  it('guideBlocksPublish returns true for missing/template/unreviewed and false for clean human content', async () => {
    const deps = buildReleaseReadinessDeps({
      repoPath: tmpDir, statePath: path.join(tmpDir, 's.json'), auditPath: path.join(tmpDir, 'a.jsonl'),
      port: 4099, authToken: 't',
    });
    fs.mkdirSync(path.join(tmpDir, 'upgrades'), { recursive: true });
    expect(await deps.guideBlocksPublish()).toBe(true); // missing
    fs.writeFileSync(path.join(tmpDir, 'upgrades', 'NEXT.md'), '## x\n<!-- auto-draft-unreviewed: x -->\n- y');
    expect(await deps.guideBlocksPublish()).toBe(true); // unreviewed marker
    fs.writeFileSync(path.join(tmpDir, 'upgrades', 'NEXT.md'), '# Guide\n## What Changed\nreal human notes here\n');
    expect(await deps.guideBlocksPublish()).toBe(false); // clean
  });
});
