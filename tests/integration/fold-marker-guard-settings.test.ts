// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.
/**
 * context-budget-layered-summaries §10 — the fold-marker tool policy through
 * the real update pipeline of an EXISTING agent: migrateSettings adds the `*`
 * PreToolUse entry once (idempotent, operator hooks kept) and migrateHooks
 * writes the hook file (always overwritten, so a stale copy is replaced). Then
 * the INSTALLED hook, run with the command string from the migrated settings,
 * denies a write for a session the real writer marked and allows it once the
 * fold's carrier releases the marker.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { writeFoldMarker, foldMarkerCarrier } from '../../src/monitoring/foldMarker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/integration/fold-marker-guard-settings.test.ts';
type Entry = { matcher?: string; hooks: Array<{ type?: string; command?: string; timeout?: number; blocking?: boolean }> };

describe('fold-marker guard — existing-agent update pipeline', () => {
  let home: string;
  let stateDir: string;
  let settingsPath: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'fmg-settings-'));
    stateDir = path.join(home, '.instar');
    fs.mkdirSync(path.join(stateDir, 'hooks', 'instar'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 4321 }));
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    settingsPath = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo operator-own' }] },
    ] } }));
    // A stale copy from an older release must be replaced (always-overwrite).
    fs.writeFileSync(path.join(stateDir, 'hooks', 'instar', 'fold-marker-guard.js'), '// stale');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: OP }));

  const migrator = () => new PostUpdateMigrator({ projectDir: home, stateDir, port: 4321, hasTelegram: false, projectName: 't' });
  const run = (method: 'migrateSettings' | 'migrateHooks') => {
    const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
    (migrator() as unknown as Record<string, (r: typeof result) => void>)[method](result);
    return result;
  };
  const wildcardFold = (): Entry['hooks'] => {
    const pre: Entry[] = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).hooks.PreToolUse;
    return (pre.find((e) => e.matcher === '*')?.hooks ?? []).filter((h) => h.command?.includes('fold-marker-guard.js'));
  };

  it('adds exactly one blocking `*` entry, keeps the operator hook, and is idempotent', () => {
    run('migrateSettings');
    run('migrateSettings');
    expect(wildcardFold()).toEqual([{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/fold-marker-guard.js"', blocking: true, timeout: 2000 }]);
    const pre: Entry[] = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).hooks.PreToolUse;
    expect(pre.some((e) => e.hooks.some((h) => h.command === 'echo operator-own'))).toBe(true);
  });

  it('migrateHooks replaces a stale hook copy with the current one', () => {
    const r = run('migrateHooks');
    expect(r.errors.filter((e) => e.includes('fold-marker'))).toEqual([]);
    const installed = fs.readFileSync(path.join(stateDir, 'hooks', 'instar', 'fold-marker-guard.js'), 'utf-8');
    expect(installed).toBe(migrator().getHookContent('fold-marker-guard'));
  });

  it('the installed hook, invoked by the migrated settings command, enforces a real marker and lets go on release', async () => {
    run('migrateSettings');
    run('migrateHooks');
    const cmd = wildcardFold()[0].command!.replace('${CLAUDE_PROJECT_DIR}', home);
    const hookFile = /^node "(.+)"$/.exec(cmd)![1];
    const call = (tool: string) => new Promise<boolean>((resolve) => {
      const child = execFile('node', [hookFile], {
        env: { PATH: process.env.PATH ?? '', CLAUDE_PROJECT_DIR: home, INSTAR_AGENT_HOME: home, INSTAR_SESSION_ID: 'inst_cand' },
        encoding: 'utf-8', timeout: 15_000,
      }, (_e, stdout) => resolve(!!stdout.trim() && JSON.parse(stdout).hookSpecificOutput?.permissionDecision === 'deny'));
      child.stdin?.end(JSON.stringify({ tool_name: tool }));
    });
    expect(await call('Write')).toBe(false); // no marker yet
    expect(writeFoldMarker(stateDir, { instarSessionId: 'inst_cand', foldId: 'fold9', topicKey: '141133', expiresAt: Date.now() + 600_000 })).not.toBeNull();
    expect(await call('Write')).toBe(true);
    foldMarkerCarrier(stateDir).release('141133', 'fold9');
    expect(await call('Write')).toBe(false);
  });
});
