// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRolloutFileSync } from '../../src/providers/adapters/openai-codex/observability/sessionPaths.js';
import { TopicResumeMap } from '../../src/core/TopicResumeMap.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/**
 * Unit coverage for findRolloutFileSync — the sync codex rollout lookup behind
 * the codex-compat resume fix (jsonlExists must see codex sessions, which live
 * at $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl, not the Claude
 * flat layout). Both sides of the boundary: present → path, absent/no-home → null.
 */
describe('findRolloutFileSync', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/codexRolloutFileSync.test.ts:cleanup' });
  });

  function writeRollout(uuid: string, ymd = ['2026', '05', '30']): string {
    const dir = path.join(home, 'sessions', ...ymd);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-05-30T12-00-00-${uuid}.jsonl`);
    fs.writeFileSync(file, '{"type":"thread.started"}\n');
    return file;
  }

  it('finds a rollout file by uuid in the date-partitioned tree', () => {
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const expected = writeRollout(uuid);
    expect(findRolloutFileSync(uuid, home)).toBe(expected);
  });

  it('returns null when no rollout matches the uuid', () => {
    writeRollout('some-other-uuid');
    expect(findRolloutFileSync('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', home)).toBeNull();
  });

  it('returns null fast when $CODEX_HOME/sessions does not exist (pure Claude agent)', () => {
    // home exists but has no sessions/ dir.
    expect(findRolloutFileSync('any-uuid', home)).toBeNull();
  });

  it('returns null for an empty uuid', () => {
    writeRollout('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(findRolloutFileSync('', home)).toBeNull();
  });

  it('does not match a non-rollout file that happens to contain the uuid', () => {
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const dir = path.join(home, 'sessions', '2026', '05', '30');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `notes-${uuid}.txt`), 'x'); // not rollout-*.jsonl
    expect(findRolloutFileSync(uuid, home)).toBeNull();
  });

  it('finds a rollout nested under any date partition', () => {
    const uuid = '11112222-3333-4444-5555-666677778888';
    const expected = writeRollout(uuid, ['2026', '04', '01']);
    expect(findRolloutFileSync(uuid, home)).toBe(expected);
  });
});

/**
 * The actual codex-compat fix boundary: TopicResumeMap.jsonlExists must return
 * true for a codex session (rollout file present), where before it returned
 * false (claude-only) and resume broke for every codex agent.
 */
describe('TopicResumeMap.jsonlExists — codex rollout branch', () => {
  let tmpDir: string;
  let fakeHome: string;
  let priorHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-resume-'));
    fakeHome = path.join(tmpDir, 'home');
    fs.mkdirSync(fakeHome, { recursive: true });
    // jsonlExists' codex branch resolves $CODEX_HOME via os.homedir()/.codex,
    // and os.homedir() reads $HOME on POSIX — point it at the fixture home.
    priorHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/codexRolloutFileSync.test.ts:cleanup' });
  });

  it('returns true when only a codex rollout exists (no claude jsonl)', () => {
    const uuid = '99998888-7777-6666-5555-444433332222';
    const dir = path.join(fakeHome, '.codex', 'sessions', '2026', '05', '30');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `rollout-2026-05-30T01-02-03-${uuid}.jsonl`), '{"type":"turn.started"}\n');

    const stateDir = path.join(tmpDir, 'state');
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    const resumeMap = new TopicResumeMap(stateDir, projectDir);

    expect(resumeMap.jsonlExistsPublic(uuid)).toBe(true);
    expect(resumeMap.jsonlExistsPublic('deadbeef-dead-beef-dead-beefdeadbeef')).toBe(false);
  });
});
