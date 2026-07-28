/**
 * Unit test for ensureResumeTranscriptInConfigHome (account-swap continuity).
 * Claude stores conversation transcripts per config home, so a quota swap must
 * copy the transcript into the new account's config home or `claude --resume`
 * finds nothing. This is the gap the live swap test caught (the mocked e2e
 * couldn't). Hermetic: a temp HOME with two fake config homes, no real claude.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureResumeTranscriptInConfigHome } from '../../src/core/SessionRefresh.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const UUID = 'fcbd48ba-348f-4831-965f-bf6646f9898c';
const PROJ = '-Users-justin--instar-agents-echo';

describe('ensureResumeTranscriptInConfigHome', () => {
  let home: string;
  let origHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-home-'));
    origHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = origHome;
    try { SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/session-refresh-account-swap-transcript.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  function writeTranscript(configHomeName: string) {
    const dir = path.join(home, configHomeName, 'projects', PROJ);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${UUID}.jsonl`), '{"type":"summary"}\n');
  }

  it('copies the transcript from the source config home into the target', () => {
    writeTranscript('.claude-echo-sagemind'); // source account has the conversation
    const targetHome = path.join(home, '.claude-echo-justin-gmail');
    expect(ensureResumeTranscriptInConfigHome(UUID, targetHome)).toBe(true);
    expect(fs.existsSync(path.join(targetHome, 'projects', PROJ, `${UUID}.jsonl`))).toBe(true);
  });

  it('is a no-op when the transcript is already in the target', () => {
    writeTranscript('.claude-echo-justin-gmail'); // already there
    const targetHome = path.join(home, '.claude-echo-justin-gmail');
    expect(ensureResumeTranscriptInConfigHome(UUID, targetHome)).toBe(true);
  });

  it('returns false when the transcript exists nowhere', () => {
    const targetHome = path.join(home, '.claude-echo-justin-gmail');
    expect(ensureResumeTranscriptInConfigHome(UUID, targetHome)).toBe(false);
  });

  it('finds the source under the default ~/.claude too', () => {
    writeTranscript('.claude'); // conversation ran under the default config home
    const targetHome = path.join(home, '.claude-echo-justin-gmail');
    expect(ensureResumeTranscriptInConfigHome(UUID, targetHome)).toBe(true);
    expect(fs.existsSync(path.join(targetHome, 'projects', PROJ, `${UUID}.jsonl`))).toBe(true);
  });

  it('preserves the project-dir relative path', () => {
    writeTranscript('.claude-echo-sagemind');
    const targetHome = path.join(home, '.claude-echo-justin-gmail');
    ensureResumeTranscriptInConfigHome(UUID, targetHome);
    // copied to the SAME projects/<projectDir>/ path, not flattened
    expect(fs.existsSync(path.join(targetHome, 'projects', PROJ, `${UUID}.jsonl`))).toBe(true);
  });
});
