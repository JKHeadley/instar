/**
 * context-budget-layered-summaries §9.1 — the session-start hook routes on the
 * "source" field Claude Code passes in its stdin JSON. Claude Code never sets
 * CLAUDE_HOOK_MATCHER, so the old env-only read resolved every event to
 * "startup" and compaction recovery never ran.
 *
 * Both sides of each decision boundary, against the rendered hook:
 *   - stdin source "compact" ⇒ delegates to compaction-recovery.sh
 *   - stdin source "startup" ⇒ startup orientation
 *   - no stdin, legacy CLAUDE_HOOK_MATCHER=compact ⇒ still delegates
 *   - non-Claude engine (INSTAR_FRAMEWORK=codex-cli) ⇒ today's branch (env only)
 *   - switch off (contextBudget.compactionRecovery.enabled=false) ⇒ today's branch
 *   - an open pipe that never closes ⇒ the hook is bounded and still starts
 *   - a successful compact seed writes the seeded marker (one carrier, §9.1);
 *     a failed or empty seed, the switch off, or a non-Claude engine writes none
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let projectDir: string;
let hookPath: string;

function writeConfig(extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(projectDir, '.instar', 'config.json'), JSON.stringify({ port: 1, ...extra }));
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-source-'));
  const hooksDir = path.join(projectDir, '.instar', 'hooks', 'instar');
  fs.mkdirSync(hooksDir, { recursive: true });
  writeConfig();
  fs.writeFileSync(path.join(hooksDir, 'compaction-recovery.sh'), '#!/bin/bash\necho RECOVERY_RAN\n', { mode: 0o755 });
  const migrator = new PostUpdateMigrator({ stateDir: path.join(projectDir, '.instar'), port: 1, sessions: { claudePath: 'claude' } } as never);
  hookPath = path.join(hooksDir, 'session-start.sh');
  fs.writeFileSync(hookPath, (migrator as unknown as { getHookContent(n: string): string }).getHookContent('session-start'), { mode: 0o755 });
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/session-start-source-routing.test.ts' });
});

function run(input: string | null, env: Record<string, string> = {}): string {
  const r = spawnSync('bash', [hookPath], {
    input: input ?? '',
    env: { PATH: process.env.PATH ?? '', HOME: projectDir, CLAUDE_PROJECT_DIR: projectDir, ...env },
    timeout: 20_000,
  });
  return r.stdout.toString('utf-8');
}

describe('session-start hook routes on the stdin source (§9.1)', () => {
  it('delegates to compaction recovery when Claude Code sends source "compact"', () => {
    expect(run('{"source":"compact"}')).toContain('RECOVERY_RAN');
  });

  it('gives the startup orientation when source is "startup"', () => {
    const out = run('{"source":"startup"}');
    expect(out).toContain('=== SESSION START ===');
    expect(out).not.toContain('RECOVERY_RAN');
  });

  it('keeps the legacy CLAUDE_HOOK_MATCHER fallback when stdin carries no source', () => {
    expect(run('', { CLAUDE_HOOK_MATCHER: 'compact' })).toContain('RECOVERY_RAN');
  });

  it('treats a Claude Code start with no readable source as startup (unknown), never compaction', () => {
    const out = run('not json');
    expect(out).toContain('=== SESSION START ===');
    expect(out).not.toContain('RECOVERY_RAN');
  });

  it('leaves non-Claude engines on the old env-only branch', () => {
    const out = run('{"source":"compact"}', { INSTAR_FRAMEWORK: 'codex-cli' });
    expect(out).toContain('=== SESSION START ===');
    expect(out).not.toContain('RECOVERY_RAN');
  });

  it('with the switch off, behaves exactly as before (stdin ignored)', () => {
    writeConfig({ contextBudget: { compactionRecovery: { enabled: false } } });
    const out = run('{"source":"compact"}');
    expect(out).toContain('=== SESSION START ===');
    expect(out).not.toContain('RECOVERY_RAN');
  });

  it('honours the switch in the agent home config for a worktree session (no config in the project dir)', () => {
    const agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-home-'));
    fs.mkdirSync(path.join(agentHome, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(agentHome, '.instar', 'config.json'), JSON.stringify({ contextBudget: { compactionRecovery: { enabled: false } } }));
    SafeFsExecutor.safeRmSync(path.join(projectDir, '.instar', 'config.json'), { force: true, operation: 'tests/unit/session-start-source-routing.test.ts' });
    try {
      const out = run('{"source":"compact"}', { INSTAR_AGENT_HOME: agentHome });
      expect(out).not.toContain('RECOVERY_RAN');
    } finally {
      SafeFsExecutor.safeRmSync(agentHome, { recursive: true, force: true, operation: 'tests/unit/session-start-source-routing.test.ts' });
    }
  });

  it('is bounded when stdin is an open pipe that never closes', async () => {
    const started = Date.now();
    const out = await new Promise<string>((resolve) => {
      const child = spawn('bash', [hookPath], {
        env: { PATH: process.env.PATH ?? '', HOME: projectDir, CLAUDE_PROJECT_DIR: projectDir },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let buf = '';
      child.stdout.on('data', (d) => { buf += d.toString('utf-8'); });
      child.on('close', () => resolve(buf));
      // never write, never end stdin until after the hook should be done
      setTimeout(() => child.stdin.end(), 15_000);
    });
    expect(out).toContain('=== SESSION START ===');
    expect(Date.now() - started).toBeLessThan(14_000);
  }, 20_000);
});

describe('seeded marker after the compact seed (§9.1 one carrier)', () => {
  const SID = 'abcd-1234';
  const markerFile = () => path.join(projectDir, '.instar', 'state', 'context-layers', '_seeded', `${SID}.json`);
  const recovery = (body: string) =>
    fs.writeFileSync(path.join(projectDir, '.instar', 'hooks', 'instar', 'compaction-recovery.sh'), `#!/bin/bash\n${body}\n`, { mode: 0o755 });

  it('writes the marker after a successful seed, epoch left for the server to bind', () => {
    const transcript = path.join(projectDir, 't.jsonl');
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'user', uuid: 'u0' }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid: 'boundary-9' }),
      '',
    ].join('\n'));
    const out = run(JSON.stringify({ source: 'compact', session_id: SID, transcript_path: transcript }));
    expect(out).toContain('RECOVERY_RAN');
    const m = JSON.parse(fs.readFileSync(markerFile(), 'utf-8'));
    // The boundary visible at hook time is the PREVIOUS compaction's (Claude Code
    // flushes the current one after the hook), so the hook never stamps it.
    expect(m).toMatchObject({ sessionId: SID, epoch: '', source: 'compact' });
    expect(typeof m.seededAt).toBe('number');
    expect(fs.statSync(markerFile()).mode & 0o777).toBe(0o600);
  });

  it('writes no marker when the seed fails', () => {
    recovery('echo PARTIAL\nexit 3');
    const out = run(JSON.stringify({ source: 'compact', session_id: SID }));
    expect(out).toContain('PARTIAL');
    expect(fs.existsSync(markerFile())).toBe(false);
  });

  it('writes no marker when the seed prints nothing', () => {
    recovery('true');
    run(JSON.stringify({ source: 'compact', session_id: SID }));
    expect(fs.existsSync(markerFile())).toBe(false);
  });

  it('refuses a session id that could escape the marker directory', () => {
    run(JSON.stringify({ source: 'compact', session_id: '../../evil' }));
    expect(fs.existsSync(path.join(projectDir, '.instar', 'state', 'context-layers', '_seeded'))).toBe(false);
  });

  it('writes no marker with the switch off', () => {
    writeConfig({ contextBudget: { compactionRecovery: { enabled: false } } });
    run(JSON.stringify({ source: 'compact', session_id: SID }), { CLAUDE_HOOK_MATCHER: 'compact' });
    expect(fs.existsSync(markerFile())).toBe(false);
  });

  it('writes the marker under the agent home for a worktree session', () => {
    const agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-home-'));
    fs.mkdirSync(path.join(agentHome, '.instar'), { recursive: true });
    try {
      run(JSON.stringify({ source: 'compact', session_id: SID }), { INSTAR_AGENT_HOME: agentHome });
      expect(fs.existsSync(path.join(agentHome, '.instar', 'state', 'context-layers', '_seeded', `${SID}.json`))).toBe(true);
      expect(fs.existsSync(markerFile())).toBe(false);
    } finally {
      SafeFsExecutor.safeRmSync(agentHome, { recursive: true, force: true, operation: 'tests/unit/session-start-source-routing.test.ts' });
    }
  });
});
