/**
 * UsageLedger — the scan tick with its enumeration off the event loop.
 *
 * scanTickAsync() must give the same answer as scanTick() (it walks the same
 * tree under the same rules) while making no synchronous directory read or
 * stat to list the files. These tests hold it to both.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageLedger, encodeClaudeProjectDir } from '../../src/monitoring/UsageLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const T0 = Date.now() + 60_000;
const DAY = 24 * 60 * 60 * 1000;
let seq = 0;

function line(sessionId: string, cwd: string): string {
  return JSON.stringify({
    type: 'assistant', requestId: `req_async_${++seq}`, sessionId, cwd, timestamp: new Date(T0).toISOString(),
    message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 50 } },
  }) + '\n';
}
const tc = (ts: number, input: number, cached: number, output: number) => ({
  type: 'event_msg', timestamp: new Date(ts).toISOString(),
  payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0 } } },
});

describe('UsageLedger.scanTickAsync', () => {
  let tmp: string; let home: string; let claudeA: string; let claudeB: string; let codexDir: string;
  const ledgers: UsageLedger[] = [];

  function newLedger(opts: { filesPerTick?: number } = {}): UsageLedger {
    const ledger = new UsageLedger({
      dbPath: ':memory:', machineId: 'm_test', agentId: 'echo', agentHomes: [home],
      now: () => T0 + 3_600_000, ...opts,
    });
    ledger.addClaudeRoot(claudeA, 'a');
    ledger.addClaudeRoot(claudeB, 'b');
    ledger.addCodexRoot(codexDir, 'cx');
    // Roots with nothing under them: listing them finds nothing and does not fail.
    ledger.addClaudeRoot(path.join(tmp, 'claude-empty'), 'empty');
    ledger.addCodexRoot(path.join(tmp, 'codex-empty'), 'empty');
    ledger.recordBinding({ sessionId: 'b1', framework: 'claude-code', sessionKind: 'job', cwd: path.join(tmp, 'builders', 'wt'), topicId: '1', jobSlug: 'build', runId: 'r1', accountId: 'acct-1', validFrom: T0 - 1000 });
    ledgers.push(ledger);
    return ledger;
  }
  function transcript(configDir: string, cwd: string, rel: string, body: string): string {
    const file = path.join(configDir, 'projects', encodeClaudeProjectDir(cwd), rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return file;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-ledger-async-'));
    home = path.join(tmp, 'agents', 'echo');
    claudeA = path.join(tmp, 'claude-a');
    claudeB = path.join(tmp, 'claude-b');
    codexDir = path.join(tmp, 'codex');
    fs.mkdirSync(home, { recursive: true });
    // Member sessions in two roots, one with a subagent transcript.
    transcript(claudeA, home, 's1.jsonl', line('s1', home) + line('s1', home));
    transcript(claudeA, home, 's1/subagents/agent-x.jsonl', line('s1', home));
    transcript(claudeB, home, 's2.jsonl', line('s2', home));
    // A project directory that is not this agent's: skipped whole.
    transcript(claudeA, path.join(tmp, 'someone-else'), 'other.jsonl', line('other', path.join(tmp, 'someone-else')));
    // A session outside the agent home that a spawn record rules in (newLedger records the binding),
    // and one in the same kind of place with no record, which stays out.
    transcript(claudeB, path.join(tmp, 'builders', 'wt'), 'b1.jsonl', line('b1', path.join(tmp, 'builders', 'wt')));
    transcript(claudeB, path.join(tmp, 'builders', 'unbound'), 'u1.jsonl', line('u1', path.join(tmp, 'builders', 'unbound')));
    // Too deep, a symlinked file, and a file outside the age window.
    transcript(claudeA, home, 'a/b/c/deep.jsonl', line('deep', home));
    fs.symlinkSync(path.join(claudeA, 'projects', encodeClaudeProjectDir(home), 's1.jsonl'), path.join(claudeA, 'projects', encodeClaudeProjectDir(home), 'link.jsonl'));
    const old = transcript(claudeB, home, 'old.jsonl', line('old', home));
    const longAgo = new Date(T0 - 90 * DAY);
    fs.utimesSync(old, longAgo, longAgo);
    // Codex rollouts: one in the window, one a non-rollout file.
    const day = path.join(codexDir, 'sessions', '2026', '11', '10');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, 'rollout-a.jsonl'), [
      { type: 'session_meta', payload: { id: 'cx-1', cwd: home } },
      { type: 'turn_context', payload: { model: 'gpt-5.2' } },
      tc(T0, 1000, 800, 100), tc(T0 + 2000, 2500, 2000, 300),
    ].map((row) => JSON.stringify(row) + '\n').join(''));
    fs.writeFileSync(path.join(day, 'notes.jsonl'), '{}\n');
    const oldRollout = path.join(day, 'rollout-old.jsonl');
    fs.writeFileSync(oldRollout, JSON.stringify({ type: 'session_meta', payload: { id: 'cx-old', cwd: home } }) + '\n');
    fs.utimesSync(oldRollout, longAgo, longAgo);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const ledger of ledgers.splice(0)) ledger.close();
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/UsageLedger.asyncScan.test.ts:cleanup' });
  });

  it('gives the same report, totals and coverage as the synchronous tick', async () => {
    const syncLedger = newLedger();
    const asyncLedger = newLedger();
    const syncReport = syncLedger.scanTick();
    const asyncReport = await asyncLedger.scanTickAsync();
    expect(asyncReport).toEqual(syncReport);
    expect(syncReport.filesRead).toBe(5); // s1, its subagent, s2, the bound builder session, the rollout
    expect(asyncLedger.totals(T0 - DAY)).toEqual(syncLedger.totals(T0 - DAY));
    expect(asyncLedger.totals(T0 - DAY).calls).toBeGreaterThan(0);
    expect(asyncLedger.listRoots()).toEqual(syncLedger.listRoots());
    const coverage = asyncLedger.listRoots();
    expect(coverage.find((row) => row.root === claudeA)?.filesSkippedDirs).toBe(1);
    expect(coverage.find((row) => row.root === claudeB)?.filesSkippedDirs).toBe(1); // the unbound builder directory
    expect(coverage.find((row) => row.root === codexDir)?.filesOutOfWindow).toBe(1);
    expect(asyncLedger.statusCounts()).toEqual(syncLedger.statusCounts());
    expect(coverage.find((row) => row.root === claudeA)?.filesTooDeep).toBeGreaterThan(0);
    expect(coverage.find((row) => row.root === claudeB)?.filesOutOfWindow).toBe(1);
    // A second tick with nothing changed reads nothing, the same on both.
    expect(await asyncLedger.scanTickAsync()).toEqual(syncLedger.scanTick());
    expect((await asyncLedger.scanTickAsync()).filesRead).toBe(0);
  });

  it('keeps the same pending count and budget behaviour when the budget is smaller than the work', async () => {
    const syncLedger = newLedger({ filesPerTick: 2 });
    const asyncLedger = newLedger({ filesPerTick: 2 });
    for (let tick = 0; tick < 3; tick++) {
      const expected = syncLedger.scanTick();
      expect(await asyncLedger.scanTickAsync(), `tick ${tick}`).toEqual(expected);
    }
    expect(asyncLedger.totals(T0 - DAY)).toEqual(syncLedger.totals(T0 - DAY));
  });

  it('lists without one synchronous directory read or stat', async () => {
    const ledger = newLedger();
    const readdirSync = vi.spyOn(fs, 'readdirSync');
    const statSync = vi.spyOn(fs, 'statSync');
    const report = await ledger.scanTickAsync();
    expect(report.filesRead).toBe(5);
    expect(readdirSync).not.toHaveBeenCalled();
    expect(statSync).not.toHaveBeenCalled();
    // The control: the synchronous tick on the same tree makes both kinds of call.
    newLedger().scanTick();
    expect(readdirSync.mock.calls.length).toBeGreaterThan(0);
    expect(statSync.mock.calls.length).toBeGreaterThan(0);
  });

  it('lets timers on the main thread fire between the listing steps', async () => {
    for (let index = 0; index < 150; index++) transcript(claudeA, home, `bulk-${index}.jsonl`, line(`bulk-${index}`, home));
    const ledger = newLedger({ filesPerTick: 1 });
    let turns = 0;
    const pending = ledger.scanTickAsync();
    const timer = setInterval(() => { turns++; }, 0);
    await pending;
    clearInterval(timer);
    expect(turns).toBeGreaterThan(0);
  });

  it('runs one scan at a time: a call during a scan gets that scan', async () => {
    const ledger = newLedger();
    const first = ledger.scanTickAsync();
    const second = ledger.scanTickAsync();
    expect(second).toBe(first);
    expect((await first).filesRead).toBe(5);
    const third = ledger.scanTickAsync();
    expect(third).not.toBe(first);
    expect((await third).filesRead).toBe(0);
  });

  it('a ledger closed at any point while a scan is listing ends the scan without throwing or ingesting', async () => {
    for (let index = 0; index < 40; index++) transcript(claudeA, home, `bulk-${index}.jsonl`, line(`bulk-${index}`, home));
    // Close after 0, 1, 2, ... turns of the loop, so the close lands at every stage of
    // the listing: the project walk, the membership lookup, the changed-file filter, the Codex walk.
    let sawCloseMidScan = 0;
    for (let turns = 0; turns < 60; turns++) {
      const ledger = newLedger();
      let settled = false;
      const pending = ledger.scanTickAsync().finally(() => { settled = true; });
      for (let turn = 0; turn < turns && !settled; turn++) await new Promise((resolve) => setImmediate(resolve));
      if (settled) { await pending; break; }
      sawCloseMidScan++;
      ledger.close();
      await expect(pending, `closed after ${turns} turns`).resolves.toMatchObject({ filesRead: 0, rowsInserted: 0 });
    }
    expect(sawCloseMidScan).toBeGreaterThan(5);
  });

  it('the checkpoint cleanup on a ledger closed while it was checking drops nothing and does not throw', async () => {
    const ledger = newLedger();
    await ledger.scanTickAsync();
    const pending = ledger.dropMissingCheckpointsAsync();
    ledger.close();
    await expect(pending).resolves.toBe(0);
    await expect(ledger.dropMissingCheckpointsAsync()).resolves.toBe(0);
  });

  it('a file that goes away between the listing and its stat is left for a later tick', async () => {
    const victim = path.join(claudeB, 'projects', encodeClaudeProjectDir(home), 's2.jsonl');
    const realStat = fs.promises.stat.bind(fs.promises);
    let removed = false;
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (target: fs.PathLike, ...rest: unknown[]) => {
      if (!removed && String(target) === victim) {
        removed = true;
        SafeFsExecutor.safeUnlinkSync(victim, { operation: 'tests/unit/UsageLedger.asyncScan.test.ts:fixture' });
      }
      return (realStat as (...args: unknown[]) => Promise<fs.Stats>)(target, ...rest);
    }) as typeof fs.promises.stat);
    const report = await newLedger().scanTickAsync();
    expect(removed).toBe(true);
    expect(report.filesRead).toBe(4);
  });

  it('a checkpointed file that goes away before the changed-file check is not read, and the tick completes', async () => {
    const ledger = newLedger();
    await ledger.scanTickAsync();
    const victim = path.join(claudeB, 'projects', encodeClaudeProjectDir(home), 's2.jsonl');
    const realStat = fs.promises.stat.bind(fs.promises);
    let statsOfVictim = 0;
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (target: fs.PathLike, ...rest: unknown[]) => {
      // First stat of the tick is the listing (file present); remove it before the second, the changed-file check.
      if (String(target) === victim && ++statsOfVictim === 2) {
        SafeFsExecutor.safeUnlinkSync(victim, { operation: 'tests/unit/UsageLedger.asyncScan.test.ts:fixture' });
      }
      return (realStat as (...args: unknown[]) => Promise<fs.Stats>)(target, ...rest);
    }) as typeof fs.promises.stat);
    const report = await ledger.scanTickAsync();
    expect(statsOfVictim).toBe(2);
    expect(report).toMatchObject({ filesRead: 0, pending: 0 });
  });

  it('a root added while a scan is listing is scanned by the next tick', async () => {
    const ledger = newLedger();
    const lateRoot = path.join(tmp, 'claude-late');
    transcript(lateRoot, home, 'late.jsonl', line('late', home));
    const pending = ledger.scanTickAsync();
    ledger.addClaudeRoot(lateRoot, 'late');
    expect((await pending).filesRead).toBe(5);
    expect((await ledger.scanTickAsync()).filesRead).toBe(1);
  });

  it('dropMissingCheckpointsAsync drops exactly what the synchronous one drops', async () => {
    const syncLedger = newLedger();
    const asyncLedger = newLedger();
    syncLedger.scanTick();
    await asyncLedger.scanTickAsync();
    SafeFsExecutor.safeUnlinkSync(path.join(claudeB, 'projects', encodeClaudeProjectDir(home), 's2.jsonl'), { operation: 'tests/unit/UsageLedger.asyncScan.test.ts:fixture' });
    const existsSync = vi.spyOn(fs, 'existsSync');
    expect(await asyncLedger.dropMissingCheckpointsAsync()).toBe(1);
    expect(existsSync).not.toHaveBeenCalled();
    expect(syncLedger.dropMissingCheckpoints()).toBe(1);
    expect(await asyncLedger.dropMissingCheckpointsAsync()).toBe(0);
  });
});

describe('the server runs the usage scan off its main thread', () => {
  it('the minute timer drives the ledger through the tested tick, never the synchronous scan', () => {
    const source = fs.readFileSync(new URL('../../src/server/AgentServer.ts', import.meta.url), 'utf8');
    expect(source).toContain('const usageTick = createUsageLedgerTick({');
    expect(source).toContain('getLedger: () => this.usageLedger,');
    expect(source).toContain('this.usageLedgerTimer = setInterval(() => { void usageTick(); }, 60_000);');
    expect(source).not.toMatch(/usageLedger\?\.scanTick\(\)/);
    expect(source).not.toMatch(/usageLedger\?\.dropMissingCheckpoints\(\)/);
  });
});
