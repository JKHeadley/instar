// safe-git-allow: test-tmpdir-cleanup — afterEach removes per-test mkdtempSync tmpdir.
/**
 * Autonomous stop hook — codex dark-launch gate (#28).
 *
 * The shared autonomous-stop-hook.sh is registered into BOTH Claude's settings.json
 * (no args) and codex's .codex/hooks.json (`… --codex`). Under codex it must self-gate
 * on autonomousSessions.codexLoopDriver.enabled so the codex loop driver ships DARK:
 *   - flag absent/false → exit 0 (approve), even with an ACTIVE autonomous job → no loop
 *   - flag true         → behaves like Claude (blocks to feed the task list back)
 *   - NO --codex (Claude path) → unaffected by the flag (blocks on an active job)
 *
 * These three cover both sides of the gate boundary + prove the Claude path is untouched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOOK_PATH = path.join(process.cwd(), '.claude', 'skills', 'autonomous', 'hooks', 'autonomous-stop-hook.sh');

let homeDir: string;

function writeActiveJob(topic: string, tmuxSession: string): void {
  fs.mkdirSync(path.join(homeDir, '.instar', 'autonomous'), { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, '.instar', 'topic-session-registry.json'),
    JSON.stringify({ topicToSession: { [topic]: tmuxSession } }),
  );
  fs.writeFileSync(
    path.join(homeDir, '.instar', 'autonomous', `${topic}.local.md`),
    `---\nactive: true\nsession_id: ""\nreport_topic: "${topic}"\niteration: 1\nduration_seconds: 0\ncompletion_promise: "ALL_DONE"\n---\n\n## Tasks\nKeep building until done.\n`,
  );
}

function writeConfig(codexLoopEnabled: boolean | undefined): void {
  const cfg: Record<string, unknown> = { port: 4040 };
  if (codexLoopEnabled !== undefined) {
    cfg.autonomousSessions = { codexLoopDriver: { enabled: codexLoopEnabled } };
  }
  fs.writeFileSync(path.join(homeDir, '.instar', 'config.json'), JSON.stringify(cfg));
}

function runHook(opts: { codex: boolean; tmuxSession: string }): { exitCode: number; decision: string | null } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    INSTAR_HOOK_TMUX_SESSION: opts.tmuxSession,
    CLAUDE_PROJECT_DIR: homeDir, // anchor to the test home (prod codex uses the $0 fallback)
  };
  const args = opts.codex ? [HOOK_PATH, '--codex'] : [HOOK_PATH];
  let stdout = '';
  let exitCode = 0;
  try {
    stdout = execFileSync('bash', args, {
      cwd: homeDir,
      input: JSON.stringify({ session_id: 'sess', transcript_path: '' }),
      env,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    exitCode = err.status ?? 1;
    stdout = err.stdout?.toString() ?? '';
  }
  let decision: string | null = null;
  try {
    decision = JSON.parse(stdout.trim()).decision ?? null;
  } catch {
    decision = null;
  }
  return { exitCode, decision };
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-codexgate-'));
});
afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('autonomous stop hook — codex dark-launch gate (#28)', () => {
  it('DARK by default: --codex + flag absent → approves (exit 0) even with an active job', () => {
    writeActiveJob('13435', 'echo-codey');
    writeConfig(undefined); // no codexLoopDriver key at all
    const r = runHook({ codex: true, tmuxSession: 'echo-codey' });
    expect(r.decision).toBeNull(); // no block → codex session is free to stop (dark)
    expect(r.exitCode).toBe(0);
  });

  it('DARK when explicitly disabled: --codex + enabled:false → approves', () => {
    writeActiveJob('13435', 'echo-codey');
    writeConfig(false);
    const r = runHook({ codex: true, tmuxSession: 'echo-codey' });
    expect(r.decision).toBeNull();
    expect(r.exitCode).toBe(0);
  });

  it('ENABLED: --codex + enabled:true → blocks (feeds the task list back, like Claude)', () => {
    writeActiveJob('13435', 'echo-codey');
    writeConfig(true);
    const r = runHook({ codex: true, tmuxSession: 'echo-codey' });
    expect(r.decision).toBe('block');
  });

  it('Claude path UNAFFECTED: no --codex → blocks on an active job regardless of the flag', () => {
    writeActiveJob('13435', 'echo-codey');
    writeConfig(false); // flag off must NOT suppress the Claude loop
    const r = runHook({ codex: false, tmuxSession: 'echo-codey' });
    expect(r.decision).toBe('block');
  });
});
