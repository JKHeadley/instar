/**
 * Verifies FrameworkSessionStore (portability audit Gap 3). The Codex layout
 * here is the EMPIRICALLY-verified one from a live ~/.codex/ (Codex CLI
 * 0.78.0): ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl. The
 * Claude path must reproduce the exact prior PreCompactionFlush convention
 * (cwd with both `/` and `.` replaced by `-`), which was empirically
 * confirmed against the real ~/.claude/projects/ directory naming.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveFrameworkTranscriptPath } from '../../src/core/FrameworkSessionStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('FrameworkSessionStore', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-fss-'));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmp, {
      recursive: true,
      force: true,
      operation: 'tests/unit/FrameworkSessionStore.test.ts',
    });
  });

  it('returns "" when sessionId is empty', () => {
    expect(
      resolveFrameworkTranscriptPath({
        framework: 'claude-code',
        sessionId: '',
        projectDir: '/x',
      }),
    ).toBe('');
  });

  it('claude-code: encodes BOTH slashes and dots in the cwd (real convention)', () => {
    const p = resolveFrameworkTranscriptPath({
      framework: 'claude-code',
      sessionId: 'abc-123',
      projectDir: '/Users/justin/.instar/agents/echo',
      rootOverride: '/root',
    });
    // .instar → -instar, and the leading /. produces a double dash —
    // matches the real ~/.claude/projects/-Users-justin--instar-agents-echo
    expect(p).toBe('/root/-Users-justin--instar-agents-echo/abc-123.jsonl');
  });

  it('claude-code: defaults root to ~/.claude/projects', () => {
    const p = resolveFrameworkTranscriptPath({
      framework: 'claude-code',
      sessionId: 's1',
      projectDir: '/p',
      homeDir: '/home/u',
    });
    expect(p).toBe(path.join('/home/u', '.claude', 'projects', '-p', 's1.jsonl'));
  });

  it('codex-cli: globs sessions/YYYY/MM/DD/rollout-*-<uuid>.jsonl', () => {
    const uuid = '019e2dcb-61d1-7172-a68c-da60f529db54';
    const dayDir = path.join(tmp, 'sessions', '2026', '05', '15');
    fs.mkdirSync(dayDir, { recursive: true });
    const file = path.join(dayDir, `rollout-2026-05-15T15-39-24-${uuid}.jsonl`);
    fs.writeFileSync(file, '{"type":"session_meta"}\n');
    // a decoy that must NOT match
    fs.writeFileSync(path.join(dayDir, 'rollout-2026-05-15T00-00-00-other.jsonl'), '');

    const p = resolveFrameworkTranscriptPath({
      framework: 'codex-cli',
      sessionId: uuid,
      projectDir: '/irrelevant-for-codex',
      rootOverride: path.join(tmp, 'sessions'),
    });
    expect(p).toBe(file);
  });

  it('codex-cli: returns "" when no matching session file exists', () => {
    fs.mkdirSync(path.join(tmp, 'sessions', '2026', '05', '15'), { recursive: true });
    const p = resolveFrameworkTranscriptPath({
      framework: 'codex-cli',
      sessionId: 'missing-uuid',
      projectDir: '/x',
      rootOverride: path.join(tmp, 'sessions'),
    });
    expect(p).toBe('');
  });

  it('codex-cli: returns "" when the sessions root does not exist', () => {
    const p = resolveFrameworkTranscriptPath({
      framework: 'codex-cli',
      sessionId: 'u',
      projectDir: '/x',
      rootOverride: path.join(tmp, 'does-not-exist'),
    });
    expect(p).toBe('');
  });

  it('unknown framework falls back to the claude-code resolver', () => {
    const p = resolveFrameworkTranscriptPath({
      // @ts-expect-error — exercising the defensive default branch with a
      // genuinely-unknown framework value (gemini-cli is now a real framework
      // with its own resolver, so it is no longer the "unknown" placeholder).
      framework: 'aider-cli',
      sessionId: 's',
      projectDir: '/p',
      homeDir: '/h',
    });
    expect(p).toBe(path.join('/h', '.claude', 'projects', '-p', 's.jsonl'));
  });

  it('gemini-cli routes to the gemini resolver (no fixture → empty)', () => {
    // gemini-cli is now a real framework: it resolves through the gemini
    // sessionPaths helper under <home>/.gemini/tmp/**, NOT the claude tree.
    // With no fixture present it returns '' (a safe no-op), proving it does
    // NOT fall through to the claude path.
    const p = resolveFrameworkTranscriptPath({
      framework: 'gemini-cli',
      sessionId: 's',
      projectDir: '/p',
      homeDir: '/nonexistent-home-for-test',
    });
    expect(p).toBe('');
  });
});
