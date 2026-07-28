import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const migratorSourcePath = path.join(repoRoot, 'src', 'core', 'PostUpdateMigrator.ts');

function createMigrator(): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir: repoRoot,
    stateDir: path.join(repoRoot, '.instar'),
    port: 4044,
    hasTelegram: true,
    projectName: 'template-resolution-test',
  });
}

function getMethodBody(source: string, methodName: string): string {
  const marker = `private ${methodName}(`;
  const start = source.indexOf(marker);
  expect(start, `${methodName} should exist`).toBeGreaterThanOrEqual(0);

  const open = source.indexOf('{', start);
  expect(open, `${methodName} should have a body`).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`Could not extract ${methodName} body`);
}

describe('PostUpdateMigrator template resolution', () => {
  const tempDirs: string[] = [];
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    for (const dir of tempDirs.splice(0)) {
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/PostUpdateMigrator-templateResolution.test.ts cleanup',
      });
    }
  });

  it('loads hook templates through the shared dist-or-src resolver independent of cwd', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-template-resolution-'));
    tempDirs.push(tmp);
    process.chdir(tmp);

    const migrator = createMigrator();
    const hook = (migrator as unknown as {
      loadTemplate(subdir: 'hooks', filename: string): string | null;
    }).loadTemplate('hooks', 'free-text-guard.sh');

    expect(hook).toBeTruthy();
    expect(hook).toContain('Free-Text Input Guard');
  });

  it('returns null for missing templates so callers can choose skip, fallback, or error behavior', () => {
    const migrator = createMigrator();
    const missing = (migrator as unknown as {
      loadTemplate(subdir: 'hooks', filename: string): string | null;
    }).loadTemplate('hooks', 'definitely-not-shipped.sh');

    expect(missing).toBeNull();
  });

  it('keeps existing script readers on the same shared resolver', () => {
    const migrator = createMigrator();
    const relay = (migrator as unknown as {
      loadRelayTemplate(filename: string): string | null;
    }).loadRelayTemplate('telegram-reply.sh');
    const convergence = (migrator as unknown as {
      getConvergenceCheck(): string;
    }).getConvergenceCheck();

    expect(relay).toContain('telegram-reply.sh');
    expect(convergence).toContain('Lightweight convergence check');
  });

  it('regression guard: free-text guard no longer performs a single direct dist/templates read', () => {
    const source = fs.readFileSync(migratorSourcePath, 'utf-8');
    const body = getMethodBody(source, 'getFreeTextGuardHook');

    expect(body).toContain("this.loadTemplate('hooks', 'free-text-guard.sh')");
    expect(body).not.toContain("path.join(__dirname, '..', 'templates', 'hooks', 'free-text-guard.sh')");
    expect(body).not.toContain('fs.readFileSync');
  });
});
