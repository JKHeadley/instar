/**
 * Unit tests for RuntimeRelocator — the transactional whole-tree relocation.
 * Uses real temp dirs (same volume as os.tmpdir) so rename() behaves as in prod.
 *
 * Spec: docs/specs/macos26-launchd-tcc-runtime-relocation.md (Scope A).
 */

import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  relocateRuntime,
  sweepStalePartials,
  verifyRuntimeRoot,
  sameVolume,
} from '../../src/core/RuntimeRelocator.js';

const tmpRoots: string[] = [];

function makeAgent(): { projectDir: string; runtimeRoot: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-relo-'));
  tmpRoots.push(base);
  const projectDir = path.join(base, 'Documents', 'Projects', 'foo');
  const instar = path.join(projectDir, '.instar');
  fs.mkdirSync(path.join(instar, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(instar, 'state'), { recursive: true });
  fs.writeFileSync(path.join(instar, 'config.json'), JSON.stringify({ projectName: 'foo', port: 4042 }));
  fs.writeFileSync(path.join(instar, 'state', 'thing.json'), '{"a":1}');
  // runtime root target — sibling under the same temp base (same volume).
  const runtimeRoot = path.join(base, 'Library', 'Application Support', 'instar', 'foo-abc12345');
  return { projectDir, runtimeRoot };
}

afterEach(() => {
  for (const d of tmpRoots.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('RuntimeRelocator.relocateRuntime — happy path', () => {
  it('moves the whole tree, symlinks .instar, writes the sentinel last, preserves state', () => {
    const { projectDir, runtimeRoot } = makeAgent();
    const res = relocateRuntime({ projectDir, projectName: 'foo', runtimeRoot });

    expect(res.ok).toBe(true);
    // Tree now lives at the runtime root.
    expect(fs.existsSync(path.join(runtimeRoot, 'config.json'))).toBe(true);
    expect(fs.readFileSync(path.join(runtimeRoot, 'state', 'thing.json'), 'utf-8')).toBe('{"a":1}');
    // .instar is now a symlink → runtime root.
    const instar = path.join(projectDir, '.instar');
    expect(fs.lstatSync(instar).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(instar)).toBe(fs.realpathSync(runtimeRoot));
    // Reads through the symlink resolve to the moved files (the consented-context path).
    expect(fs.existsSync(path.join(instar, 'config.json'))).toBe(true);
    // Sentinel written, completed, in the runtime root.
    const rec = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'relocate.json'), 'utf-8'));
    expect(rec.completed).toBe(true);
    expect(rec.runtimeRoot).toBe(runtimeRoot);
    expect(rec.projectName).toBe('foo');
  });

  it('exactly ONE live copy of state exists after relocation (no dual-copy)', () => {
    const { projectDir, runtimeRoot } = makeAgent();
    relocateRuntime({ projectDir, projectName: 'foo', runtimeRoot });
    // The original physical dir is gone (replaced by a symlink), so there is no
    // second writable copy under Documents.
    const instar = path.join(projectDir, '.instar');
    expect(fs.lstatSync(instar).isSymbolicLink()).toBe(true);
    // Writing through the symlink lands in the one real location.
    fs.writeFileSync(path.join(instar, 'state', 'new.json'), '{"b":2}');
    expect(fs.existsSync(path.join(runtimeRoot, 'state', 'new.json'))).toBe(true);
  });
});

describe('RuntimeRelocator.relocateRuntime — safety / rollback', () => {
  it('rolls back (restores .instar) when the node probe fails', () => {
    const { projectDir, runtimeRoot } = makeAgent();
    // Give the fixture a node symlink so the probe branch is exercised, then
    // force the probe to fail — relocation must roll back.
    fs.symlinkSync('/usr/bin/true', path.join(projectDir, '.instar', 'bin', 'node'));
    const res = relocateRuntime({ projectDir, projectName: 'foo', runtimeRoot }, () => false);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/verify failed|cannot execute/);
    const instar = path.join(projectDir, '.instar');
    expect(fs.existsSync(instar)).toBe(true);
    expect(fs.lstatSync(instar).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(runtimeRoot)).toBe(false);
  });

  it('verify fails + rolls back when config.json is missing in the moved tree', () => {
    const { projectDir, runtimeRoot } = makeAgent();
    // Corrupt: remove config.json so post-move verify fails.
    fs.rmSync(path.join(projectDir, '.instar', 'config.json'));
    const res = relocateRuntime({ projectDir, projectName: 'foo', runtimeRoot });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/verify failed/);
    // .instar must be restored as a real directory (rollback), runtime root gone.
    const instar = path.join(projectDir, '.instar');
    expect(fs.existsSync(instar)).toBe(true);
    expect(fs.lstatSync(instar).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(runtimeRoot)).toBe(false);
  });

  it('refuses to double-relocate when .instar is already a symlink', () => {
    const { projectDir, runtimeRoot } = makeAgent();
    const first = relocateRuntime({ projectDir, projectName: 'foo', runtimeRoot });
    expect(first.ok).toBe(true);
    const second = relocateRuntime({ projectDir, projectName: 'foo', runtimeRoot });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already relocated|already a symlink/);
  });

  it('refuses when the runtime root already exists and is non-empty', () => {
    const { projectDir, runtimeRoot } = makeAgent();
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'someone-elses-file'), 'x');
    const res = relocateRuntime({ projectDir, projectName: 'foo', runtimeRoot });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/already exists and is non-empty/);
    // Source must be untouched.
    expect(fs.lstatSync(path.join(projectDir, '.instar')).isSymbolicLink()).toBe(false);
  });

});

describe('RuntimeRelocator helpers', () => {
  it('sweepStalePartials removes orphaned .partial-* dirs', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-sweep-'));
    tmpRoots.push(base);
    const runtimeRoot = path.join(base, 'foo-abc12345');
    fs.mkdirSync(`${runtimeRoot}.partial-111`, { recursive: true });
    fs.mkdirSync(`${runtimeRoot}.partial-222`, { recursive: true });
    fs.mkdirSync(path.join(base, 'unrelated'), { recursive: true });
    sweepStalePartials(runtimeRoot);
    expect(fs.existsSync(`${runtimeRoot}.partial-111`)).toBe(false);
    expect(fs.existsSync(`${runtimeRoot}.partial-222`)).toBe(false);
    expect(fs.existsSync(path.join(base, 'unrelated'))).toBe(true);
  });

  it('verifyRuntimeRoot fails on missing/unparseable config', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-verify-'));
    tmpRoots.push(base);
    expect(verifyRuntimeRoot(base).ok).toBe(false); // no config.json
    fs.writeFileSync(path.join(base, 'config.json'), '{ bad json');
    expect(verifyRuntimeRoot(base).ok).toBe(false); // unparseable
    fs.writeFileSync(path.join(base, 'config.json'), '{"ok":true}');
    expect(verifyRuntimeRoot(base).ok).toBe(true);
  });

  it('sameVolume returns true for two paths under the same temp base', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-vol-'));
    tmpRoots.push(base);
    expect(sameVolume(path.join(base, 'a'), path.join(base, 'b', 'c'))).toBe(true);
  });
});
