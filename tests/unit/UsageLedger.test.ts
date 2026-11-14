/**
 * UsageLedger — Slice 1 (docs/specs/unified-usage-ledger.md): store, record, membership,
 * attribution, replay safety, rollups and retention for Claude transcripts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageLedger, encodeClaudeProjectDir, claudeUsageToParts } from '../../src/monitoring/UsageLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const T0 = Date.now() + 60_000;
let n = 0;

function line(o: { sessionId: string; cwd: string; ts?: number; input?: number; cacheRead?: number; cacheWrite?: number; output?: number; model?: string; requestId?: string }): string {
  return JSON.stringify({
    type: 'assistant',
    requestId: o.requestId ?? `req_${++n}`,
    sessionId: o.sessionId,
    cwd: o.cwd,
    timestamp: new Date(o.ts ?? T0).toISOString(),
    message: {
      model: o.model ?? 'claude-opus-5-5',
      usage: {
        input_tokens: o.input ?? 10,
        cache_read_input_tokens: o.cacheRead ?? 1000,
        cache_creation_input_tokens: o.cacheWrite ?? 100,
        output_tokens: o.output ?? 50,
      },
    },
  }) + '\n';
}

describe('UsageLedger — Slice 1', () => {
  let tmp: string;
  let home: string;
  let other: string;
  let configDir: string;
  let ledger: UsageLedger;

  function projectDir(cwd: string): string {
    const d = path.join(configDir, 'projects', encodeClaudeProjectDir(cwd));
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  function writeTranscript(cwd: string, sessionId: string, lines: string[], sub?: string): string {
    const base = projectDir(cwd);
    const file = sub
      ? path.join(base, sessionId, 'subagents', `${sub}.jsonl`)
      : path.join(base, `${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, lines.join(''));
    return file;
  }

  function newLedger(dbPath = ':memory:'): UsageLedger {
    const l = new UsageLedger({
      dbPath, machineId: 'm_test', agentId: 'echo', agentHomes: [home], otherAgentHomes: [other],
      now: () => T0 + 3_600_000,
    });
    l.addClaudeRoot(configDir, 'test');
    return l;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-ledger-'));
    home = path.join(tmp, 'agents', 'echo');
    other = path.join(home, 'nested-agent');
    configDir = path.join(tmp, 'claude-config');
    fs.mkdirSync(home, { recursive: true });
    ledger = newLedger();
  });
  afterEach(() => {
    ledger.close();
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/UsageLedger.test.ts cleanup' });
  });

  it('maps Claude usage to disjoint parts, null when unreported', () => {
    expect(claudeUsageToParts({ input_tokens: 5, cache_read_input_tokens: 900, output_tokens: 7 }))
      .toEqual({ input: 5, cacheRead: 900, cacheWrite: null, output: 7, reasoning: null });
  });

  it('counts a member session once and rolls it up by hour, day and session-day', () => {
    writeTranscript(home, 's1', [line({ sessionId: 's1', cwd: home }), line({ sessionId: 's1', cwd: home })]);
    const r = ledger.scanTick();
    expect(r.rowsCounted).toBe(2);
    const t = ledger.totals(T0);
    expect(t).toMatchObject({ calls: 2, input: 20, cacheRead: 2000, cacheWrite: 200, output: 100 });
    expect(t.missing.reasoning).toBe(2);
    expect(ledger.totalsFromEvents(T0)).toMatchObject({ calls: 2, input: 20, cacheRead: 2000 });
    // Re-scan of an unchanged file adds nothing.
    expect(ledger.scanTick().filesRead).toBe(0);
    expect(ledger.totals(T0).calls).toBe(2);
    expect(ledger.rollupRowCount('rollup_session_day')).toBe(1);
  });

  it('two "none" dimensions share one rollup row (NOT NULL sentinel)', () => {
    writeTranscript(home, 'a', [line({ sessionId: 'a', cwd: home })]);
    writeTranscript(home, 'b', [line({ sessionId: 'b', cwd: home })]);
    ledger.scanTick();
    expect(ledger.rollupRowCount('rollup_day')).toBe(1);
    expect(ledger.rollupRowCount('rollup_hour')).toBe(1);
  });

  it('scope: skips other agents, a nested agent home, and a sibling sharing the encoded prefix', () => {
    const sibling = home + '-x';
    fs.mkdirSync(sibling, { recursive: true });
    writeTranscript(path.join(tmp, 'elsewhere'), 'x1', [line({ sessionId: 'x1', cwd: path.join(tmp, 'elsewhere') })]);
    writeTranscript(other, 'x2', [line({ sessionId: 'x2', cwd: other })]);
    // The sibling dir name starts with the home's encoding, so it is ruled IN for reading,
    // but the transcript's own cwd decides membership.
    writeTranscript(sibling, 'x3', [line({ sessionId: 'x3', cwd: sibling })]);
    writeTranscript(path.join(home, 'sub'), 'ok', [line({ sessionId: 'ok', cwd: path.join(home, 'sub') })]);
    ledger.scanTick();
    expect(ledger.totals(T0).calls).toBe(1);
    expect(ledger.statusCounts()).toEqual({ 'counted:cwd': 1 });
  });

  it('a spawn record counts a builder session outside the home, with time-matched attribution', () => {
    const worktree = path.join(tmp, 'builders', 'wt');
    ledger.recordBinding({ sessionId: 'b1', framework: 'claude-code', sessionKind: 'job', cwd: worktree, topicId: '141063', jobSlug: 'build', runId: 'r1', accountId: 'acct-1', validFrom: T0 - 1000 });
    writeTranscript(worktree, 'b1', [line({ sessionId: 'b1', cwd: worktree })]);
    ledger.scanTick();
    expect(ledger.statusCounts()).toEqual({ 'counted:spawn-record': 1 });
    const rows = ledger.rollupChangesAfter(0, 100).filter(c => c.table === 'rollup_hour');
    expect(rows[0].row).toMatchObject({ topic: '141063', job: 'build', run: 'r1', session_kind: 'job' });
  });

  it('a hook-reported id whose transcript cwd differs falls to the cwd rule', () => {
    ledger.recordBinding({ sessionId: 'h1', framework: 'claude-code', sessionKind: 'interactive', cwd: path.join(tmp, 'somewhere-else'), topicId: '1', jobSlug: null, runId: null, accountId: null, validFrom: T0 - 1000 });
    writeTranscript(home, 'h1', [line({ sessionId: 'h1', cwd: home })]);
    ledger.scanTick();
    expect(ledger.statusCounts()).toEqual({ 'counted:cwd': 1 });
  });

  it('attribution joins on the request time, not on today\'s binding', () => {
    ledger.recordBinding({ sessionId: 't1', framework: 'claude-code', sessionKind: 'interactive', cwd: home, topicId: 'old', jobSlug: null, runId: null, accountId: null, validFrom: T0 - 10_000 });
    ledger.recordBinding({ sessionId: 't1', framework: 'claude-code', sessionKind: 'interactive', cwd: home, topicId: 'new', jobSlug: null, runId: null, accountId: null, validFrom: T0 + 10 });
    writeTranscript(home, 't1', [line({ sessionId: 't1', cwd: home, ts: T0 }), line({ sessionId: 't1', cwd: home, ts: T0 + 20 })]);
    ledger.scanTick();
    const topics = ledger.rollupChangesAfter(0, 100).filter(c => c.table === 'rollup_hour').map(c => c.row.topic).sort();
    expect(topics).toEqual(['new', 'old']);
  });

  it('subagent transcripts are tagged and attributed through their parent', () => {
    ledger.recordBinding({ sessionId: 'p1', framework: 'claude-code', sessionKind: 'interactive', cwd: home, topicId: '7', jobSlug: null, runId: null, accountId: null, validFrom: T0 - 1000 });
    writeTranscript(home, 'p1', [line({ sessionId: 'agent-1', cwd: home })], 'agent-1');
    ledger.scanTick();
    const hour = ledger.rollupChangesAfter(0, 100).find(c => c.table === 'rollup_hour')!;
    expect(hour.row).toMatchObject({ session_kind: 'subagent', topic: '7' });
  });

  it('appended lines are read from the checkpoint; a partial last line waits', () => {
    const f = writeTranscript(home, 'c1', [line({ sessionId: 'c1', cwd: home })]);
    ledger.scanTick();
    const partial = line({ sessionId: 'c1', cwd: home });
    fs.appendFileSync(f, partial.slice(0, 20));
    ledger.scanTick();
    expect(ledger.totals(T0).calls).toBe(1);
    fs.appendFileSync(f, partial.slice(20));
    ledger.scanTick();
    expect(ledger.totals(T0).calls).toBe(2);
  });

  it('replay safety: re-reading after raw rows were pruned adds nothing to the rollups', () => {
    const f = writeTranscript(home, 'r1', [line({ sessionId: 'r1', cwd: home }), line({ sessionId: 'r1', cwd: home })]);
    ledger.scanTick();
    // Raw rows gone (retention); the file is re-read from the start for detail.
    const pruned = (ledger as unknown as { db: import('better-sqlite3').Database }).db;
    pruned.prepare('DELETE FROM usage_events').run();
    ledger.ingestClaudeFile(configDir, f, { rescanForDetail: true });
    expect(ledger.totals(T0).calls).toBe(2);
    expect(ledger.statusCounts()).toEqual({ 'replay:cwd': 2 });
  });

  it('a replaced file (new identity) starts its checkpoint from zero', () => {
    const f = writeTranscript(home, 'z1', [line({ sessionId: 'z1', cwd: home })]);
    ledger.scanTick();
    SafeFsExecutor.safeRmSync(f, { force: true, operation: 'tests/unit/UsageLedger.test.ts replace file' });
    writeTranscript(home, 'z1', [line({ sessionId: 'z1', cwd: home, requestId: 'fresh-1' }), line({ sessionId: 'z1', cwd: home, requestId: 'fresh-2' })]);
    ledger.scanTick();
    expect(ledger.totals(T0).calls).toBe(3);
  });

  it('copied history (rows older than their file) is stored but not counted', () => {
    const f = writeTranscript(home, 'cp', [line({ sessionId: 'cp', cwd: home, ts: Date.parse('2020-01-01T00:00:00Z') })]);
    const birth = fs.statSync(f).birthtimeMs;
    ledger.scanTick();
    if (birth > 0) {
      expect(ledger.statusCounts()).toEqual({ 'copied-history:cwd': 1 });
      expect(ledger.totals(0).calls).toBe(0);
    } else {
      // No birth time on this filesystem: the rule is skipped and the row counts.
      expect(ledger.totals(0).calls).toBe(1);
    }
  });

  it('respects the depth limit and ignores symlinked files', () => {
    const base = projectDir(home);
    const deep = path.join(base, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'deep.jsonl'), line({ sessionId: 'deep', cwd: home }));
    const real = writeTranscript(home, 'real', [line({ sessionId: 'real', cwd: home })]);
    fs.symlinkSync(real, path.join(base, 'link.jsonl'));
    ledger.scanTick();
    expect(ledger.totals(T0).calls).toBe(1);
    expect(ledger.listRoots()[0].filesTooDeep).toBeGreaterThan(0);
  });

  it('shares one file budget round-robin across roots', () => {
    const second = path.join(tmp, 'claude-2');
    const l = new UsageLedger({ dbPath: ':memory:', machineId: 'm', agentId: 'echo', agentHomes: [home], filesPerTick: 2, now: () => T0 + 3_600_000 });
    l.addClaudeRoot(configDir, 'a');
    l.addClaudeRoot(second, 'b');
    for (let i = 0; i < 3; i++) writeTranscript(home, `r${i}`, [line({ sessionId: `r${i}`, cwd: home })]);
    const d2 = path.join(second, 'projects', encodeClaudeProjectDir(home));
    fs.mkdirSync(d2, { recursive: true });
    for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(d2, `q${i}.jsonl`), line({ sessionId: `q${i}`, cwd: home }));
    const r = l.scanTick();
    expect(r.filesRead).toBe(2);
    expect(r.pending).toBe(4);
    const roots = l.listRoots();
    expect(roots.map(x => x.filesScanned)).toEqual([1, 1]);
    l.close();
  });

  it('crash mid-batch leaves rows, rollups and checkpoint together (one transaction)', () => {
    const f = writeTranscript(home, 'k1', [line({ sessionId: 'k1', cwd: home }), '{not json}\n', line({ sessionId: 'k1', cwd: home })]);
    ledger.ingestClaudeFile(configDir, f);
    expect(ledger.totals(T0).calls).toBe(ledger.totalsFromEvents(T0).calls);
  });

  it('pruning removes old raw rows and keeps day totals; the row ceiling applies', () => {
    const l = new UsageLedger({ dbPath: ':memory:', machineId: 'm', agentId: 'echo', agentHomes: [home], maxRawRows: 1, now: () => T0 + 3_600_000 });
    l.addClaudeRoot(configDir, 'a');
    writeTranscript(home, 'p', [line({ sessionId: 'p', cwd: home }), line({ sessionId: 'p', cwd: home }), line({ sessionId: 'p', cwd: home })]);
    l.scanTick();
    expect(l.rawRowCount).toBe(3);
    l.prune();
    expect(l.rawRowCount).toBe(1);
    expect(l.totals(T0).calls).toBe(3);
    l.close();
  });

  it('change_seq increases and a persisted ledger keeps its generation id', () => {
    const dbPath = path.join(tmp, 'server-data', 'usage-ledger.db');
    const a = newLedger(dbPath);
    const gen = a.generationId;
    writeTranscript(home, 'g', [line({ sessionId: 'g', cwd: home })]);
    a.scanTick();
    const seqs = a.rollupChangesAfter(0, 100).map(c => c.row.change_seq as number);
    expect(Math.min(...seqs)).toBeGreaterThan(0);
    a.close();
    const b = newLedger(dbPath);
    expect(b.generationId).toBe(gen);
    expect(b.totals(T0).calls).toBe(1);
    b.close();
  });
});
