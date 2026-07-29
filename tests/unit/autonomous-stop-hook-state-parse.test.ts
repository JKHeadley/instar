// safe-git-allow: test-tmpdir-cleanup — afterEach removes only its mkdtempSync directory.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listAutonomousJobs } from '../../src/core/AutonomousSessions.js';

const HOOK_PATH = path.join(
  process.cwd(),
  '.claude',
  'skills',
  'autonomous',
  'hooks',
  'autonomous-stop-hook.sh',
);

let homeDir: string;

function writeRegistry(): void {
  fs.writeFileSync(
    path.join(homeDir, '.instar', 'topic-session-registry.json'),
    JSON.stringify({ topicToSession: { '458': 'echo-parse-test' } }),
  );
}

function writeTopicState(content: string): void {
  const dir = path.join(homeDir, '.instar', 'autonomous');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '458.local.md'), content);
}

function runHook(codex = false): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync('bash', codex ? [HOOK_PATH, '--codex'] : [HOOK_PATH], {
    cwd: homeDir,
    input: JSON.stringify({ session_id: 'parse-test-session', transcript_path: '' }),
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: homeDir,
      INSTAR_HOOK_TMUX_SESSION: 'echo-parse-test',
      INSTAR_HOOK_BACKOFF_DISABLE: '1',
    },
    encoding: 'utf8',
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-hook-state-parse-'));
  fs.mkdirSync(path.join(homeDir, '.instar'), { recursive: true });
  writeRegistry();
});

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe('autonomous stop hook state parsing', () => {
  it('allows a genuinely absent autonomous state file without noise', () => {
    const result = runHook();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('fails visibly when the selected state file exists but has no frontmatter fences', () => {
    writeTopicState(`active: true
iteration: 1
session_id: "parse-test-session"
report_topic: "458"
duration_seconds: 79200
started_at: "2026-07-28T00:00:00Z"

Keep working.
`);

    const statusReader = listAutonomousJobs(path.join(homeDir, '.instar'));
    expect(statusReader).toHaveLength(1);
    expect(statusReader[0]).toMatchObject({ topic: '458', active: true });

    const result = runHook();

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/autonomous state exists but its frontmatter is unparseable/i);
    expect(result.stderr).toMatch(/458\.local\.md/);
  });

  it('fails visibly when a fenced state omits the required active field', () => {
    writeTopicState(`---
iteration: 1
session_id: "parse-test-session"
report_topic: "458"
---

Keep working.
`);

    const result = runHook();

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/autonomous state exists but its frontmatter is unparseable/i);
  });

  it('keeps Codex stdout protocol-clean while failing visibly on the same corrupt state', () => {
    fs.writeFileSync(
      path.join(homeDir, '.instar', 'config.json'),
      JSON.stringify({ autonomousSessions: { codexLoopDriver: { enabled: true } } }),
    );
    writeTopicState(`active: true
report_topic: "458"
`);

    const result = runHook(true);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/autonomous state exists but its frontmatter is unparseable/i);
  });

  it('keeps a valid fenced inactive state as a clean allow', () => {
    writeTopicState(`---
active: false
iteration: 1
session_id: "parse-test-session"
report_topic: "458"
---

Stopped.
`);

    const result = runHook();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });
});
