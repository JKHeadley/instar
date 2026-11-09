// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Integration: a real SubscriptionPool, a real factory-built Codex provider and a real
 * child process (a stand-in `codex` binary that records the CODEX_HOME it was given).
 *
 * Proves the whole path the server wires: pool reading → picker → late-bound source →
 * provider → child env. fb-feb1652a-948: internal checks stayed on a walled ambient
 * login while other enrolled Codex accounts had room.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubscriptionPool, pickInternalCallAccount } from '../../src/core/SubscriptionPool.js';
import { buildIntelligenceProvider } from '../../src/core/intelligenceProviderFactory.js';
import {
  resolveInternalCodexAccount,
  setInternalCodexAccountSource,
} from '../../src/core/internalCodexAccount.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const FUTURE = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();

describe('internal Codex calls run on the account with the most room (real pool, real child)', () => {
  let dir: string;
  let record: string;
  let codexBin: string;
  let pool: SubscriptionPool;
  const savedExecJson = process.env.INSTAR_CODEX_EXEC_JSON;
  const savedHome = process.env.CODEX_HOME;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-room-int-'));
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
    if (savedExecJson === undefined) delete process.env.INSTAR_CODEX_EXEC_JSON;
    else process.env.INSTAR_CODEX_EXEC_JSON = savedExecJson;
    if (savedHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedHome;
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/internal-codex-account-room cleanup' });
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

  it('the child runs under the roomiest account, not the walled one or the ambient login', async () => {
    setInternalCodexAccountSource(() => pickInternalCallAccount(pool.list(), 'codex-cli'));
    await provider().evaluate('is this fine?');
    expect(fs.readFileSync(record, 'utf8')).toBe(path.join(dir, '.codex-justin'));
  });

  it('a new reading is honored on the very next call (live pool, not a snapshot)', async () => {
    setInternalCodexAccountSource(() => pickInternalCallAccount(pool.list(), 'codex-cli'));
    pool.update('justin', { lastQuota: { sevenDay: { utilizationPct: 100, resetsAt: FUTURE } } });
    await provider().evaluate('and now?');
    expect(fs.readFileSync(record, 'utf8')).toBe(path.join(dir, '.codex-amrch'));
    pool.update('justin', { lastQuota: { sevenDay: { utilizationPct: 1, resetsAt: FUTURE } } });
  });

  it('switched off (no source) ⇒ the ambient login, exactly as before', async () => {
    await provider().evaluate('off?');
    expect(fs.readFileSync(record, 'utf8')).toBe('');
  });
});
