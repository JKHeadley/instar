/**
 * Unit tests for InstarRuntimeRoot — pure path computation + TCC-protected
 * location detection + the two-layer state-dir resolver.
 *
 * Spec: docs/specs/macos26-launchd-tcc-runtime-relocation.md (Scope A).
 */

import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  RUNTIME_ROOT_ENV,
  RELOCATE_SCHEMA_VERSION,
  tccProtectedRoots,
  isUnderTccProtectedRoot,
  runtimeRootBase,
  projectDirHash,
  computeRuntimeRoot,
  resolveStateDir,
  readPersistedRuntimeRoot,
  readRelocateRecord,
  classifyRelocation,
  checkRuntimeRootConsistency,
  type RelocationFacts,
} from '../../src/core/InstarRuntimeRoot.js';

const HOME = '/Users/test';

describe('InstarRuntimeRoot', () => {
  describe('isUnderTccProtectedRoot', () => {
    it('flags ~/Documents and subfolders', () => {
      expect(isUnderTccProtectedRoot(`${HOME}/Documents`, HOME)).toBe(true);
      expect(isUnderTccProtectedRoot(`${HOME}/Documents/Projects/b2lead`, HOME)).toBe(true);
    });

    it('flags ~/Desktop, ~/Downloads, and iCloud Drive', () => {
      expect(isUnderTccProtectedRoot(`${HOME}/Desktop/x`, HOME)).toBe(true);
      expect(isUnderTccProtectedRoot(`${HOME}/Downloads/y`, HOME)).toBe(true);
      expect(
        isUnderTccProtectedRoot(`${HOME}/Library/Mobile Documents/com~apple~CloudDocs/z`, HOME),
      ).toBe(true);
    });

    it('does NOT flag the agent-home convention (~/.instar)', () => {
      // Echo's immunity — this is the whole reason the agent-home model is safe.
      expect(isUnderTccProtectedRoot(`${HOME}/.instar/agents/echo`, HOME)).toBe(false);
    });

    it('does NOT flag ~/Library/Application Support (the relocation target)', () => {
      expect(isUnderTccProtectedRoot(`${HOME}/Library/Application Support/instar/x`, HOME)).toBe(false);
    });

    it('does not false-match a sibling whose name shares the prefix', () => {
      // ~/DocumentsArchive must not match ~/Documents (path-boundary guard).
      expect(isUnderTccProtectedRoot(`${HOME}/DocumentsArchive/x`, HOME)).toBe(false);
    });

    it('includes all four protected roots', () => {
      const roots = tccProtectedRoots(HOME);
      expect(roots).toContain(`${HOME}/Documents`);
      expect(roots).toContain(`${HOME}/Desktop`);
      expect(roots).toContain(`${HOME}/Downloads`);
      expect(roots.some((r) => r.includes('CloudDocs'))).toBe(true);
    });
  });

  describe('runtimeRootBase', () => {
    it('uses ~/Library/Application Support on macOS', () => {
      expect(runtimeRootBase('darwin', HOME)).toBe(`${HOME}/Library/Application Support/instar`);
    });

    it('uses ~/.local/share on Linux', () => {
      expect(runtimeRootBase('linux', HOME)).toBe(`${HOME}/.local/share/instar`);
    });
  });

  describe('computeRuntimeRoot + projectDirHash', () => {
    it('disambiguates two same-named projects via the dir hash (NEW-6)', () => {
      const a = computeRuntimeRoot('foo', `${HOME}/Documents/Projects/foo`, 'darwin', HOME);
      const b = computeRuntimeRoot('foo', `${HOME}/Desktop/foo`, 'darwin', HOME);
      expect(a).not.toBe(b);
      expect(a).toMatch(/\/foo-[0-9a-f]{8}$/);
      expect(b).toMatch(/\/foo-[0-9a-f]{8}$/);
    });

    it('is deterministic for the same projectDir', () => {
      const d = `${HOME}/Documents/Projects/foo`;
      expect(projectDirHash(d)).toBe(projectDirHash(d));
      expect(computeRuntimeRoot('foo', d, 'darwin', HOME)).toBe(
        computeRuntimeRoot('foo', d, 'darwin', HOME),
      );
    });

    it('sanitizes an unsafe project name into a path-safe component', () => {
      const root = computeRuntimeRoot('weird name/../x', `${HOME}/Documents/x`, 'darwin', HOME);
      const base = path.basename(root);
      // The dir component itself must be traversal/space-free and path-safe.
      // (The base path "Application Support" legitimately contains a space, so
      // assert on the agent-specific component, not the whole path.)
      expect(base).not.toContain('..');
      expect(base).not.toContain(' ');
      expect(base).toMatch(/^[A-Za-z0-9._-]+-[0-9a-f]{8}$/);
    });
  });

  describe('resolveStateDir (two-layer pointer)', () => {
    it('boot layer: honors INSTAR_RUNTIME_ROOT directly (no Documents traversal)', () => {
      const root = `${HOME}/Library/Application Support/instar/foo-abc12345`;
      const env = { [RUNTIME_ROOT_ENV]: root } as NodeJS.ProcessEnv;
      expect(resolveStateDir(`${HOME}/Documents/Projects/foo`, env)).toBe(root);
    });

    it('consented layer: falls back to <projectDir>/.instar when env unset', () => {
      const env = {} as NodeJS.ProcessEnv;
      expect(resolveStateDir(`${HOME}/Documents/Projects/foo`, env)).toBe(
        `${HOME}/Documents/Projects/foo/.instar`,
      );
    });

    it('ignores a blank/whitespace env value', () => {
      const env = { [RUNTIME_ROOT_ENV]: '   ' } as NodeJS.ProcessEnv;
      expect(resolveStateDir(`${HOME}/x`, env)).toBe(`${HOME}/x/.instar`);
    });
  });

  describe('classifyRelocation (orchestrator decision — both sides of every gate)', () => {
    const base: RelocationFacts = {
      platform: 'darwin',
      alreadyRelocated: false,
      underTccProtectedRoot: true,
      sourceReadable: true,
    };

    it('already-relocated short-circuits FIRST, even in a launchd/TCC-blind context (NEW-R1)', () => {
      // The dangerous regression: an already-relocated agent re-running migrate
      // from a launchd context (source unreadable) must NOT attempt a move.
      expect(classifyRelocation({ ...base, alreadyRelocated: true, sourceReadable: false })).toBe('skip-already-relocated');
      // ...regardless of platform/TCC state.
      expect(classifyRelocation({ platform: 'linux', alreadyRelocated: true, underTccProtectedRoot: false, sourceReadable: true })).toBe('skip-already-relocated');
    });

    it('skips on non-macOS (no TCC issue)', () => {
      expect(classifyRelocation({ ...base, platform: 'linux' })).toBe('skip-not-macos');
    });

    it('skips when the project is not in a TCC-protected folder (e.g. Echo in ~/.instar)', () => {
      expect(classifyRelocation({ ...base, underTccProtectedRoot: false })).toBe('skip-not-tcc');
    });

    it('relocates when macOS + in a TCC folder + consented (source readable)', () => {
      expect(classifyRelocation({ ...base, sourceReadable: true })).toBe('relocate');
    });

    it('BLOCKS (escalate, no partial move) when source is unreadable — launchd TCC-blind', () => {
      expect(classifyRelocation({ ...base, sourceReadable: false })).toBe('blocked-tcc-blind');
    });
  });

  describe('checkRuntimeRootConsistency (NEW-4 split-brain guard)', () => {
    const tmp: string[] = [];
    afterEach(() => {
      for (const d of tmp.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
    });
    function scratch(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-cons-')); tmp.push(d); return d; }

    it('ok when no --runtime-root env is set (not relocated / consented context)', () => {
      expect(checkRuntimeRootConsistency('/Users/x/Documents/foo', {} as NodeJS.ProcessEnv).ok).toBe(true);
    });

    it('ok when .instar symlink target matches --runtime-root', () => {
      const base = scratch();
      const projectDir = path.join(base, 'project');
      const root = path.join(base, 'root');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.mkdirSync(root, { recursive: true });
      fs.symlinkSync(root, path.join(projectDir, '.instar'));
      const res = checkRuntimeRootConsistency(projectDir, { [RUNTIME_ROOT_ENV]: root } as NodeJS.ProcessEnv);
      expect(res.ok).toBe(true);
    });

    it('FLAGS a mismatch between the symlink target and --runtime-root', () => {
      const base = scratch();
      const projectDir = path.join(base, 'project');
      const rootA = path.join(base, 'rootA');
      const rootB = path.join(base, 'rootB');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.mkdirSync(rootA, { recursive: true });
      fs.mkdirSync(rootB, { recursive: true });
      fs.symlinkSync(rootA, path.join(projectDir, '.instar')); // symlink → A
      const res = checkRuntimeRootConsistency(projectDir, { [RUNTIME_ROOT_ENV]: rootB } as NodeJS.ProcessEnv); // arg → B
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/runtime-root mismatch/);
      expect(res.message).toMatch(/instar relocate/);
    });

    it('ok (arg authoritative) when .instar is not a symlink', () => {
      const base = scratch();
      const projectDir = path.join(base, 'project');
      fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
      const res = checkRuntimeRootConsistency(projectDir, { [RUNTIME_ROOT_ENV]: '/some/root' } as NodeJS.ProcessEnv);
      expect(res.ok).toBe(true);
    });
  });
});

describe('InstarRuntimeRoot — relocate.json record (disk-backed)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  function makeProject(record: unknown | null): string {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-rr-'));
    tmpDirs.push(projectDir);
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    if (record !== null) {
      fs.writeFileSync(
        path.join(projectDir, '.instar', 'relocate.json'),
        JSON.stringify(record),
      );
    }
    return projectDir;
  }

  it('readPersistedRuntimeRoot returns the stored root for a complete, current record', () => {
    const projectDir = makeProject({
      schemaVersion: RELOCATE_SCHEMA_VERSION,
      completed: true,
      runtimeRoot: '/Users/test/Library/Application Support/instar/foo-abc12345',
      projectDir: '/Users/test/Documents/Projects/foo',
      projectDirHash: 'abc12345',
      projectName: 'foo',
      relocatedAt: '2026-05-28T00:00:00Z',
    });
    expect(readPersistedRuntimeRoot(projectDir)).toBe(
      '/Users/test/Library/Application Support/instar/foo-abc12345',
    );
  });

  it('returns null when relocate.json is absent (not relocated)', () => {
    const projectDir = makeProject(null);
    expect(readPersistedRuntimeRoot(projectDir)).toBeNull();
  });

  it('returns null for an incomplete record (partial migration)', () => {
    const projectDir = makeProject({
      schemaVersion: RELOCATE_SCHEMA_VERSION,
      completed: false,
      runtimeRoot: '/some/root',
    });
    expect(readPersistedRuntimeRoot(projectDir)).toBeNull();
  });

  it('returns null for a stale schema version (forces re-migration)', () => {
    const projectDir = makeProject({
      schemaVersion: RELOCATE_SCHEMA_VERSION + 99,
      completed: true,
      runtimeRoot: '/some/root',
    });
    expect(readPersistedRuntimeRoot(projectDir)).toBeNull();
  });

  it('readRelocateRecord returns null on malformed JSON', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-rr-'));
    tmpDirs.push(projectDir);
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.instar', 'relocate.json'), '{ not valid json');
    expect(readRelocateRecord(projectDir)).toBeNull();
  });
});
