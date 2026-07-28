/**
 * Unit tests — CodexResumeMap (TOPIC-PROFILE-SPEC §7 prerequisite sub-task).
 *
 * Covers the time-fenced zero-or-one rollout capture (single candidate
 * captured; multi-candidate AMBIGUITY captures nothing and is counted
 * separately from validation failures; pre-spawn rollouts excluded; cwd
 * mismatch excluded), park/unpark semantics (§8 — park, not delete), and
 * persistence/prune behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexResumeMap, rolloutIdFromFilename } from '../../src/core/CodexResumeMap.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmpDir: string;
let stateDir: string;
let codexHome: string;

const UUID_A = '11111111-2222-4333-8444-555555555555';
const UUID_B = '66666666-7777-4888-9999-aaaaaaaaaaaa';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-resume-map-'));
  stateDir = path.join(tmpDir, 'state');
  codexHome = path.join(tmpDir, 'codex-home');
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/CodexResumeMap.test.ts:afterEach',
  });
});

/** Write a codex rollout fixture with a session_meta first line. */
function writeRollout(uuid: string, opts: { cwd: string; timestamp: string; mtimeMs?: number }): string {
  const day = opts.timestamp.slice(0, 10); // YYYY-MM-DD
  const [y, m, d] = day.split('-');
  const dir = path.join(codexHome, 'sessions', y, m, d);
  fs.mkdirSync(dir, { recursive: true });
  const ts = opts.timestamp.replace(/[:.]/g, '-');
  const file = path.join(dir, `rollout-${ts}-${uuid}.jsonl`);
  const meta = {
    type: 'session_meta',
    payload: { cwd: opts.cwd, timestamp: opts.timestamp },
  };
  fs.writeFileSync(file, `${JSON.stringify(meta)}\n{"type":"turn"}\n`);
  if (opts.mtimeMs !== undefined) {
    fs.utimesSync(file, new Date(opts.mtimeMs), new Date(opts.mtimeMs));
  }
  return file;
}

describe('rolloutIdFromFilename', () => {
  it('extracts the trailing UUID', () => {
    expect(rolloutIdFromFilename(`/x/rollout-2026-06-11T20-00-00-000Z-${UUID_A}.jsonl`)).toBe(UUID_A);
  });
  it('returns null for a non-uuid filename', () => {
    expect(rolloutIdFromFilename('/x/rollout-junk.jsonl')).toBeNull();
  });
});

describe('CodexResumeMap — fence capture (zero-or-one)', () => {
  it('captures the single post-spawn rollout matching the fence cwd', async () => {
    const spawnedAt = Date.now() - 60_000;
    const cwd = path.join(tmpDir, 'project');
    writeRollout(UUID_A, {
      cwd,
      timestamp: new Date(spawnedAt + 5_000).toISOString(),
      mtimeMs: spawnedAt + 10_000,
    });

    const map = new CodexResumeMap(stateDir, codexHome);
    const result = await map.captureAtKill(23225, 'echo-test', { spawnedAt, cwd });

    expect(result.outcome).toBe('captured');
    expect(result.rolloutId).toBe(UUID_A);
    expect(map.get(23225)).toBe(UUID_A);
  });

  it('captures NOTHING when two candidates pass the fence (ambiguity, counted separately)', async () => {
    const spawnedAt = Date.now() - 60_000;
    const cwd = path.join(tmpDir, 'project');
    writeRollout(UUID_A, { cwd, timestamp: new Date(spawnedAt + 5_000).toISOString(), mtimeMs: spawnedAt + 10_000 });
    writeRollout(UUID_B, { cwd, timestamp: new Date(spawnedAt + 6_000).toISOString(), mtimeMs: spawnedAt + 11_000 });

    const map = new CodexResumeMap(stateDir, codexHome);
    const result = await map.captureAtKill(23225, 'echo-test', { spawnedAt, cwd });

    expect(result.outcome).toBe('ambiguous');
    expect(result.candidateCount).toBe(2);
    expect(map.get(23225)).toBeNull();
    // Ambiguity is a distinct non-drift metric (§7 round-6).
    expect(map.driftCounters().ambiguityDiscards).toBe(1);
    expect(map.driftCounters().consecutiveValidationFailures).toBe(0);
  });

  it('excludes rollouts created BEFORE the spawn fence', async () => {
    const spawnedAt = Date.now() - 60_000;
    const cwd = path.join(tmpDir, 'project');
    writeRollout(UUID_A, {
      cwd,
      timestamp: new Date(spawnedAt - 30_000).toISOString(),
      mtimeMs: spawnedAt - 20_000,
    });

    const map = new CodexResumeMap(stateDir, codexHome);
    const result = await map.captureAtKill(23225, 'echo-test', { spawnedAt, cwd });
    expect(result.outcome).toBe('none');
    expect(map.get(23225)).toBeNull();
  });

  it('excludes rollouts whose recorded cwd mismatches the fence', async () => {
    const spawnedAt = Date.now() - 60_000;
    writeRollout(UUID_A, {
      cwd: path.join(tmpDir, 'OTHER-project'),
      timestamp: new Date(spawnedAt + 5_000).toISOString(),
      mtimeMs: spawnedAt + 10_000,
    });

    const map = new CodexResumeMap(stateDir, codexHome);
    const result = await map.captureAtKill(23225, 'echo-test', {
      spawnedAt,
      cwd: path.join(tmpDir, 'project'),
    });
    expect(result.outcome).toBe('none');
  });

  it('a missing codex home yields none (pure-Claude agent), not drift', async () => {
    const map = new CodexResumeMap(stateDir, path.join(tmpDir, 'no-such-codex-home'));
    const result = await map.captureAtKill(1, 's', { spawnedAt: Date.now(), cwd: tmpDir });
    expect(result.outcome).toBe('none');
    expect(map.driftCounters().consecutiveValidationFailures).toBe(0);
  });
});

describe('CodexResumeMap — park/unpark (§8: park, not delete)', () => {
  it('a parked entry resolves to null but survives for un-park recovery', async () => {
    const spawnedAt = Date.now() - 60_000;
    const cwd = path.join(tmpDir, 'project');
    writeRollout(UUID_A, { cwd, timestamp: new Date(spawnedAt + 5_000).toISOString(), mtimeMs: spawnedAt + 10_000 });

    const map = new CodexResumeMap(stateDir, codexHome);
    await map.captureAtKill(23225, 'echo-test', { spawnedAt, cwd });

    map.park(23225, 'mid-framework-switch');
    expect(map.get(23225)).toBeNull();
    expect(map.getEntry(23225)?.parked).toBe('mid-framework-switch');

    expect(map.unpark(23225)).toBe(true);
    expect(map.get(23225)).toBe(UUID_A);
  });

  it('parking persists across a reload', async () => {
    const spawnedAt = Date.now() - 60_000;
    const cwd = path.join(tmpDir, 'project');
    writeRollout(UUID_A, { cwd, timestamp: new Date(spawnedAt + 5_000).toISOString(), mtimeMs: spawnedAt + 10_000 });

    const map = new CodexResumeMap(stateDir, codexHome);
    await map.captureAtKill(23225, 'echo-test', { spawnedAt, cwd });
    map.park(23225, 'mid-framework-switch');

    const reloaded = new CodexResumeMap(stateDir, codexHome);
    expect(reloaded.get(23225)).toBeNull();
    expect(reloaded.getEntry(23225)?.parked).toBe('mid-framework-switch');
  });
});

describe('CodexResumeMap — resolution guards', () => {
  it('returns null when the rollout file no longer exists on this machine (§5.3 transcript locality)', () => {
    const map = new CodexResumeMap(stateDir, codexHome);
    map.save(1, UUID_A, 'session');
    // No rollout file written — resolution must refuse.
    expect(map.get(1)).toBeNull();
  });

  it('remove() hard-deletes an entry', async () => {
    const map = new CodexResumeMap(stateDir, codexHome);
    map.save(1, UUID_A, 'session');
    map.remove(1);
    expect(map.getEntry(1)).toBeNull();
  });
});
