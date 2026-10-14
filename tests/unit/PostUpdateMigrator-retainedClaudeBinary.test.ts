// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Migration Parity + Agent Awareness — retained Claude executable (CMT-798).
 *
 *  1. migrateConfig adds `sessions.retainedClaudeBinary: { enabled: true }`
 *     when absent, is idempotent, and NEVER overwrites an operator's explicit
 *     value (false, custom dir).
 *  2. migrateClaudeMd appends the awareness bullet once (content-sniffed) and
 *     the fresh template carries the same bullet for new agents.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/PostUpdateMigrator-retainedClaudeBinary.test.ts';
const SNIFF = 'retained per-version copy of the executable (CMT-798)';
type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
}
function run(m: PostUpdateMigrator, method: string): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as Record<string, (r: MigrationResult) => void>)[method](result);
  return result;
}

describe('CMT-798 — migrateConfig: sessions.retainedClaudeBinary default', () => {
  let projectDir: string; let configPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retained-claude-cfg-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    configPath = path.join(projectDir, '.instar', 'config.json');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: OP }));
  const read = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));

  it('adds { enabled: true } when the block is absent (even with no sessions block at all)', () => {
    fs.writeFileSync(configPath, JSON.stringify({ authToken: 'x' }));
    const r = run(newMigrator(projectDir), 'migrateConfig');
    expect(read().sessions.retainedClaudeBinary).toEqual({ enabled: true });
    expect(r.upgraded).toContain('config.json: added sessions.retainedClaudeBinary default (enabled: true)');
  });

  it('keeps sibling sessions fields intact when adding the block', () => {
    fs.writeFileSync(configPath, JSON.stringify({ authToken: 'x', sessions: { maxSessions: 7, claudePath: '/x/claude' } }));
    run(newMigrator(projectDir), 'migrateConfig');
    expect(read().sessions).toMatchObject({ maxSessions: 7, claudePath: '/x/claude', retainedClaudeBinary: { enabled: true } });
  });

  it('is idempotent and NEVER overwrites an operator value (enabled:false, custom dir)', () => {
    fs.writeFileSync(configPath, JSON.stringify({ authToken: 'x', sessions: { retainedClaudeBinary: { enabled: false, dir: '/custom', pruneGraceMs: 5 } } }));
    const r1 = run(newMigrator(projectDir), 'migrateConfig');
    expect(read().sessions.retainedClaudeBinary).toEqual({ enabled: false, dir: '/custom', pruneGraceMs: 5 });
    expect(r1.upgraded.some((u) => u.includes('retainedClaudeBinary'))).toBe(false);
    run(newMigrator(projectDir), 'migrateConfig');
    const r3 = run(newMigrator(projectDir), 'migrateConfig');
    expect(read().sessions.retainedClaudeBinary).toEqual({ enabled: false, dir: '/custom', pruneGraceMs: 5 });
    expect(r3.upgraded.some((u) => u.includes('retainedClaudeBinary'))).toBe(false);
  });
});

describe('CMT-798 — Agent Awareness: CLAUDE.md template + migration', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retained-claude-md-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: OP }));

  it('the fresh template carries the bullet with the Registry-First route and the off switch', () => {
    const md = generateClaudeMd('test', 'Test', 4040, false);
    expect(md).toContain(SNIFF);
    expect(md).toContain('http://localhost:4040/sessions/claude-binary');
    expect(md).toContain('sessions.retainedClaudeBinary.enabled: false');
  });

  it('migrateClaudeMd appends the bullet once to an existing CLAUDE.md and is idempotent', () => {
    const mdPath = path.join(projectDir, 'CLAUDE.md');
    fs.writeFileSync(mdPath, '# CLAUDE.md\n\nexisting operator text\n');
    const r1 = run(newMigrator(projectDir), 'migrateClaudeMd');
    const once = fs.readFileSync(mdPath, 'utf8');
    expect(once).toContain(SNIFF);
    expect(once).toContain('existing operator text');
    expect(once).toContain('http://localhost:4042/sessions/claude-binary');
    expect(r1.upgraded).toContain('CLAUDE.md: added retained Claude executable (CMT-798) awareness bullet');
    run(newMigrator(projectDir), 'migrateClaudeMd');
    const twice = fs.readFileSync(mdPath, 'utf8');
    expect(twice.split(SNIFF).length - 1).toBe(1);
  });
});
