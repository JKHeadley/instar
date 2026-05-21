/**
 * Secret Drop hardened retrieve — migration coverage.
 *
 * Two slices:
 *
 * 1. migrateScripts installs `.instar/scripts/secret-drop-retrieve.mjs`
 *    on every update run (always-overwrite, like convergence-check.sh).
 *    This is the structural fix for the 2026-05-20 leak class — agents
 *    that update in place must receive the hardened helper without
 *    waiting for a re-init.
 *
 * 2. migrateClaudeMd rewrites the legacy unsafe `curl /secrets/retrieve/TOKEN`
 *    line to the hardened command form. Idempotent: a CLAUDE.md that already
 *    documents `secret-drop-retrieve.mjs` is left alone.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function createMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: true,
    projectName: 'test-agent',
  });
}

function runMigrateScripts(m: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateScripts(r: MigrationResult): void }).migrateScripts(result);
  return result;
}

function runMigrateClaudeMd(m: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('PostUpdateMigrator — Secret Drop hardened retrieve script install', () => {
  let projectDir: string;
  let retrievePath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-secret-drop-retrieve-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    retrievePath = path.join(projectDir, '.instar', 'scripts', 'secret-drop-retrieve.mjs');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-secretDropHardenedRetrieve.test.ts',
    });
  });

  it('installs .instar/scripts/secret-drop-retrieve.mjs on update', () => {
    const result = runMigrateScripts(createMigrator(projectDir));
    expect(result.errors).toEqual([]);
    expect(fs.existsSync(retrievePath)).toBe(true);
  });

  it('the installed helper is executable', () => {
    runMigrateScripts(createMigrator(projectDir));
    const mode = fs.statSync(retrievePath).mode & 0o777;
    expect(mode & 0o100).toBeTruthy(); // owner-execute bit set
  });

  it('the installed helper has the hardening guarantees baked in', () => {
    runMigrateScripts(createMigrator(projectDir));
    const content = fs.readFileSync(retrievePath, 'utf-8');
    // Streams field value via process.stdout.write — never console.log the body.
    expect(content).toMatch(/process\.stdout\.write\(v\)/);
    // Never falls back to printing the raw response body.
    expect(content).toMatch(/NEVER print the response body|never prints the response body|that's the leak we're/i);
    // Honors --consume opt-in (default is peek per the 2026-05-20 hardening).
    expect(content).toContain('--consume');
  });

  it('reports the install in the upgraded list', () => {
    const result = runMigrateScripts(createMigrator(projectDir));
    expect(result.upgraded.some(u => u.includes('secret-drop-retrieve.mjs'))).toBe(true);
  });

  it('is safe to re-run (always-overwrite, content unchanged)', () => {
    runMigrateScripts(createMigrator(projectDir));
    const first = fs.readFileSync(retrievePath, 'utf-8');
    runMigrateScripts(createMigrator(projectDir));
    const second = fs.readFileSync(retrievePath, 'utf-8');
    expect(second).toBe(first);
  });
});

describe('PostUpdateMigrator — CLAUDE.md Secret Drop rewrite', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-secret-drop-claudemd-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-secretDropHardenedRetrieve.test.ts',
    });
  });

  it('rewrites the legacy curl line to the hardened helper form', () => {
    const legacy = [
      '# CLAUDE.md — test',
      '',
      '**Secret Drop** — secure secret intake.',
      '- Request: ...',
      '- Retrieve the secret: `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4042/secrets/retrieve/TOKEN`',
      '- List pending: ...',
      '',
    ].join('\n');
    fs.writeFileSync(claudeMdPath, legacy);

    const result = runMigrateClaudeMd(createMigrator(projectDir));
    expect(result.errors).toEqual([]);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('node .instar/scripts/secret-drop-retrieve.mjs');
    expect(after).toContain('NEVER use `curl /secrets/retrieve`');
    // The legacy unsafe line is gone.
    expect(after).not.toMatch(/Retrieve the secret:.*curl.*\/secrets\/retrieve\/TOKEN/);
    expect(result.upgraded.some(u => u.includes('hardened helper'))).toBe(true);
  });

  it('is idempotent — already-hardened Secret Drop section is left alone', () => {
    const hardened = [
      '# CLAUDE.md — test',
      '',
      '**Secret Drop** — secure secret intake.',
      '- **Retrieve the secret (HARDENED — required)**: `node .instar/scripts/secret-drop-retrieve.mjs TOKEN field-name`',
      '',
    ].join('\n');
    fs.writeFileSync(claudeMdPath, hardened);

    const result = runMigrateClaudeMd(createMigrator(projectDir));
    expect(result.errors).toEqual([]);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    // The hardened line is preserved exactly — no double-rewrite.
    expect(after).toContain('- **Retrieve the secret (HARDENED — required)**: `node .instar/scripts/secret-drop-retrieve.mjs TOKEN field-name`');
    // The Secret Drop block was NOT touched by this migrator pass.
    expect(result.upgraded.some(u => u.toLowerCase().includes('secret drop'))).toBe(false);
    expect(result.skipped.some(s => s.includes('Secret Drop already documents hardened helper'))).toBe(true);
  });

  it('tolerates a port that does not match the agent\'s configured port', () => {
    // Older agent installed when port was 4040; the line literal uses 4040,
    // but the migrator now runs at 4042. The port-tolerant regex should
    // still find and replace the line.
    const legacy = [
      '# CLAUDE.md — test',
      '',
      '**Secret Drop**',
      '- Retrieve the secret: `curl -X POST -H "Authorization: Bearer $AUTH" http://localhost:4040/secrets/retrieve/TOKEN`',
      '',
    ].join('\n');
    fs.writeFileSync(claudeMdPath, legacy);

    const result = runMigrateClaudeMd(createMigrator(projectDir));
    expect(result.errors).toEqual([]);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('node .instar/scripts/secret-drop-retrieve.mjs');
    expect(after).not.toMatch(/\/secrets\/retrieve\/TOKEN`/);
    expect(result.upgraded.some(u => u.includes('hardened helper'))).toBe(true);
  });
});
