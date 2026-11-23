/**
 * quota-pacing step 3 (docs/specs/quota-pacing-spend-by-account.md §1-§2): the usage ledger
 * records the served slot, account, identity and basis on every row source.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { UsageLedger, encodeClaudeProjectDir, SERVED_COLS } from '../../src/monitoring/UsageLedger.js';
import { IdentityCheckLog } from '../../src/monitoring/IdentityCheckLog.js';
import { ServedAccountResolver } from '../../src/monitoring/servedAccount.js';
import { identityKey } from '../../src/monitoring/quotaPacing.js';

const dirs: string[] = [];
const ledgers: UsageLedger[] = [];
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-served-')); dirs.push(d); return d; };
afterEach(() => {
  for (const l of ledgers.splice(0)) l.close();
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/UsageLedger.servedAccount.test.ts' });
});

const NOW = Date.now();

function claudeTranscript(root: string, cwd: string, sessionId: string, requestId: string, ts: number): string {
  const dir = path.join(root, 'projects', encodeClaudeProjectDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.appendFileSync(file, JSON.stringify({
    type: 'assistant', requestId, sessionId, cwd, timestamp: new Date(ts).toISOString(),
    message: { model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }) + '\n');
  return file;
}

function codexRollout(root: string, cwd: string, id: string, ts: number): void {
  const dir = path.join(root, 'sessions', '2026', '11', '18');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `rollout-${id}.jsonl`), [
    { type: 'session_meta', payload: { id, cwd } },
    { type: 'turn_context', payload: { model: 'gpt-6-astra' } },
    { type: 'event_msg', timestamp: new Date(ts).toISOString(), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 50, output_tokens: 5 } } } },
  ].map(r => JSON.stringify(r) + '\n').join(''));
}

function setup(opts: { enabled?: () => boolean } = {}) {
  const home = temp(), slotA = temp(), slotB = temp(), state = temp();
  const accounts = [
    { id: 'claude-a', framework: 'claude-code', configHome: slotA, provider: 'anthropic', email: 'a@example.com' },
    { id: 'codex-b', framework: 'codex-cli', configHome: slotB, provider: 'openai', email: 'b@example.com' },
  ];
  const checks = new IdentityCheckLog({ stateDir: state, now: () => NOW - 60_000 });
  checks.record(slotA, { result: 'confirmed', identity: identityKey('anthropic', 'a@example.com') });
  const resolver = new ServedAccountResolver({ pool: () => accounts, checks, pollIntervalMs: 15 * 60_000 });
  const db = new Database(':memory:');
  const ledger = new UsageLedger({
    dbPath: ':memory:', databaseFactory: () => db, machineId: 'm1', agentId: 'agent', agentHomes: [home],
    poolHomes: () => accounts.map(a => ({ framework: a.framework, configHome: a.configHome })),
    servedAccount: { enabled: opts.enabled ?? (() => true), resolver },
  });
  ledgers.push(ledger);
  return { home, slotA, slotB, db, ledger };
}

describe('served-account columns on the usage ledger', () => {
  it('a Claude transcript row records the slot, the confirmed account and identity; the tag stays beside it', async () => {
    const { home, slotA, db, ledger } = setup();
    ledger.recordBinding({ sessionId: 's1', framework: 'claude-code', sessionKind: 'interactive', cwd: home, topicId: null, jobSlug: null, runId: null, accountId: 'claude-tagged', validFrom: NOW - 120_000 });
    claudeTranscript(slotA, home, 's1', 'req-1', Date.now() + 1000);
    await ledger.scanTickAsync();
    const row = db.prepare('SELECT account_id, served_slot, served_account_id, served_identity, served_basis FROM usage_events').get();
    expect(row).toEqual({ account_id: 'claude-tagged', served_slot: path.resolve(slotA), served_account_id: 'claude-a', served_identity: identityKey('anthropic', 'a@example.com'), served_basis: 'enrollment-confirmed' });
    // A confirmed mismatch: tagged claude-tagged, served claude-a.
    const m = ledger.accountMismatches(0, 50, null);
    expect(m.total).toBe(1);
    expect(m.rows[0]).toMatchObject({ sessionId: 's1', tagged: 'claude-tagged', served: 'claude-a', servedBasis: 'enrollment-confirmed', confirmed: true });
  });

  it('a Codex rollout row is identity-unconfirmed and its mismatch is listed as unconfirmed', async () => {
    const { home, slotB, db, ledger } = setup();
    ledger.recordBinding({ sessionId: 'cx', framework: 'codex-cli', sessionKind: 'interactive', cwd: home, topicId: null, jobSlug: null, runId: null, accountId: 'codex-tagged', validFrom: NOW - 120_000 });
    codexRollout(slotB, home, 'cx', Date.now() + 2000);
    await ledger.scanTickAsync();
    expect(db.prepare('SELECT served_account_id, served_identity, served_basis FROM usage_events').get())
      .toEqual({ served_account_id: 'codex-b', served_identity: null, served_basis: 'identity-unconfirmed' });
    expect(ledger.accountMismatches(0, 50, null).rows[0]).toMatchObject({ confirmed: false, servedBasis: 'identity-unconfirmed' });
  });

  it('a one-shot invocation is its own no-transcript bucket, never a login', () => {
    const { db, ledger } = setup();
    ledger.enqueueInvocation({ feature: 'f', framework: 'claude-code', model: 'claude-opus-5-5', startedAt: NOW - 1000, endedAt: NOW, outcome: 'ok', usage: { input: 10, output: 2 }, jobSlug: null, runId: null });
    ledger.flushInvocations();
    expect(db.prepare('SELECT served_account_id, served_basis FROM usage_events').get()).toEqual({ served_account_id: null, served_basis: 'no-transcript' });
    const agg = ledger.servedAggregate(0, NOW + 1000);
    expect(agg).toHaveLength(1);
    expect(agg[0]).toMatchObject({ basis: 'no-transcript', identity: null, input: 10, output: 2 });
  });

  it('with the switch off rows are written as off and attribution never runs', async () => {
    const { home, slotA, db, ledger } = setup({ enabled: () => false });
    claudeTranscript(slotA, home, 's2', 'req-2', NOW - 30_000);
    await ledger.scanTickAsync();
    expect(db.prepare('SELECT served_slot, served_account_id, served_basis FROM usage_events').get()).toEqual({ served_slot: null, served_account_id: null, served_basis: 'off' });
  });

  it('the column migration is idempotent on an existing database; old rows read before-attribution', () => {
    const dir = temp();
    const dbPath = path.join(dir, 'ledger.db');
    // A database written by the previous build: the table exists without the served columns.
    const old = new UsageLedger({ dbPath, machineId: 'm1', agentId: 'agent', agentHomes: [dir] });
    old.enqueueInvocation({ feature: 'f', framework: 'claude-code', model: 'claude-opus-5-5', startedAt: NOW - 1000, endedAt: NOW, outcome: 'ok', usage: { input: 1, output: 1 }, jobSlug: null, runId: null });
    old.flushInvocations();
    const raw = new Database(dbPath);
    for (const c of SERVED_COLS) raw.exec(`UPDATE usage_events SET ${c} = NULL`);
    raw.close();
    old.close();
    for (let i = 0; i < 2; i++) {
      const again = new UsageLedger({ dbPath, machineId: 'm1', agentId: 'agent', agentHomes: [dir] });
      const cols = (new Database(dbPath).prepare('PRAGMA table_info(usage_events)').all() as { name: string }[]).map(c => c.name);
      for (const c of SERVED_COLS) expect(cols.filter(n => n === c)).toHaveLength(1);
      expect(again.servedAggregate(0, NOW + 1000)[0].basis).toBe('before-attribution');
      again.close();
    }
  });

  it('pages mismatches newest first with no row skipped across pages', async () => {
    const { home, slotA, ledger } = setup();
    for (let i = 0; i < 5; i++) {
      ledger.recordBinding({ sessionId: `s${i}`, framework: 'claude-code', sessionKind: 'interactive', cwd: home, topicId: null, jobSlug: null, runId: null, accountId: 'claude-tagged', validFrom: NOW - 200_000 });
      claudeTranscript(slotA, home, `s${i}`, `r${i}`, Date.now() + 1000 + i * 1000);
    }
    await ledger.scanTickAsync();
    const seen: string[] = [];
    let after: { lastTs: number; sessionId: string } | null = null;
    for (let p = 0; p < 5; p++) {
      const page = ledger.accountMismatches(0, 2, after);
      if (page.rows.length === 0) break;
      seen.push(...page.rows.map(r => r.sessionId));
      const last = page.rows[page.rows.length - 1];
      after = { lastTs: last.lastTs, sessionId: last.sessionId };
    }
    expect(seen).toEqual(['s4', 's3', 's2', 's1', 's0']);
  });
});
