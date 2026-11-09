// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Agent Awareness + Migration Parity for the native Permission slips / What I'm allowed to do screens
 * (docs/specs/mobile-native-permissions.md §7): new agents get the bullet in the Mobile app routes
 * block; existing agents get it inserted after the phones-messages bullet, once.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { MOBILE_PHONES_MESSAGES_LINE, MOBILE_PERMISSIONS_LINE, MOBILE_PERMISSIONS_MARKER, MOBILE_ROUTES_CLAUDEMD_SECTION, PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const count = (s: string) => s.split(MOBILE_PERMISSIONS_MARKER).length - 1;

describe('permissions screens awareness', () => {
  it('the Mobile app routes block carries the bullet right after the phones-messages bullet, with the injected port', () => {
    const lines = MOBILE_ROUTES_CLAUDEMD_SECTION(9999).split('\n');
    expect(lines[lines.indexOf(MOBILE_PHONES_MESSAGES_LINE(9999)) + 1]).toBe(MOBILE_PERMISSIONS_LINE(9999));
    expect(MOBILE_PERMISSIONS_LINE(9999)).toContain('http://localhost:9999/mobile/permissions/slips');
    expect(MOBILE_PERMISSIONS_LINE(9999)).not.toContain('4042');
    expect(MOBILE_PERMISSIONS_LINE(9999)).toContain('my token is always refused');
  });

  it('generateClaudeMd includes it once', () => {
    expect(count(generateClaudeMd('p', 'echo', 4042, true))).toBe(1);
  });
});

describe('migrateClaudeMd inserts the bullet into an existing Mobile app routes block, idempotently', () => {
  let projectDir: string; let stateDir: string; let claudeMdPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'permissions-claudemd-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'x', port: 4042, claudeMd: { layout: 'full' } }));
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/mobile-native-permissions-claudemd.test.ts' }); });

  it('an existing block without the bullet gets it after the phones-messages bullet, once across two runs', () => {
    const old = MOBILE_ROUTES_CLAUDEMD_SECTION(4042).split('\n').filter((l) => l !== MOBILE_PERMISSIONS_LINE(4042)).join('\n');
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n${old}`);
    expect(count(fs.readFileSync(claudeMdPath, 'utf-8'))).toBe(0);
    new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0', port: 4042 } as any).migrate();
    const once = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(count(once)).toBe(1);
    const lines = once.split('\n');
    expect(lines[lines.indexOf(MOBILE_PHONES_MESSAGES_LINE(4042)) + 1]).toBe(MOBILE_PERMISSIONS_LINE(4042));
    new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0', port: 4042 } as any).migrate();
    expect(count(fs.readFileSync(claudeMdPath, 'utf-8'))).toBe(1);
  });

  it('a hand-edited block gets the line once, not skipped', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\n### Mobile app routes — hand edited\n- something else\n');
    new PostUpdateMigrator({ stateDir, projectDir, version: '1.0.0', port: 4042 } as any).migrate();
    expect(count(fs.readFileSync(claudeMdPath, 'utf-8'))).toBe(1);
  });
});
