// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Lifecycle: a reopened SubscriptionPool, a real factory-built Codex provider and a real
 * child process (a stand-in `codex` binary that records the CODEX_HOME it was given).
 *
 * Proves the whole path the server wires: pool reading → picker → late-bound source →
 * provider → child env. fb-feb1652a-948: internal checks stayed on a walled ambient
 * login while other enrolled Codex accounts had room.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubscriptionPool, pickInternalCallAccount } from '../../src/core/SubscriptionPool.js';
import { buildIntelligenceProvider } from '../../src/core/intelligenceProviderFactory.js';
import {
  resolveInternalCodexAccount,
  setInternalCodexAccountSource,
} from '../../src/core/internalCodexAccount.js';
import { getHostSpawnSemaphore, _resetHostSpawnSemaphoreForTest } from '../../src/core/hostSpawnSemaphore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const FUTURE = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();

describe('internal Codex reset-first routing survives pool restart', () => {
  let dir: string;
  let record: string;
  let codexBin: string;
  let pool: SubscriptionPool;
  const savedExecJson = process.env.INSTAR_CODEX_EXEC_JSON;
  const savedHome = process.env.CODEX_HOME;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-room-int-'));
    // The real factory wrapper must use an owned ledger for the fake child.
    vi.spyOn(os, 'homedir').mockReturnValue(dir);
    _resetHostSpawnSemaphoreForTest();
    record = path.join(dir, 'codex-home.txt');
    codexBin = path.join(dir, 'codex');
    // Stand-in codex: records which login home it ran under, answers like a judgment call.
    fs.writeFileSync(codexBin, `#!/bin/sh\nprintf '%s' "$CODEX_HOME" > '${record}'\ncat >/dev/null\necho ok\n`);
    fs.chmodSync(codexBin, 0o755);
    process.env.INSTAR_CODEX_EXEC_JSON = '0';
    delete process.env.CODEX_HOME;

    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    pool = new SubscriptionPool({ stateDir: path.join(dir, '.instar'), machineId: 'm-test' });
    for (const [id, pct] of [['dawn', 100], ['amrch', 90], ['justin', 1]] as const) {
      const home = path.join(dir, `.codex-${id}`);
      fs.mkdirSync(home, { recursive: true });
      pool.addFixture({ id, nickname: id, email: `${id}@example.test`, provider: 'openai', framework: 'codex-cli', configHome: home });
      pool.update(id, { lastQuota: { sevenDay: { utilizationPct: pct, resetsAt: FUTURE } } });
    }
  });

  afterEach(() => setInternalCodexAccountSource(null));

  afterAll(() => {
    _resetHostSpawnSemaphoreForTest();
    vi.restoreAllMocks();
    if (savedExecJson === undefined) delete process.env.INSTAR_CODEX_EXEC_JSON;
    else process.env.INSTAR_CODEX_EXEC_JSON = savedExecJson;
    if (savedHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedHome;
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/internal-codex-reset-first-lifecycle cleanup' });
  });

  function provider() {
    const p = buildIntelligenceProvider({
      framework: 'codex-cli',
      binaryPath: codexBin,
      resolveExecJson: () => false,
      resolveAccount: resolveInternalCodexAccount,
    });
    expect(p).not.toBeNull();
    return p!;
  }

  it('passes the soonest-reset home to the actual child, then moves on when it is full', async () => {
    expect(getHostSpawnSemaphore().status().holdersPath).toBe(path.join(dir, '.instar', 'host-spawn-holders.json'));
    const measuredAt = new Date().toISOString();
    const soon = new Date(Date.now() + 3600_000).toISOString();
    setInternalCodexAccountSource(() => pickInternalCallAccount(pool.list(), 'codex-cli'));
    try {
      pool.update('amrch', { lastQuota: { measuredAt, sevenDay: { utilizationPct: 70, resetsAt: soon } } });
      pool.update('justin', { lastQuota: { measuredAt, sevenDay: { utilizationPct: 1, resetsAt: FUTURE } } });
      // Reconstruct after persisting distinct deadlines, as the server does at startup.
      pool = new SubscriptionPool({ stateDir: path.join(dir, '.instar'), machineId: 'm-test' });
      await provider().evaluate('use expiring allowance');
      expect(fs.readFileSync(record, 'utf8')).toBe(path.join(dir, '.codex-amrch'));
      pool.update('amrch', { lastQuota: { measuredAt, sevenDay: { utilizationPct: 100, resetsAt: soon } } });
      await provider().evaluate('continue on an account with room');
      expect(fs.readFileSync(record, 'utf8')).toBe(path.join(dir, '.codex-justin'));
    } finally {
      pool.update('amrch', { lastQuota: { sevenDay: { utilizationPct: 90, resetsAt: FUTURE } } });
    }
  });

});
