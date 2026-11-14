// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/** Agent Awareness + Migration Parity (docs/specs/app-conversations-in-the-pool.md §7). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { MOBILE_APP_POOL_LINE, MOBILE_APP_POOL_MARKER, MOBILE_ROUTES_CLAUDEMD_SECTION, MOBILE_SESSION_APP_NEW_LINE, PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const count = (s: string) => s.split(MOBILE_APP_POOL_MARKER).length - 1;

describe('app conversations move: awareness', () => {
  it('sits right after the New session bullet', () => {
    const lines = MOBILE_ROUTES_CLAUDEMD_SECTION(9999).split('\n');
    expect(lines[lines.indexOf(MOBILE_SESSION_APP_NEW_LINE(9999)) + 1]).toBe(MOBILE_APP_POOL_LINE());
    expect(count(generateClaudeMd('p', 'echo', 4042, true))).toBe(1);
  });
});

describe('migrateClaudeMd adds it to an existing block once', () => {
  let projectDir: string; let stateDir: string; let claudeMdPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-pool-claudemd-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'x', port: 4042, claudeMd: { layout: 'full' } }));
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/app-conversations-pool-claudemd.test.ts' }); });

  it('inserts after the New session bullet, once across two runs', () => {
    const old = MOBILE_ROUTES_CLAUDEMD_SECTION(4042).split('\n').filter((l) => l !== MOBILE_APP_POOL_LINE()).join('\n');
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n${old}`);
    new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0', port: 4042 } as never).migrate();
    const once = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(count(once)).toBe(1);
    const lines = once.split('\n');
    expect(lines[lines.indexOf(MOBILE_SESSION_APP_NEW_LINE(4042)) + 1]).toBe(MOBILE_APP_POOL_LINE());
    new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0', port: 4042 } as never).migrate();
    expect(count(fs.readFileSync(claudeMdPath, 'utf-8'))).toBe(1);
  });
});
