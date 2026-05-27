/**
 * Integration-level test for the dark-guardrail migration gap fix
 * (docs/specs/EXISTING-AGENT-PRETOOLUSE-HOOK-PARITY-SPEC.md).
 *
 * Drives the REAL PostUpdateMigrator.migrateSettings against a temp agent
 * home whose .claude/settings.json predates the four guardrail hooks
 * (deferral-detector / grounding-before-messaging / external-communication-guard
 * / post-action-reflection). Asserts they are wired into the Bash PreToolUse
 * matcher after migration — i.e. an existing agent actually gets them, not just
 * the file on disk.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { instarHookFilename } from '../../src/core/instarSettingsHooks.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function runMigrateSettings(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateSettings(r: MigrationResult): void }).migrateSettings(result);
  return result;
}

const EXPECTED = [
  'dangerous-command-guard.sh',
  'grounding-before-messaging.sh',
  'deferral-detector.js',
  'external-communication-guard.js',
  'post-action-reflection.js',
];

describe('PostUpdateMigrator.migrateSettings — existing-agent PreToolUse parity', () => {
  let projectDir: string;
  let settingsPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-pretooluse-parity-'));
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    settingsPath = path.join(projectDir, '.claude', 'settings.json');
  });

  afterEach(() => {
    try {
      SafeFsExecutor.safeRmSync(projectDir, {
        recursive: true, force: true,
        operation: 'tests/unit/PostUpdateMigrator-pretooluse-parity.test.ts',
      });
    } catch { /* ignore */ }
  });

  function readBashHookFilenames(): Array<string | null> {
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const bash = (s.hooks?.PreToolUse ?? []).find((e: { matcher?: string }) => e.matcher === 'Bash');
    return (bash?.hooks ?? []).map((h: { command?: string }) => (h.command ? instarHookFilename(h.command) : null));
  }

  it('wires the four dark guardrails into an old agent that only had dangerous-command-guard', () => {
    // Simulate a pre-gap agent: Bash matcher with just dangerous-command-guard.
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [
            { type: 'command', command: 'bash ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/dangerous-command-guard.sh "$TOOL_INPUT"', blocking: true },
          ] },
        ],
      },
    }, null, 2));

    runMigrateSettings(newMigrator(projectDir));

    const names = readBashHookFilenames();
    for (const expected of EXPECTED) {
      expect(names).toContain(expected);
    }
    // slopcheck-guard is also ensured (its own block) — confirms we didn't break it
    expect(names).toContain('slopcheck-guard.js');
    // no duplicate dangerous-command-guard
    expect(names.filter((n) => n === 'dangerous-command-guard.sh')).toHaveLength(1);
  });

  it('is idempotent — re-running migrateSettings adds nothing new', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
        { type: 'command', command: 'bash ${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/dangerous-command-guard.sh "$TOOL_INPUT"', blocking: true },
      ] }] },
    }, null, 2));

    runMigrateSettings(newMigrator(projectDir));
    const after1 = readBashHookFilenames();
    const result2 = runMigrateSettings(newMigrator(projectDir));
    const after2 = readBashHookFilenames();

    expect(after2).toEqual(after1);
    expect(result2.upgraded.filter((u) => u.includes('dark-guardrail wiring'))).toHaveLength(0);
    // each guardrail present exactly once
    for (const expected of EXPECTED) {
      expect(after2.filter((n) => n === expected)).toHaveLength(1);
    }
  });

  it('reports each newly-wired guardrail in the migration result', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [] }] },
    }, null, 2));

    const result = runMigrateSettings(newMigrator(projectDir));
    const wired = result.upgraded.filter((u) => u.includes('dark-guardrail wiring'));
    expect(wired.some((u) => u.includes('deferral-detector.js'))).toBe(true);
    expect(wired.some((u) => u.includes('grounding-before-messaging.sh'))).toBe(true);
  });
});
