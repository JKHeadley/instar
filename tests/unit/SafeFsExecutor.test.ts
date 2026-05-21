// safe-git-allow: this is the test file for SafeFsExecutor; direct fs usage is for fixture setup only.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SourceTreeGuardError } from '../../src/core/SourceTreeGuard.js';

function mkSandbox(prefix = 'sfe-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return fs.realpathSync(dir);
}

function rmrf(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function makeFakeInstarSource(): string {
  const dir = mkSandbox('sfe-fake-instar-');
  fs.writeFileSync(path.join(dir, '.instar-source-tree'), 'marker');
  // .git dir so findGitRoot's upward walk anchors here when we pass in a child path.
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(
    path.join(dir, '.git', 'config'),
    `[core]\n\trepositoryformatversion = 0\n`,
  );
  return dir;
}

let auditDir: string;
beforeAll(() => {
  auditDir = mkSandbox('sfe-audit-');
  process.env.INSTAR_AUDIT_LOG_DIR = auditDir;
});
afterAll(() => {
  delete process.env.INSTAR_AUDIT_LOG_DIR;
  rmrf(auditDir);
});

describe('SafeFsExecutor.safeRmSync', () => {
  let benign: string;
  let fakeInstar: string;
  beforeEach(() => {
    benign = mkSandbox();
    fakeInstar = makeFakeInstarSource();
  });
  afterEach(() => {
    rmrf(benign);
    rmrf(fakeInstar);
  });

  it('removes a benign tmpdir target', () => {
    const target = path.join(benign, 'doomed');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'x'), 'x');
    SafeFsExecutor.safeRmSync(target, { recursive: true, operation: 'rm-test' });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('blocks rm against the instar source tree', () => {
    expect(() =>
      SafeFsExecutor.safeRmSync(fakeInstar, {
        recursive: true,
        force: true,
        operation: 'rm-blocked',
      }),
    ).toThrow(SourceTreeGuardError);
    expect(fs.existsSync(fakeInstar)).toBe(true);
  });

  it('blocks rm against a path inside the instar source tree', () => {
    const inside = path.join(fakeInstar, 'src');
    fs.mkdirSync(inside);
    expect(() =>
      SafeFsExecutor.safeRmSync(inside, {
        recursive: true,
        force: true,
        operation: 'rm-inside-blocked',
      }),
    ).toThrow(SourceTreeGuardError);
    expect(fs.existsSync(inside)).toBe(true);
  });

  it('blocks symlink-to-instar bypass', () => {
    const link = path.join(benign, 'shadow');
    fs.symlinkSync(fakeInstar, link);
    expect(() =>
      SafeFsExecutor.safeRmSync(link, {
        recursive: true,
        force: true,
        operation: 'rm-symlink-blocked',
      }),
    ).toThrow(SourceTreeGuardError);
    expect(fs.existsSync(fakeInstar)).toBe(true);
  });
});

describe('SafeFsExecutor.safeUnlinkSync', () => {
  let benign: string;
  let fakeInstar: string;
  beforeEach(() => {
    benign = mkSandbox();
    fakeInstar = makeFakeInstarSource();
  });
  afterEach(() => {
    rmrf(benign);
    rmrf(fakeInstar);
  });

  it('removes a single file in benign tmpdir', () => {
    const file = path.join(benign, 'doomed');
    fs.writeFileSync(file, 'x');
    SafeFsExecutor.safeUnlinkSync(file, { operation: 'unlink-test' });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('blocks unlink of a file inside the instar source tree', () => {
    const file = path.join(fakeInstar, 'package.json');
    fs.writeFileSync(file, '{}');
    expect(() =>
      SafeFsExecutor.safeUnlinkSync(file, { operation: 'unlink-blocked' }),
    ).toThrow(SourceTreeGuardError);
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe('SafeFsExecutor.safeRm (async)', () => {
  let benign: string;
  let fakeInstar: string;
  beforeEach(() => {
    benign = mkSandbox();
    fakeInstar = makeFakeInstarSource();
  });
  afterEach(() => {
    rmrf(benign);
    rmrf(fakeInstar);
  });

  it('removes a benign tmpdir target', async () => {
    const target = path.join(benign, 'doomed');
    fs.mkdirSync(target);
    await SafeFsExecutor.safeRm(target, { recursive: true, operation: 'rm-async-test' });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('blocks rm against the instar source tree', async () => {
    await expect(
      SafeFsExecutor.safeRm(fakeInstar, {
        recursive: true,
        force: true,
        operation: 'rm-async-blocked',
      }),
    ).rejects.toThrow(SourceTreeGuardError);
    expect(fs.existsSync(fakeInstar)).toBe(true);
  });
});

describe('SafeFsExecutor.safeRmdirSync / safeUnlink async', () => {
  let benign: string;
  let fakeInstar: string;
  beforeEach(() => {
    benign = mkSandbox();
    fakeInstar = makeFakeInstarSource();
  });
  afterEach(() => {
    rmrf(benign);
    rmrf(fakeInstar);
  });

  it('rmdir on empty benign dir', () => {
    const target = path.join(benign, 'empty');
    fs.mkdirSync(target);
    SafeFsExecutor.safeRmdirSync(target, { operation: 'rmdir-test' });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('async unlink succeeds in benign tmpdir', async () => {
    const file = path.join(benign, 'f');
    fs.writeFileSync(file, 'x');
    await SafeFsExecutor.safeUnlink(file, { operation: 'unlink-async' });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('async unlink blocked against instar source file', async () => {
    const file = path.join(fakeInstar, 'pkg.json');
    fs.writeFileSync(file, '{}');
    await expect(
      SafeFsExecutor.safeUnlink(file, { operation: 'unlink-async-blocked' }),
    ).rejects.toThrow(SourceTreeGuardError);
  });
});

describe('Incident-A fs regression', () => {
  it('an in-process fs.rmSync against the instar source is blocked when routed through SafeFsExecutor', () => {
    const fakeInstar = makeFakeInstarSource();
    try {
      expect(() =>
        SafeFsExecutor.safeRmSync(fakeInstar, {
          recursive: true,
          force: true,
          operation: 'incident-a-fs-regression',
        }),
      ).toThrow(SourceTreeGuardError);
    } finally {
      rmrf(fakeInstar);
    }
  });
});

describe('SafeFsExecutor agent-runtime-state carve-out', () => {
  // When instar is deployed in agent mode the agent dir IS a checkout of the
  // source. WakeSocketServer.stale-socket-recovery and similar runtime ops must
  // be allowed to unlink under `<root>/.instar/` even though the root passes
  // the guard's source-tree detection. .instar/ contents are gitignored.
  let fakeInstar: string;
  beforeEach(() => {
    fakeInstar = makeFakeInstarSource();
    fs.mkdirSync(path.join(fakeInstar, '.instar'), { recursive: true });
  });
  afterEach(() => {
    rmrf(fakeInstar);
  });

  it('allows unlink on a socket file under <root>/.instar/', () => {
    const sockPath = path.join(fakeInstar, '.instar', 'listener.sock');
    fs.writeFileSync(sockPath, '');
    expect(() =>
      SafeFsExecutor.safeUnlinkSync(sockPath, {
        operation: 'WakeSocketServer.ts:stale-socket-recovery',
      }),
    ).not.toThrow();
    expect(fs.existsSync(sockPath)).toBe(false);
  });

  it('allows unlink on a lock file under <root>/.instar/', () => {
    const lockPath = path.join(fakeInstar, '.instar', 'lifeline.lock');
    fs.writeFileSync(lockPath, '');
    expect(() =>
      SafeFsExecutor.safeUnlinkSync(lockPath, {
        operation: 'TelegramLifeline.ts:lock-cleanup',
      }),
    ).not.toThrow();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('allows rm on a nested file under <root>/.instar/state/', () => {
    const stateDir = path.join(fakeInstar, '.instar', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const target = path.join(stateDir, 'stale.json');
    fs.writeFileSync(target, '{}');
    expect(() =>
      SafeFsExecutor.safeRmSync(target, {
        force: true,
        operation: 'state-prune',
      }),
    ).not.toThrow();
    expect(fs.existsSync(target)).toBe(false);
  });

  it('still BLOCKS rm on the `.instar` directory itself (not its contents)', () => {
    // The carve-out is for files INSIDE .instar/, not the dir itself. Blowing
    // away .instar wholesale would be a destructive op even in agent mode.
    const dotInstar = path.join(fakeInstar, '.instar');
    expect(() =>
      SafeFsExecutor.safeRmSync(dotInstar, {
        recursive: true,
        force: true,
        operation: 'rm-dot-instar',
      }),
    ).toThrow(SourceTreeGuardError);
    expect(fs.existsSync(dotInstar)).toBe(true);
  });

  it('still BLOCKS unlink on source files at the tree root', () => {
    const srcFile = path.join(fakeInstar, 'src', 'foo.ts');
    fs.mkdirSync(path.dirname(srcFile), { recursive: true });
    fs.writeFileSync(srcFile, '// dummy');
    expect(() =>
      SafeFsExecutor.safeUnlinkSync(srcFile, {
        operation: 'should-be-blocked',
      }),
    ).toThrow(SourceTreeGuardError);
    expect(fs.existsSync(srcFile)).toBe(true);
  });
});
