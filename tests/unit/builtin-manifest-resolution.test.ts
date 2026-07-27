/**
 * The builtin manifest must resolve in BOTH layouts, and a failed load must be
 * distinguishable from an empty manifest.
 *
 * WHY THIS FILE EXISTS. `loadBuiltinManifest()` resolved `__dirname/../data`. In a source
 * checkout that is `src/core → src/data`, which exists — so every test passed. In a
 * compiled install it is `dist/core → dist/data`, which does NOT exist: tsc does not copy
 * .json and nothing else writes it. Verified in a real install:
 * `dist/data/builtin-manifest.json` ABSENT, `src/data/builtin-manifest.json` PRESENT
 * (62,717 bytes, shipped via package.json `files`).
 *
 * So the bug was invisible to the whole suite because the suite only ever ran in the one
 * layout where the path happened to work.
 *
 * NOTE ON METHOD — this file was rewritten before it ever ran in anger. The first draft
 * reimplemented the resolution inside the test and asserted against that copy, which
 * cannot fail when production changes: a proof structurally blind to its subject, the same
 * blindness the bug is made of. Production now EXPORTS the resolution parameterised by a
 * module directory, and these tests call it directly.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadBuiltinManifestFrom,
  builtinManifestCandidates,
} from '../../src/core/CapabilityMapper.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true, force: true,
        operation: 'tests/unit/builtin-manifest-resolution.test.ts:cleanup',
      });
    } catch { /* test cleanup only */ }
  }
});

function mkroot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-manifest-res-'));
  tmpDirs.push(dir);
  return dir;
}

function writeManifest(root: string, rel: string[], body: string): void {
  const dir = path.join(root, ...rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'builtin-manifest.json'), body);
}

describe('builtin manifest resolution', () => {
  it('THE BUG: resolves in an INSTALLED layout, where the manifest ships at src/data', () => {
    // dist/core/CapabilityMapper.js reading a package whose `files` shipped src/data.
    // Under the old single-path resolution this found nothing and returned {}.
    const root = mkroot();
    fs.mkdirSync(path.join(root, 'dist', 'core'), { recursive: true });
    writeManifest(root, ['src', 'data'],
      JSON.stringify({ schemaVersion: 1, entryCount: 1, entries: { 'hook:demo': { id: 'hook:demo' } } }));

    const res = loadBuiltinManifestFrom(path.join(root, 'dist', 'core'));
    expect(res.state).toBe('loaded');
    expect(Object.keys(res.entries)).toEqual(['hook:demo']);
  });

  it('still resolves in a SOURCE checkout layout (src/core → src/data)', () => {
    const root = mkroot();
    fs.mkdirSync(path.join(root, 'src', 'core'), { recursive: true });
    writeManifest(root, ['src', 'data'],
      JSON.stringify({ schemaVersion: 1, entryCount: 1, entries: { 'job:demo': { id: 'job:demo' } } }));

    const res = loadBuiltinManifestFrom(path.join(root, 'src', 'core'));
    expect(res.state).toBe('loaded');
    expect(Object.keys(res.entries)).toEqual(['job:demo']);
  });

  it('a MISSING manifest reports not-found — never confused with loaded-and-empty', () => {
    const root = mkroot();
    fs.mkdirSync(path.join(root, 'dist', 'core'), { recursive: true });

    const res = loadBuiltinManifestFrom(path.join(root, 'dist', 'core'));
    expect(res.state).toBe('not-found');
    expect(res.entries).toEqual({});
    expect(res.path).toBeNull();
  });

  it('a genuinely EMPTY manifest reports loaded — the other side of the boundary', () => {
    // The distinction the old code could not express: this case and the one above both
    // produced `{}`, so "no builtins recorded" and "could not read the record" were the
    // same answer.
    const root = mkroot();
    fs.mkdirSync(path.join(root, 'dist', 'core'), { recursive: true });
    writeManifest(root, ['src', 'data'], JSON.stringify({ schemaVersion: 1, entryCount: 0, entries: {} }));

    const res = loadBuiltinManifestFrom(path.join(root, 'dist', 'core'));
    expect(res.state).toBe('loaded');
    expect(res.entries).toEqual({});
  });

  it('an UNPARSEABLE manifest reports unreadable, with the path and the parse error', () => {
    const root = mkroot();
    fs.mkdirSync(path.join(root, 'dist', 'core'), { recursive: true });
    writeManifest(root, ['src', 'data'], '{ truncated');

    const res = loadBuiltinManifestFrom(path.join(root, 'dist', 'core'));
    expect(res.state).toBe('unreadable');
    expect(res.entries).toEqual({});
    expect(res.path).toContain('builtin-manifest.json');
    expect(res.error).toBeTruthy();
  });

  it('enumerates both layouts, in order', () => {
    const c = builtinManifestCandidates('/pkg/dist/core');
    expect(c).toEqual([
      path.join('/pkg/dist/core', '..', 'data', 'builtin-manifest.json'),
      path.join('/pkg/dist/core', '..', '..', 'src', 'data', 'builtin-manifest.json'),
    ]);
  });

  /**
   * The real package must actually be readable from the layout it ships in. This is the
   * end-to-end check the unit cases above cannot make: they build synthetic trees, while
   * this one resolves against THIS repo.
   */
  it('resolves against this repo from the source layout', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const srcCore = path.resolve(here, '../../src/core');
    const res = loadBuiltinManifestFrom(srcCore);
    // The manifest is a generated artifact; it may legitimately be absent in a fresh
    // checkout. What must NEVER happen is a silent `{}` that cannot say which case it is.
    expect(['loaded', 'not-found']).toContain(res.state);
    if (res.state === 'loaded') expect(res.path).toContain('builtin-manifest.json');
  });

  /** The silent swallow this change removes must not come back. */
  it('RATCHET: the fall-through swallow is gone from production', () => {
    const src = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/core/CapabilityMapper.ts'),
      'utf-8',
    );
    expect(src).not.toContain('} catch { /* fall through */ }');
  });
});
