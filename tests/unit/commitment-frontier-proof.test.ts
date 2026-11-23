import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { CommitmentConsumedFrontier, type FrontierPlan } from '../../src/scheduler/CommitmentConsumedFrontier.js';
import { EvolutionManager } from '../../src/core/EvolutionManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/commitment-frontier-proof.test.ts' }); });
const on = { enabled: true, skipEnabled: false }; const active = { enabled: true, skipEnabled: true };
const line = (id: number) => JSON.stringify({ messageId: id, topicId: 7, fromUser: true, telegramUserId: 42, provenance: 'user', timestamp: '2026-11-23T20:00:00Z', text: 'I will send a report.' }) + '\n';
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-proof-')); dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'telegram-messages.jsonl'), line(1));
  let writable = true; let enabled = true;
  const service = new CommitmentConsumedFrontier({ stateDir: dir, machineId: () => 'm1', canWrite: () => writable,
    sessions: () => [], flags: () => ({ enabled, skipEnabled: true }) });
  const evolution = new EvolutionManager({ stateDir: dir }); evolution.setCommitmentReceiptModeProvider(() => enabled);
  service.setActionReader(() => evolution.listCommitmentReceiptActions());
  return { dir, service, evolution, setWritable(v: boolean) { writable = v; }, setEnabled(v: boolean) { enabled = v; } };
}
function ack(service: CommitmentConsumedFrontier, plan: FrontierPlan, actions?: string[]) {
  const b = plan.batch!; service.bind(b.batchId, 'sid', 'run');
  fs.writeFileSync(b.ackPath, JSON.stringify({ version: 1, batchId: b.batchId, sessionName: b.sessionName, batchHash: b.batchHash,
    decisions: b.rows.map(r => actions ? { key: r.key, outcome: 'registered', actionIds: actions } : { key: r.key, outcome: 'reviewed-no-action' }) }));
  return { batchId: b.batchId, sessionName: b.sessionName, sessionId: 'sid', runId: 'run', status: 'completed', consumer: 'c', flags: on };
}

describe('receipt effect and crash boundaries', () => {
  it('registered proof is real and is invalidated by independent action-store rollback', async () => {
    const { dir, service, evolution } = setup(); const plan = await service.plan('c', 's', on);
    const action = evolution.addAction({ title: 'Send report', description: 'A real registered effect.', followThroughOptOutReason: 'No stated due time.',
      source: { platform: 'commitment-detection', contentId: `cf1:${plan.batch!.rows[0].messageKey}:0` } });
    expect((await service.complete(ack(service, plan, [action.id]))).recorded).toBe(true);
    expect((await service.plan('c', 'quiet', active)).verdict).toBe('skip');
    const file = path.join(dir, 'state', 'evolution', 'action-queue.json'); const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    stored.actions = []; fs.writeFileSync(file, JSON.stringify(stored));
    expect((await service.plan('c', 'lost-effect', active)).verdict).toBe('normal');
    expect(evolution.listActions()).toEqual([]);
  });
  it('a different registered source key cannot certify the current source row', async () => {
    const { service, evolution } = setup(); const plan = await service.plan('c', 's', on);
    const action = evolution.addAction({ title: 'Other message', description: 'Unrelated.', followThroughOptOutReason: 'No stated due time.',
      source: { platform: 'commitment-detection', contentId: `cf1:${'f'.repeat(64)}:0` } });
    expect((await service.complete(ack(service, plan, [action.id]))).recorded).toBe(false);
  });
  it('concurrent and stale completions cannot overwrite newer consumption', async () => {
    const { dir, service } = setup();
    const other = new CommitmentConsumedFrontier({ stateDir: dir, machineId: () => 'm1', canWrite: () => true, sessions: () => [] }); other.setActionReader(() => []);
    const a = await service.plan('c', 'a', on); const b = await other.plan('c', 'b', on);
    const results = await Promise.all([service.complete(ack(service, a)), other.complete(ack(other, b))]);
    expect(results.filter(r => r.recorded)).toHaveLength(1);
    expect((await service.plan('c', 'next', active)).verdict).toBe('skip');
  });
  it('a process exiting mid-transaction rolls back and releases its lock', async () => {
    const { dir, service } = setup(); const first = await service.plan('c', 's', on); await service.complete(ack(service, first));
    const child = spawnSync(process.execPath, ['-e', "const Database=require('better-sqlite3');const d=new Database(process.argv[1]);d.exec('BEGIN IMMEDIATE');d.prepare('UPDATE coverage SET payload=? WHERE id=1').run('uncommitted-corruption');process.exit(17)", service.receiptPath], { cwd: process.cwd(), encoding: 'utf8', timeout: 10000 });
    expect(child.status, child.stderr).toBe(17);
    expect((await service.plan('c', 'still-valid', active)).verdict).toBe('skip');
    fs.appendFileSync(path.join(dir, 'telegram-messages.jsonl'), line(2));
    const next = await service.plan('c', 'after-crash', on);
    expect((await service.complete(ack(service, next))).recorded).toBe(true);
  });
  it('busy storage does not lose old proof or consume new input', async () => {
    const { dir, service } = setup(); await service.complete(ack(service, await service.plan('c', 'first', on)));
    fs.appendFileSync(path.join(dir, 'telegram-messages.jsonl'), line(2)); const next = await service.plan('c', 'next', on);
    const database = new Database(service.receiptPath); database.exec('BEGIN IMMEDIATE');
    try { expect((await service.complete(ack(service, next))).recorded).toBe(false); }
    finally { database.exec('ROLLBACK'); database.close(); }
    expect((await service.plan('c', 'unconsumed', active)).verdict).toBe('normal');
  });
  it.each(['flag', 'role'])('live %s narrowing refuses promotion', async (kind) => {
    const rig = setup(); const plan = await rig.service.plan('c', 's', on); const input = ack(rig.service, plan);
    if (kind === 'flag') rig.setEnabled(false); else rig.setWritable(false);
    expect((await rig.service.complete(input)).recorded).toBe(false);
    expect(fs.existsSync(rig.service.receiptPath)).toBe(false);
  });
  it('corrupted or unknown receipt fields return normal review rather than being rewritten', async () => {
    const { service } = setup(); await service.complete(ack(service, await service.plan('c', 's', on)));
    const database = new Database(service.receiptPath);
    const payload = JSON.parse((database.prepare('SELECT payload FROM coverage WHERE id=1').get() as { payload: string }).payload);
    payload.privatePrompt = 'DO-NOT-EXPORT'; database.prepare('UPDATE coverage SET payload=? WHERE id=1').run(JSON.stringify(payload)); database.close();
    const next = await service.plan('c', 'unknown-metadata', active); expect(next.verdict).toBe('normal'); expect(next.batch).toBeUndefined();
  });
  it('only authoritative terminal orphan files are removed; unknown orphans do not prevent capture', async () => {
    const { dir, service } = setup(); const first = await service.plan('c', 'old', on); const batch = first.batch!;
    let status = 'running';
    const rebuilt = new CommitmentConsumedFrontier({ stateDir: dir, machineId: () => 'm1', canWrite: () => true,
      sessions: () => [{ name: 'old', status }] }); rebuilt.setActionReader(() => []);
    await rebuilt.recoverTerminalBatches(); expect(fs.existsSync(batch.batchPath)).toBe(true);
    const fresh = await rebuilt.plan('c', 'fresh', on); expect(fresh.batch).toBeDefined();
    status = 'failed'; await rebuilt.recoverTerminalBatches(); expect(fs.existsSync(batch.batchPath)).toBe(false);
    expect(fs.existsSync(fresh.batch!.batchPath)).toBe(true);
  });
});
