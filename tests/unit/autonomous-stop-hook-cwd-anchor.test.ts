// safe-git-allow: test-tmpdir-cleanup — afterEach removes per-test mkdtempSync tmpdir.
/**
 * Autonomous stop hook — CWD anchoring (regression test).
 *
 * Root cause of the 2026-05-29 strand: the hook resolves its state via paths
 * relative to the process CWD (.instar/autonomous/<topic>.local.md). When the
 * Stop hook fired with the shell sitting in a git WORKTREE (a session doing
 * instar-dev work in ~/.instar/agents/<name>/.worktrees/<slug>), those paths
 * resolved against the worktree — which has no autonomous state — so the hook
 * saw "no active job" and let the session EXIT, silently stranding the loop.
 *
 * The fix: anchor to CLAUDE_PROJECT_DIR (the agent home; Claude Code always sets
 * it for hooks) before resolving relative state paths. These tests run the hook
 * from a DIFFERENT cwd than where the state lives and assert it still finds the
 * job when CLAUDE_PROJECT_DIR points at the agent home.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOOK_PATH = path.join(process.cwd(), '.claude', 'skills', 'autonomous', 'hooks', 'autonomous-stop-hook.sh');

let homeDir: string; // simulates the agent home (where state lives)
let elsewhereDir: string; // simulates a worktree CWD (no state)

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

function runHook(opts: { cwd: string; projectDir?: string; tmuxSession: string }): {
  exitCode: number;
  decision: string | null;
} {
  const env: NodeJS.ProcessEnv = { ...process.env, INSTAR_HOOK_TMUX_SESSION: opts.tmuxSession };
  if (opts.projectDir) env.CLAUDE_PROJECT_DIR = opts.projectDir;
  else delete env.CLAUDE_PROJECT_DIR;
  let stdout = '';
  let exitCode = 0;
  try {
    stdout = execFileSync('bash', [HOOK_PATH], {
      cwd: opts.cwd,
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
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-anchor-home-'));
  elsewhereDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-anchor-elsewhere-'));
});
afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true });
  fs.rmSync(elsewhereDir, { recursive: true, force: true });
});

describe('autonomous stop hook — CWD anchoring (§2026-05-29 strand fix)', () => {
  it('BLOCKS when run from a different CWD but CLAUDE_PROJECT_DIR points at the agent home', () => {
    // State lives in homeDir; the hook runs with CWD=elsewhere (a worktree) +
    // CLAUDE_PROJECT_DIR=homeDir. The fix anchors to CLAUDE_PROJECT_DIR → finds the job.
    writeActiveJob('13481', 'echo-instar-exo');
    const r = runHook({ cwd: elsewhereDir, projectDir: homeDir, tmuxSession: 'echo-instar-exo' });
    expect(r.decision).toBe('block'); // the loop will relaunch — NOT stranded
  });

  it('reproduces the strand WITHOUT the anchor: different CWD + no CLAUDE_PROJECT_DIR → no block', () => {
    // The pre-fix failure mode: CWD=elsewhere (no state), no anchor → "no job" → exit.
    // (In production CLAUDE_PROJECT_DIR is ALWAYS set, so this path can't happen there;
    // the test documents that the anchor is what closes the gap.)
    writeActiveJob('13481', 'echo-instar-exo');
    const r = runHook({ cwd: elsewhereDir, tmuxSession: 'echo-instar-exo' });
    expect(r.decision).toBeNull();
    expect(r.exitCode).toBe(0);
  });

  it('still BLOCKS when run from the agent home directly (in-CWD back-compat)', () => {
    writeActiveJob('13481', 'echo-instar-exo');
    const r = runHook({ cwd: homeDir, projectDir: homeDir, tmuxSession: 'echo-instar-exo' });
    expect(r.decision).toBe('block');
  });
});
