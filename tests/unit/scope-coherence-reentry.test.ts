/**
 * Unit test — scope-coherence-checkpoint re-entry guard (codex-full-parity §7 C3).
 *
 * The Stop hook must approve immediately on a correction continuation
 * (stop_hook_active=true) — never re-block — so a block→continue→block loop can't
 * wedge an autonomous Codex/Claude session. Renders the hook from its
 * PostUpdateMigrator source-of-truth and drives it with stdin payloads.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmpDir: string;
let hookPath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-reentry-test-'));
  hookPath = path.join(tmpDir, 'scope-coherence-checkpoint.js');
  const migrator = new PostUpdateMigrator({
    projectDir: tmpDir,
    stateDir: path.join(tmpDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'scope-reentry-test',
  });
  const hookContent = (
    migrator as unknown as { getHookContent(name: string): string }
  ).getHookContent('scope-coherence-checkpoint');
  fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
});

afterAll(() => {
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/scope-coherence-reentry.test.ts:afterAll' });
});

function run(payload: object): { exitCode: number; stdout: string; decision?: string } {
  // Run from a clean cwd with no INSTAR_SESSION_ID so the headless short-circuit
  // doesn't mask the re-entry guard we're testing.
  const res = spawnSync('node', [hookPath], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    timeout: 5000,
    cwd: tmpDir,
    env: { ...process.env, INSTAR_SESSION_ID: '', TERM_PROGRAM: 'iTerm.app' },
  });
  const stdout = (res.stdout || '').trim();
  let decision: string | undefined;
  try { decision = JSON.parse(stdout).decision; } catch { /* no json */ }
  return { exitCode: res.status ?? -1, stdout, decision };
}

describe('scope-coherence-checkpoint — re-entry guard (C3) + codex stdout-safety', () => {
  it('allows immediately on a correction continuation (stop_hook_active=true) with EMPTY stdout', () => {
    const r = run({ hook_event_name: 'Stop', stop_hook_active: true });
    expect(r.exitCode).toBe(0);
    // ALLOW is now signalled by empty stdout (codex-safe), NOT {decision:'approve'}.
    expect(r.stdout).toBe('');
    expect(r.decision).toBeUndefined();
  });

  it('allows a fresh Stop below the depth threshold with EMPTY stdout (codex-safe allow path)', () => {
    const r = run({ hook_event_name: 'Stop', stop_hook_active: false });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(''); // no state file => depth 0 => allow => empty
    expect(r.decision).toBeUndefined();
  });

  it('the generated hook emits NO {decision:"approve"} on stdout but DOES keep the block path (codex Stop-hook contract: empty=allow, block-JSON=block)', () => {
    const src = fs.readFileSync(hookPath, 'utf-8');
    // No approve-JSON anywhere — codex rejects it as "invalid stop hook JSON output".
    expect(src).not.toContain("decision: 'approve'");
    expect(src).not.toContain('decision: "approve"');
    // The scope-checkpoint BLOCK path is preserved (codex accepts block decisions).
    expect(src).toContain("decision: 'block'");
  });
});
