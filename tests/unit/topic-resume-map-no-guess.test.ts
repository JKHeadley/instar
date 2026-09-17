/**
 * Resume Follows the Account §3.3 — the topic resume pointer never guesses.
 * Both sides of each decision: guessed legacy entries ignored vs hook entries
 * honoured; pooled-login transcripts found vs genuinely missing; dead panes
 * skipped by the heartbeat vs running panes recorded. Hermetic temp HOME and a
 * scripted tmux stand-in.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TopicResumeMap } from '../../src/core/TopicResumeMap.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const UUID = '56f6396f-85ff-4e3a-8003-9ed6c3bf5ca2';
const PROJECT_DIR = '/Users/justin/Documents/Projects/sagemind';
const SLUG = PROJECT_DIR.replace(/[/.]/g, '-');

describe('TopicResumeMap — no guessing', () => {
  let home: string;
  let stateDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'trm-no-guess-'));
    stateDir = path.join(home, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    origHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = origHome;
    try { SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/topic-resume-map-no-guess.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  function transcriptIn(login: string): void {
    const dir = path.join(home, login, 'projects', SLUG);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${UUID}.jsonl`), '{"type":"user"}\n');
  }
  function tmuxPrinting(output: string, exit = 0): string {
    const script = path.join(home, `tmux-${output.replace(/[^0-9a-z]/gi, '_')}-${exit}.sh`);
    fs.writeFileSync(script, `#!/bin/bash\necho '${output}'\nexit ${exit}\n`);
    fs.chmodSync(script, 0o755);
    return script;
  }
  function writeEntry(provenance: 'hook' | 'mtime-fallback'): void {
    fs.writeFileSync(path.join(stateDir, 'topic-resume-map.json'), JSON.stringify({
      '32175': { uuid: UUID, savedAt: new Date().toISOString(), sessionName: 's', framework: 'claude-code', provenance },
    }));
  }

  it('ignores a pointer saved by the removed newest-file guess', () => {
    transcriptIn('.claude');
    writeEntry('mtime-fallback');
    expect(new TopicResumeMap(stateDir, PROJECT_DIR).get(32175)).toBeNull();
  });

  it('honours a hook-reported pointer', () => {
    transcriptIn('.claude');
    writeEntry('hook');
    expect(new TopicResumeMap(stateDir, PROJECT_DIR).get(32175)).toBe(UUID);
  });

  it('finds a transcript that lives under a pooled login folder', () => {
    transcriptIn('.claude-followme-sagemind-adriana');
    writeEntry('hook');
    const map = new TopicResumeMap(stateDir, PROJECT_DIR);
    expect(map.jsonlExistsPublic(UUID)).toBe(true);
    expect(map.get(32175)).toBe(UUID);
  });

  it('does not find a transcript that exists only under a different project folder', () => {
    const dir = path.join(home, '.claude-followme-sagemind-adriana', 'projects', '-some-other-project');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${UUID}.jsonl`), '{}\n');
    // Only the Claude layouts are under test; an unknown id may still be probed
    // against the Codex/Gemini layouts, which hold nothing in this temp HOME.
    expect(new TopicResumeMap(stateDir, PROJECT_DIR).jsonlExistsPublic(UUID)).toBe(false);
  });

  it('heartbeat records a running pane with a hook-reported id', () => {
    transcriptIn('.claude-followme-sagemind-dawn');
    const map = new TopicResumeMap(stateDir, PROJECT_DIR, tmuxPrinting('%1||0'));
    map.refreshResumeMappings(new Map([[32175, { sessionName: 's', claudeSessionId: UUID }]]));
    expect(map.get(32175)).toBe(UUID);
  });

  it('heartbeat skips a dead pane', () => {
    transcriptIn('.claude-followme-sagemind-dawn');
    const map = new TopicResumeMap(stateDir, PROJECT_DIR, tmuxPrinting('%1||1'));
    map.refreshResumeMappings(new Map([[32175, { sessionName: 's', claudeSessionId: UUID }]]));
    expect(map.getEntryRaw(32175)).toBeNull();
  });

  it('heartbeat skips a session tmux reports as missing', () => {
    transcriptIn('.claude');
    const map = new TopicResumeMap(stateDir, PROJECT_DIR, tmuxPrinting('', 1));
    map.refreshResumeMappings(new Map([[32175, { sessionName: 's', claudeSessionId: UUID }]]));
    expect(map.getEntryRaw(32175)).toBeNull();
  });

  it('heartbeat skips a session tmux answers with empty fields (missing session, exit 0)', () => {
    transcriptIn('.claude');
    const map = new TopicResumeMap(stateDir, PROJECT_DIR, tmuxPrinting('||'));
    map.refreshResumeMappings(new Map([[32175, { sessionName: 's', claudeSessionId: UUID }]]));
    expect(map.getEntryRaw(32175)).toBeNull();
  });

  it('heartbeat never guesses when no id was reported, even with one active session', () => {
    transcriptIn('.claude');
    const map = new TopicResumeMap(stateDir, PROJECT_DIR, tmuxPrinting('%1||0'));
    map.refreshResumeMappings(new Map([[32175, { sessionName: 's' }]]));
    expect(map.getEntryRaw(32175)).toBeNull();
  });
});
