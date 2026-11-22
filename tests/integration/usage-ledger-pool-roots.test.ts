import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { UsageLedger } from '../../src/monitoring/UsageLedger.js';
import { mountUsageRoutes } from '../../src/server/usageRoutes.js';

const directories: string[] = [];
const ledgers: UsageLedger[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const dir of directories.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'usage-ledger-pool-roots-test-cleanup' });
});

function temporaryDirectory(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-ledger-pool-'));
  directories.push(dir);
  return dir;
}

function reader(home: string, pool: SubscriptionPool) {
  const ledger = new UsageLedger({ dbPath: ':memory:', agentId: 'test', machineId: 'm_local', agentHomes: [home],
    filesPerTick: 1, poolHomes: () => pool.transcriptHomes() });
  ledgers.push(ledger);
  const app = express();
  mountUsageRoutes(app, () => ({ ledger, puller: null, prices: null, isHolder: () => true,
    fromPeer: async () => null, fromHolder: async () => null, bearerOk: () => true }));
  return { app, ledger };
}

function writeRollout(slot: string, id: string, cwd: string): string {
  const day = path.join(slot, 'sessions', '2026', '11', '17');
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, 'rollout-' + id + '.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id, cwd } }) + '\n');
  fs.appendFileSync(file, JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(),
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 13, output_tokens: 2 } } } }) + '\n');
  return file;
}

describe('subscription pool and usage HTTP coverage', () => {
  it('reports a partial home and still reaches its other session, then counts the recovered file once', async () => {
    const stateDir = temporaryDirectory(), home = temporaryDirectory(), slot = temporaryDirectory();
    const pool = new SubscriptionPool({ stateDir, machineId: 'm_local' });
    pool.addFixture({ id: 'history', nickname: 'history', provider: 'openai', framework: 'codex-cli',
      email: 'historical@example.invalid', configHome: slot, status: 'disabled' });
    const { app, ledger } = reader(home, pool);
    const blocked = writeRollout(slot, 'a', home);
    writeRollout(slot, 'b', home);
    const open = fs.openSync;
    const deny = vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      if (file === blocked) throw Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
      return open(file, flags, mode);
    });
    await ledger.scanTickAsync();
    const coverage = await request(app).get('/usage/coverage').expect(200);
    expect(coverage.body.rootMachineId).toBe('m_local');
    expect(coverage.body.roots).toMatchObject([{ origin: 'codex:subscription-pool', listing: 'partial', filesPending: 2 }]);
    await ledger.scanTickAsync();
    expect((await request(app).get('/usage/summary').expect(200)).body.total.tokens.total).toBe(15);
    deny.mockRestore();
    await ledger.scanTickAsync();
    expect((await request(app).get('/usage/coverage').expect(200)).body.roots).toMatchObject([{ listing: 'listed', filesPending: 0 }]);
    expect((await request(app).get('/usage/summary').expect(200)).body.total.tokens.total).toBe(30);
    expect((await ledger.scanTickAsync()).rowsCounted).toBe(0);
  });

  it('reports a foreign host pool as unavailable and never enumerates its homes', async () => {
    const stateDir = temporaryDirectory(), slot = temporaryDirectory(), home = temporaryDirectory();
    const foreign = new SubscriptionPool({ stateDir, machineId: 'm_peer' });
    foreign.addFixture({ id: 'remote', nickname: 'remote', provider: 'openai', framework: 'codex-cli',
      email: 'elsewhere@example.invalid', configHome: slot });
    writeRollout(slot, 'foreign-host', home);
    const local = new SubscriptionPool({ stateDir, machineId: 'm_local' });
    const { app, ledger } = reader(home, local);
    await ledger.scanTickAsync();
    expect((await request(app).get('/usage/coverage').expect(200)).body).toMatchObject({ roots: [], poolRootDiscovery: 'unavailable' });
    expect((await request(app).get('/usage/summary').expect(200)).body.total.tokens.total).toBe(0);
  });
});
