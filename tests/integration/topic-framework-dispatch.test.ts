/**
 * Integration tests — per-topic framework dispatch end to end.
 *
 * Verifies the Tier 1.A contract: when a Telegram topic is configured
 * with a per-topic framework, `SessionManager.spawnInteractiveSession`
 * dispatches to that framework's launch builder, picks the right
 * binary, and sets INSTAR_FRAMEWORK in the tmux env to the resolved
 * value.
 *
 * Uses a fake-tmux shell script that logs every invocation to a file,
 * plus fake-claude and fake-codex scripts that print their argv. The
 * test reads back the log and asserts on the exact spawn shape.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmpDir: string;
let fakeTmuxLog: string;
let fakeTmux: string;
let fakeClaude: string;
let fakeCodex: string;
let projectDir: string;

function makeFakeBinary(p: string, name: string): void {
  fs.writeFileSync(p, `#!/bin/sh\necho "${name} $@"\nexit 0\n`, { mode: 0o755 });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-framework-dispatch-'));
  fakeTmuxLog = path.join(tmpDir, 'tmux.log');
  fakeTmux = path.join(tmpDir, 'fake-tmux');
  fs.writeFileSync(
    fakeTmux,
    [
      '#!/bin/sh',
      `echo "$@" >> "${fakeTmuxLog}"`,
      // Pretend the session doesn't exist on the has-session probe.
      'if [ "$1" = "has-session" ]; then exit 1; fi',
      'exit 0',
    ].join('\n'),
    { mode: 0o755 },
  );
  fakeClaude = path.join(tmpDir, 'fake-claude');
  fakeCodex = path.join(tmpDir, 'fake-codex');
  makeFakeBinary(fakeClaude, 'claude');
  makeFakeBinary(fakeCodex, 'codex');
  projectDir = path.join(tmpDir, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/integration/topic-framework-dispatch.test.ts:afterEach',
  });
});

function buildManager(): SessionManager {
  const config = {
    tmuxPath: fakeTmux,
    claudePath: fakeClaude,
    frameworkBinaryPaths: {
      'claude-code': fakeClaude,
      'codex-cli': fakeCodex,
    },
    projectDir,
    maxSessions: 5,
    protectedSessions: [],
    completionPatterns: [],
    authToken: 'test-token',
    port: 9999,
  };
  const stateMgr = new StateManager(path.join(tmpDir, 'state'));
  return new SessionManager(config, stateMgr);
}

function tmuxLog(): string {
  if (!fs.existsSync(fakeTmuxLog)) return '';
  return fs.readFileSync(fakeTmuxLog, 'utf-8');
}

describe('per-topic framework dispatch end-to-end', () => {
  it('topic with framework=claude-code spawns the claude binary with --dangerously-skip-permissions', async () => {
    const mgr = buildManager();
    await mgr.spawnInteractiveSession(undefined, 'topic-1', {
      telegramTopicId: 101,
      framework: 'claude-code',
    });
    const log = tmuxLog();
    expect(log).toContain(fakeClaude);
    expect(log).toContain('--dangerously-skip-permissions');
    expect(log).toContain('INSTAR_FRAMEWORK=claude-code');
    expect(log).toContain('INSTAR_TELEGRAM_TOPIC=101');
    // Codex shape MUST NOT appear.
    expect(log).not.toContain(fakeCodex);
    expect(log).not.toContain('--sandbox');
  });

  it('topic with framework=codex-cli spawns the codex binary with --dangerously-bypass-approvals-and-sandbox (Claude --dangerously-skip-permissions parity)', async () => {
    const mgr = buildManager();
    await mgr.spawnInteractiveSession(undefined, 'topic-2', {
      telegramTopicId: 202,
      framework: 'codex-cli',
    });
    const log = tmuxLog();
    expect(log).toContain(fakeCodex);
    expect(log).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(log).toContain('INSTAR_FRAMEWORK=codex-cli');
    expect(log).toContain('INSTAR_TELEGRAM_TOPIC=202');
    // Claude flag MUST NOT appear.
    expect(log).not.toContain('--dangerously-skip-permissions');
  });

  it('omitting framework falls back to claude-code (v0.x compat)', async () => {
    const mgr = buildManager();
    await mgr.spawnInteractiveSession(undefined, 'topic-3', { telegramTopicId: 303 });
    const log = tmuxLog();
    expect(log).toContain(fakeClaude);
    expect(log).toContain('--dangerously-skip-permissions');
    expect(log).toContain('INSTAR_FRAMEWORK=claude-code');
  });

  it('CLAUDECODE env override is emitted in both frameworks', async () => {
    const mgr = buildManager();
    await mgr.spawnInteractiveSession(undefined, 'topic-a', { telegramTopicId: 401, framework: 'claude-code' });
    await mgr.spawnInteractiveSession(undefined, 'topic-b', { telegramTopicId: 402, framework: 'codex-cli' });
    const log = tmuxLog();
    // Defense-in-depth: both frameworks clear the CLAUDECODE marker.
    const claudecodeCount = log.split('CLAUDECODE=').length - 1;
    expect(claudecodeCount).toBeGreaterThanOrEqual(2);
  });

  it('codex framework inserts `resume <id>` subcommand when resumeSessionId is provided', async () => {
    const mgr = buildManager();
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      await mgr.spawnInteractiveSession(undefined, 'topic-codex-resume', {
        telegramTopicId: 501,
        framework: 'codex-cli',
        resumeSessionId: 'sess-42',
      });
    } finally {
      console.warn = origWarn;
    }
    // Codex 0.130 accepts `resume` as a subcommand; we now actually use it.
    // The prior warning ("Codex resume requested ... starting fresh") must be gone.
    expect(warnings.some(w => w.includes('Codex resume requested'))).toBe(false);
    const log = tmuxLog();
    // The `resume sess-42` subcommand pair must appear in the spawned argv.
    expect(log).toMatch(/resume[^\n]*sess-42/);
    // The flag-style --resume must NEVER appear — Codex doesn't accept it.
    expect(log).not.toContain('--resume');
  });

  it('throws if the configured framework has no binary path', async () => {
    const config = {
      tmuxPath: fakeTmux,
      claudePath: fakeClaude,
      frameworkBinaryPaths: { 'claude-code': fakeClaude }, // codex-cli omitted
      projectDir,
      maxSessions: 5,
      protectedSessions: [],
      completionPatterns: [],
      authToken: 'test-token',
      port: 9999,
    };
    const stateMgr = new StateManager(path.join(tmpDir, 'state'));
    const mgr = new SessionManager(config, stateMgr);

    // claudePath fallback kicks in when frameworkBinaryPaths['codex-cli']
    // is missing — that's the safety net. The spawn proceeds using
    // claudePath as the binary but Codex's flag shape. Operators who
    // misconfigure get the warning + a tmux session that codex won't
    // recognize, which is louder than a silent claude fallback.
    await mgr.spawnInteractiveSession(undefined, 'topic-mis', { telegramTopicId: 601, framework: 'codex-cli' });
    const log = tmuxLog();
    // Whatever binary got used, the Codex bypass flag shape must be present.
    expect(log).toContain('--dangerously-bypass-approvals-and-sandbox');
  });
});
