import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkDeclaredIdentityDirectory } from '../../src/core/ContextHierarchy.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const roots: string[] = [];

function fixture(): { projectDir: string; stateDir: string; identityPath: string } {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'declared-identity-dir-'));
  roots.push(projectDir);
  const stateDir = path.join(projectDir, '.instar');
  const identityPath = path.join(stateDir, 'context', 'identity.md');
  fs.mkdirSync(path.dirname(identityPath), { recursive: true });
  return { projectDir, stateDir, identityPath };
}

function writeIdentity(identityPath: string, directory: string): void {
  fs.writeFileSync(identityPath, `# Identity & Scope\n\n- **Directory**: ${directory}\n`);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    SafeFsExecutor.safeRmSync(root, {
      recursive: true,
      force: true,
      operation: 'tests/unit/declared-identity-directory.test.ts:cleanup',
    });
  }
});

describe('checkDeclaredIdentityDirectory', () => {
  it('accepts a declared directory that resolves to the boot project', () => {
    const fx = fixture();
    writeIdentity(fx.identityPath, fx.projectDir);

    expect(checkDeclaredIdentityDirectory(fx.stateDir, fx.projectDir)).toEqual({
      status: 'valid',
      identityPath: fx.identityPath,
      declaredDirectory: fx.projectDir,
    });
  });

  it('rejects a declared directory that does not exist', () => {
    const fx = fixture();
    const missing = path.join(fx.projectDir, 'moved-away');
    writeIdentity(fx.identityPath, missing);

    expect(checkDeclaredIdentityDirectory(fx.stateDir, fx.projectDir)).toMatchObject({
      status: 'invalid',
      declaredDirectory: missing,
      reason: 'the declared directory does not exist',
    });
  });

  it('rejects an existing directory that is not the boot project', () => {
    const fx = fixture();
    const different = fs.mkdtempSync(path.join(os.tmpdir(), 'other-agent-dir-'));
    roots.push(different);
    writeIdentity(fx.identityPath, different);

    const result = checkDeclaredIdentityDirectory(fx.stateDir, fx.projectDir);
    expect(result.status).toBe('invalid');
    expect(result).toMatchObject({ declaredDirectory: different });
    if (result.status === 'invalid') {
      expect(result.reason).toContain('but boot resolved this agent to');
    }
  });

  it('rejects a file and a relative directory declaration', () => {
    const fx = fixture();
    const file = path.join(fx.projectDir, 'not-a-directory');
    fs.writeFileSync(file, 'x');

    writeIdentity(fx.identityPath, file);
    expect(checkDeclaredIdentityDirectory(fx.stateDir, fx.projectDir)).toMatchObject({
      status: 'invalid',
      reason: 'the declared path is not a directory',
    });

    writeIdentity(fx.identityPath, './relative-agent');
    expect(checkDeclaredIdentityDirectory(fx.stateDir, fx.projectDir)).toMatchObject({
      status: 'invalid',
      reason: 'the declared directory is not an absolute path',
    });
  });

  it('does not manufacture a declaration when identity context is absent', () => {
    const fx = fixture();

    expect(checkDeclaredIdentityDirectory(fx.stateDir, fx.projectDir)).toEqual({
      status: 'not-declared',
      identityPath: fx.identityPath,
    });
  });
});

describe('server boot wiring', () => {
  it('warns without hard-failing before boot subsystems are configured', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'commands', 'server.ts'), 'utf-8');
    const start = source.indexOf('export async function startServer');
    const check = source.indexOf('checkDeclaredIdentityDirectory(config.stateDir, config.projectDir)', start);
    const spawnSemaphore = source.indexOf('configureHostSpawnSemaphore({', start);
    const checkBlock = source.slice(check, spawnSemaphore);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(check).toBeGreaterThan(start);
    expect(spawnSemaphore).toBeGreaterThan(check);
    expect(checkBlock).toContain('console.warn');
    expect(checkBlock).not.toMatch(/\bthrow\b|process\.exit\s*\(/);
  });
});
