import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const script = fileURLToPath(new URL('../../scripts/compare-work-board-capture.mjs', import.meta.url));
const roster = Array.from({ length: 5 }, (_, index) => `m_${String(index + 1).repeat(32)}`);
const owner = { ready: true, health: 'ok', ownerPersonKey: 'owner', heads: { stream: 'a'.repeat(64) }, vector: { stream: 5 }, gaps: [] };
const digest = 'b'.repeat(64);
const emptyDigest = '00c6e3d832b6b548915c318a14939178ee866354b0e0af743a8e8b7f3da6ba60';
let dir: string;

const write = (name: string, value: unknown) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
const run = () => spawnSync(process.execPath, [script, path.join(dir, 'manifest.json'), dir], { encoding: 'utf8' });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-board-capture-compare-'));
  const heads = Object.fromEntries(roster.map((id) => [id, { incarnation: id, lastSeq: 0 }]));
  write('manifest.json', { roster, heads });
  for (const id of roster) {
    write(`${id}.team-owner.before.json`, owner);
    write(`${id}.team-owner.after.json`, owner);
    write(`${id}.work-board.json`, { machineId: id, ownIncarnation: id, ownLastSeq: 0, projectionDigest: emptyDigest, origins: [] });
  }
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'work-board-capture-comparison-test' });
});

describe('Work Board capture comparison', () => {
  it('compares five complete matching receipts including an empty baseline', () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ receiptsMatch: true, homes: roster, projectionDigest: emptyDigest, originCount: 0 });
  });

  it('compares per-origin evidence on a nonempty board and rejects a changed count', () => {
    const source = roster[0];
    write('manifest.json', { roster, heads: Object.fromEntries(roster.map((id) => [
      id, { incarnation: id, lastSeq: id === source ? 2 : 0 },
    ])) });
    const origin = { origin: source, count: 1, digest };
    for (const id of roster) {
      write(`${id}.work-board.json`, {
        machineId: id, ownIncarnation: id, ownLastSeq: id === source ? 2 : 0, projectionDigest: digest, origins: [origin],
      });
    }
    const matched = run();
    expect(matched.status, matched.stderr).toBe(0);
    expect(JSON.parse(matched.stdout).originCount).toBe(1);
    const peer = roster[4];
    write(`${peer}.work-board.json`, {
      machineId: peer, ownIncarnation: peer, ownLastSeq: 0, projectionDigest: digest, origins: [{ ...origin, count: 2 }],
    });
    expect(run().stderr).toContain('Work Board history mismatch');
  });

  it('refuses a changed owner receipt without printing the owner key', () => {
    write(`${roster[4]}.team-owner.after.json`, { ...owner, ownerPersonKey: 'changed-owner' });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('owner evidence mismatch');
    expect(result.stderr).not.toContain('changed-owner');
  });

  it('refuses a missing home receipt', () => {
    SafeFsExecutor.safeUnlinkSync(path.join(dir, `${roster[4]}.work-board.json`), { operation: 'work-board-capture-comparison-test' });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unreadable');
  });

  it('refuses a capture with a different durable head', () => {
    const id = roster[0];
    write(`${id}.work-board.json`, { machineId: id, ownIncarnation: id, ownLastSeq: 1, projectionDigest: emptyDigest, origins: [] });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('frozen journal head mismatch');
  });

  it('refuses an invalid digest for an empty projection', () => {
    const id = roster[4];
    write(`${id}.work-board.json`, { machineId: id, ownIncarnation: id, ownLastSeq: 0, projectionDigest: 'c'.repeat(64), origins: [] });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('empty projection digest mismatch');
  });
});
