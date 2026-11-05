// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Agent Awareness + Migration Parity for the native Passwords & keys read
 * (docs/specs/mobile-native-secrets.md ): new agents get the bullet in the Mobile app routes
 * block; existing agents get it inserted after the permissions bullet, once.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { MOBILE_PERMISSIONS_LINE, MOBILE_SECRETS_LINE, MOBILE_SECRETS_MARKER, MOBILE_ROUTES_CLAUDEMD_SECTION, PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const count = (s: string) => s.split(MOBILE_SECRETS_MARKER).length - 1;

describe('passwords and keys screen awareness', () => {
  it('the Mobile app routes block carries the bullet right after the permissions bullet, with the injected port', () => {
    const lines = MOBILE_ROUTES_CLAUDEMD_SECTION(9999).split('\n');
    expect(lines[lines.indexOf(MOBILE_PERMISSIONS_LINE(9999)) + 1]).toBe(MOBILE_SECRETS_LINE(9999));
    expect(MOBILE_SECRETS_LINE(9999)).toContain('http://localhost:9999/mobile/secrets');
    expect(MOBILE_SECRETS_LINE(9999)).not.toContain('4042');
  });

  it('generateClaudeMd includes it once', () => {
    expect(count(generateClaudeMd('p', 'echo', 4042, true))).toBe(1);
  });
});

describe('migrateClaudeMd inserts the bullet into an existing Mobile app routes block, idempotently', () => {
  let projectDir: string; let stateDir: string; let claudeMdPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-claudemd-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'x', port: 4042, claudeMd: { layout: 'full' } }));
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/mobile-native-secrets-claudemd.test.ts' }); });

  it('an existing block without the bullet gets it after the permissions bullet, once across two runs', () => {
    const old = MOBILE_ROUTES_CLAUDEMD_SECTION(4042).split('\n').filter((l) => l !== MOBILE_SECRETS_LINE(4042)).join('\n');
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n${old}`);
    expect(count(fs.readFileSync(claudeMdPath, 'utf-8'))).toBe(0);
    new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0', port: 4042 } as any).migrate();
    const once = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(count(once)).toBe(1);
    const lines = once.split('\n');
    expect(lines[lines.indexOf(MOBILE_PERMISSIONS_LINE(4042)) + 1]).toBe(MOBILE_SECRETS_LINE(4042));
    new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0', port: 4042 } as any).migrate();
    expect(count(fs.readFileSync(claudeMdPath, 'utf-8'))).toBe(1);
  });

  it('a hand-edited block gets the line once, not skipped', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\n### Mobile app routes — hand edited\n- something else\n');
    new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0', port: 4042 } as any).migrate();
    expect(count(fs.readFileSync(claudeMdPath, 'utf-8'))).toBe(1);
  });
});
