/**
 * placeCodexResumeRollout — the Codex half of Resume Follows the Account.
 *
 * `codex resume <thread>` only finds a conversation inside the CODEX_HOME it runs
 * under (codex 0.169.1, verified 2026-11-18: an empty home answers "no rollout found
 * for thread id"; the same home with the rollout copied in resumes). Real files in
 * temp homes; nothing is mocked.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { placeCodexResumeRollout } from '../../src/core/codexResumeRollout.js';
import { resetRolloutLookupState } from '../../src/providers/adapters/openai-codex/observability/sessionPaths.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const THREAD = '01a1ec1b-9cac-7ca2-8d15-95413fc95ba0';
const REL = path.join('sessions', '2026', '11', '17', `rollout-2026-11-17T16-43-15-${THREAD}.jsonl`);

let dir: string;
const home = (name: string) => path.join(dir, name);
function write(h: string, body: string, mtimeSec: number): string {
  const f = path.join(h, REL);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
  fs.utimesSync(f, mtimeSec, mtimeSec);
  return f;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-resume-place-'));
  resetRolloutLookupState();
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/codexResumeRollout.test.ts:cleanup' });
});

describe('placeCodexResumeRollout', () => {
  it('copies the conversation into an account home that lacks it, at the same dated path, leaving the source in place', async () => {
    write(home('default'), 'turns-1-2-3\n', 1_000);
    const r = await placeCodexResumeRollout(THREAD, home('headley'), [home('default')]);
    expect(r).toEqual({ outcome: 'copied', from: home('default') });
    expect(fs.readFileSync(path.join(home('headley'), REL), 'utf8')).toBe('turns-1-2-3\n');
    expect(fs.existsSync(path.join(home('default'), REL))).toBe(true);
  });

  it('takes the freshest copy among several homes', async () => {
    write(home('a'), 'old\n', 1_000);
    write(home('b'), 'newest\n', 3_000);
    write(home('c'), 'middle\n', 2_000);
    const r = await placeCodexResumeRollout(THREAD, home('target'), [home('a'), home('b'), home('c')]);
    expect(r.outcome).toBe('copied');
    expect(r.from).toBe(home('b'));
    expect(fs.readFileSync(path.join(home('target'), REL), 'utf8')).toBe('newest\n');
  });

  it('leaves the target alone when it already holds the freshest copy', async () => {
    write(home('default'), 'stale\n', 1_000);
    write(home('headley'), 'current\n', 2_000);
    const r = await placeCodexResumeRollout(THREAD, home('headley'), [home('default')]);
    expect(r.outcome).toBe('present');
    expect(fs.readFileSync(path.join(home('headley'), REL), 'utf8')).toBe('current\n');
  });

  it('replaces a stale copy in the target with the newer one and keeps the stale copy set aside, never deleted', async () => {
    write(home('headley'), 'stale\n', 1_000);
    write(home('default'), 'newer\n', 2_000);
    const r = await placeCodexResumeRollout(THREAD, home('headley'), [home('default')]);
    expect(r.outcome).toBe('replaced');
    expect(fs.readFileSync(path.join(home('headley'), REL), 'utf8')).toBe('newer\n');
    const dayDir = path.dirname(path.join(home('headley'), REL));
    const aside = fs.readdirSync(dayDir).filter((n) => n.includes('.set-aside-'));
    expect(aside).toHaveLength(1);
    expect(aside[0].endsWith('.jsonl')).toBe(false); // ignored by Codex and instar lookups
    expect(fs.readFileSync(path.join(dayDir, aside[0]), 'utf8')).toBe('stale\n');
  });

  it('answers not-found when no home holds the conversation, and writes nothing', async () => {
    const r = await placeCodexResumeRollout(THREAD, home('headley'), [home('default')]);
    expect(r.outcome).toBe('not-found');
    expect(fs.existsSync(home('headley'))).toBe(false);
  });

  it('ignores the target when it is also listed as a source', async () => {
    write(home('headley'), 'only\n', 1_000);
    const r = await placeCodexResumeRollout(THREAD, home('headley'), [home('headley')]);
    expect(r.outcome).toBe('present');
  });

  it('leaves no partial copy behind: only the real name and the set-aside name remain', async () => {
    write(home('headley'), 'stale\n', 1_000);
    write(home('default'), 'newer\n', 2_000);
    await placeCodexResumeRollout(THREAD, home('headley'), [home('default')]);
    const dayDir = path.dirname(path.join(home('headley'), REL));
    expect(fs.readdirSync(dayDir).filter((n) => n.includes('.partial-'))).toEqual([]);
  });

  it('refuses a thread id that could leave the sessions tree, and writes nothing', async () => {
    write(home('default'), 'x\n', 1_000);
    for (const bad of ['../etc', 'a/b', '']) {
      const r = await placeCodexResumeRollout(bad, home('headley'), [home('default')]);
      expect(r.outcome).toBe('not-found');
    }
    expect(fs.existsSync(home('headley'))).toBe(false);
  });
});
