import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { UsageLedger, encodeClaudeProjectDir } from '../../src/monitoring/UsageLedger.js';

const dirs: string[] = [];
const ledgers: UsageLedger[] = [];
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-pool-roots-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/UsageLedger.poolRoots.test.ts' });
});

function rollout(root: string, id: string, cwd: string, ts = Date.now() + 1000): string {
  const dir = path.join(root, 'sessions', '2026', '11', '17');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'rollout-' + id + '.jsonl');
  fs.writeFileSync(file, [
    { type: 'session_meta', payload: { id, cwd } },
    { type: 'event_msg', timestamp: new Date(ts).toISOString(), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 123, output_tokens: 7 } } } },
  ].map(row => JSON.stringify(row) + '\n').join(''));
  return file;
}

describe('local subscription transcript roots', () => {
  it('discovers members after boot and forgets removed pool roots without losing counted history', async () => {
    const home = temp(), slot = temp();
    let roots: { framework: string; configHome: string }[] = [];
    const db = new Database(':memory:');
    const ledger = new UsageLedger({ dbPath: ':memory:', databaseFactory: () => db, machineId: 'm', agentId: 'a', agentHomes: [home], poolHomes: () => roots });
    ledgers.push(ledger);
    rollout(slot, 'one', home);
    rollout(slot, 'foreign', temp());
    await ledger.scanTickAsync();
    expect(ledger.totals(0).calls).toBe(0);
    roots = [{ framework: 'codex-cli', configHome: slot }, { framework: 'codex-cli', configHome: '' }, { framework: 'codex-cli', configHome: 'relative' }];
    await ledger.scanTickAsync();
    expect(ledger.totals(0).calls).toBe(1);
    expect(ledger.listRoots()).toMatchObject([{ root: slot, origin: 'codex:subscription-pool', listing: 'listed' }]);
    expect(db.prepare('SELECT session_id, scope_basis, account_id FROM usage_events').all())
      .toEqual([{ session_id: 'one', scope_basis: 'cwd', account_id: null }]);
    roots = [];
    rollout(slot, 'two', home);
    await ledger.scanTickAsync();
    expect(ledger.listRoots()).toEqual([]);
    expect(ledger.totals(0).calls).toBe(1);
    roots = [{ framework: 'codex-cli', configHome: slot }];
    await ledger.scanTickAsync();
    expect(ledger.totals(0).calls).toBe(2);
  });

  it('retains a shared static home and reports a pool read failure without stopping reads of ambient roots', () => {
    const home = temp(), slot = temp();
    let broken = false;
    const ledger = new UsageLedger({ dbPath: ':memory:', machineId: 'm', agentId: 'a', agentHomes: [home],
      poolHomes: () => {
        if (broken) throw new Error('pool temporarily unavailable');
        return [{ framework: 'codex-cli', configHome: slot }];
      },
    });
    ledgers.push(ledger);
    ledger.addCodexRoot(slot, 'server-env');
    ledger.scanTick();
    broken = true;
    rollout(slot, 'env', home);
    ledger.scanTick();
    expect(ledger.poolDiscovery).toBe('unavailable');
    expect(ledger.listRoots()).toHaveLength(1);
    expect(ledger.totals(0).calls).toBe(1);
  });

  it.each(['sync', 'async'] as const)('distinguishes empty, pending and unavailable transcript folders via %s scans', async mode => {
    const home = temp(), slot = temp(), linked = temp();
    const ledger = new UsageLedger({ dbPath: ':memory:', machineId: 'm', agentId: 'a', agentHomes: [home], filesPerTick: 1,
      poolHomes: () => [
        { framework: 'claude-code', configHome: slot }, { framework: 'codex-cli', configHome: slot },
        { framework: 'codex-cli', configHome: slot + path.sep }, { framework: 'codex-cli', configHome: linked },
      ],
    });
    ledgers.push(ledger);
    fs.mkdirSync(path.join(slot, 'projects'));
    fs.symlinkSync(path.join(slot, 'sessions'), path.join(linked, 'sessions'));
    const tick = () => mode === 'sync' ? ledger.scanTick() : ledger.scanTickAsync();
    expect(ledger.listRoots().map(r => r.listing)).toEqual(['unscanned', 'unscanned', 'unscanned']);
    await tick();
    expect(ledger.listRoots().map(r => r.listing)).toEqual(['listed', 'unavailable', 'unavailable']);
    rollout(slot, 'one', home);
    rollout(slot, 'two', home);
    expect((await tick()).pending).toBe(1);
    expect(ledger.listRoots()).toMatchObject([
      { listing: 'listed', filesPending: 0 }, { listing: 'listed', filesPending: 1 }, { listing: 'unavailable', filesPending: 0 },
    ]);
    expect((await tick()).pending).toBe(0);
    expect(ledger.totals(0).calls).toBe(2);
  });

  it('keeps the resume checkpoint if an enrolled file temporarily becomes inaccessible', async () => {
    const home = temp(), slot = temp();
    const ledger = new UsageLedger({ dbPath: ':memory:', machineId: 'm', agentId: 'a', agentHomes: [home],
      poolHomes: () => [{ framework: 'codex-cli', configHome: slot }],
    });
    ledgers.push(ledger);
    const file = rollout(slot, 'unreadable', home);
    await ledger.scanTickAsync();
    const denied = Object.assign(new Error('permission temporarily denied'), { code: 'EACCES' });
    const rejectStat = vi.spyOn(fs.promises, 'stat').mockRejectedValueOnce(denied);
    expect(await ledger.dropMissingCheckpointsAsync()).toBe(0);
    rejectStat.mockRestore();
    const throwStat = vi.spyOn(fs, 'statSync').mockImplementationOnce(() => { throw denied; });
    expect(ledger.dropMissingCheckpoints()).toBe(0);
    throwStat.mockRestore();
    expect((await ledger.scanTickAsync()).filesRead).toBe(0);
    SafeFsExecutor.safeUnlinkSync(file, { operation: 'usage-ledger-pool-roots:remove-fixture' });
    expect(await ledger.dropMissingCheckpointsAsync()).toBe(1);
  });

  it.each([false, true])('yields after a committed file and safely handles close during backfill (%s)', async closeAfterFirst => {
    const home = temp(), slot = temp();
    const ledger = new UsageLedger({ dbPath: ':memory:', machineId: 'm', agentId: 'a', agentHomes: [home],
      poolHomes: () => [{ framework: 'codex-cli', configHome: slot }],
    });
    ledgers.push(ledger);
    for (const id of ['a', 'b', 'c']) rollout(slot, id, home);
    let rowsAtCallback: number | undefined, waitingAtCallback: number | undefined;
    const ingest = ledger.ingestCodexFile.bind(ledger);
    vi.spyOn(ledger, 'ingestCodexFile').mockImplementationOnce((root, file, prepared) => {
      const result = ingest(root, file, prepared);
      setImmediate(() => {
        rowsAtCallback = ledger.rawRowCount;
        waitingAtCallback = ledger.listRoots()[0].filesPending;
        if (closeAfterFirst) ledger.close();
      });
      return result;
    });
    const report = await ledger.scanTickAsync();
    expect(rowsAtCallback).toBe(1);
    expect(waitingAtCallback).toBe(2);
    expect(report.filesRead).toBe(closeAfterFirst ? 1 : 3);
  });

  it('counts both frameworks once when an older observation is discovered in a backup before its original', async () => {
    const home = temp(), original = temp(), backup = temp();
    const originalRollout = rollout(original, 'cx', home);
    const project = path.join('projects', encodeClaudeProjectDir(home));
    fs.mkdirSync(path.join(original, project), { recursive: true });
    const transcript = path.join(project, 'cc.jsonl');
    const originalTranscript = path.join(original, transcript);
    fs.writeFileSync(originalTranscript, '');
    // The event must postdate BOTH originals. A future wall-clock guess can
    // expire while a loaded host is still creating the Claude transcript.
    const ts = Math.max(Date.now(), Math.ceil(fs.statSync(originalRollout).birthtimeMs), Math.ceil(fs.statSync(originalTranscript).birthtimeMs));
    rollout(original, 'cx', home, ts);
    fs.writeFileSync(originalTranscript, JSON.stringify({
      type: 'assistant', requestId: 'cc-req', sessionId: 'cc', cwd: home, timestamp: new Date(ts).toISOString(),
      message: { model: 'claude', usage: { input_tokens: 9, output_tokens: 3 } },
    }) + '\n');
    // Codex allows a 1s clock tolerance before classifying a row as copied history.
    await new Promise(resolve => setTimeout(resolve, 1130));
    fs.mkdirSync(path.join(backup, project), { recursive: true });
    fs.writeFileSync(path.join(backup, transcript), fs.readFileSync(path.join(original, transcript)));
    const backupRollout = path.join(backup, path.relative(original, originalRollout));
    fs.mkdirSync(path.dirname(backupRollout), { recursive: true });
    fs.writeFileSync(backupRollout, fs.readFileSync(originalRollout));
    for (const first of [backup, original]) {
      const homes = [first];
      const ledger = new UsageLedger({ dbPath: ':memory:', machineId: 'm', agentId: 'a', agentHomes: [home],
        poolHomes: () => homes.flatMap(configHome => ['claude-code', 'codex-cli'].map(framework => ({ framework, configHome }))),
      });
      ledgers.push(ledger);
      await ledger.scanTickAsync();
      expect(ledger.totals(0).calls).toBe(first === backup ? 0 : 2);
      homes.push(first === backup ? original : backup);
      await ledger.scanTickAsync();
      expect(ledger.rawRowCount).toBe(2);
      expect(ledger.totals(0)).toMatchObject({ calls: 2, input: 132, output: 10 });
      expect((await ledger.scanTickAsync()).rowsCounted).toBe(0);
    }
  });
});
