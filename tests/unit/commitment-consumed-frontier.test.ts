import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommitmentConsumedFrontier, resolveCommitmentFrontierFlags } from '../../src/scheduler/CommitmentConsumedFrontier.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/commitment-consumed-frontier.test.ts' }); });
function row(id: string | number, text = 'No promise here.') { return JSON.stringify({ messageId: id, topicId: 7, fromUser: true, telegramUserId: 42, provenance: 'user', text, timestamp: '2026-11-23T20:00:00Z' }) + '\n'; }
function rig(lines = [row(2), row('4618647761419478')]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontier-')); dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'telegram-messages.jsonl'), lines.join(''));
  const service = new CommitmentConsumedFrontier({ stateDir: dir, machineId: () => 'm1', canWrite: () => true, sessions: () => [] });
  service.setActionReader(() => []);
  return { dir, service };
}
const on = { enabled: true, skipEnabled: false };
const active = { enabled: true, skipEnabled: true };
async function finish(service: CommitmentConsumedFrontier, plan: Awaited<ReturnType<CommitmentConsumedFrontier['plan']>>, uncertain = false) {
  const batch = plan.batch!;
  service.bind(batch.batchId, 'sid', 'run');
  fs.writeFileSync(batch.ackPath, JSON.stringify({ version: 1, batchId: batch.batchId, sessionName: batch.sessionName,
    batchHash: batch.batchHash, decisions: batch.rows.map((r, i) => ({ key: r.key, outcome: uncertain && i === 0 ? 'uncertain' : 'reviewed-no-action' })) }));
  return service.complete({ batchId: batch.batchId, sessionName: batch.sessionName, sessionId: 'sid', runId: 'run', status: 'completed', consumer: 'consumer', flags: on });
}

describe('durable exact commitment source coverage', () => {
  it('is off by default and touches no new state', async () => {
    const { dir, service } = rig();
    expect(resolveCommitmentFrontierFlags({})).toEqual({ enabled: false, skipEnabled: false });
    expect((await service.plan('consumer', 's', { enabled: false, skipEnabled: true })).verdict).toBe('normal');
    expect(fs.existsSync(path.join(dir, 'state', 'commitment-frontier'))).toBe(false);
  });
  it('needs every actual row, independent of numeric message ids; durable receipt reloads', async () => {
    const { dir, service } = rig();
    const first = await service.plan('consumer', 'first', on);
    expect(first.verdict).toBe('normal'); expect(first.batch!.rows).toHaveLength(2);
    expect((await finish(service, first)).recorded).toBe(true);
    const rebuilt = new CommitmentConsumedFrontier({ stateDir: dir, machineId: () => 'm1', canWrite: () => true, sessions: () => [] }); rebuilt.setActionReader(() => []);
    expect((await rebuilt.plan('consumer', 'next', active)).verdict).toBe('skip');
    expect((await rebuilt.plan('consumer', 'shadow', on)).verdict).toBe('would-skip');
  });
  it('unknown early history never starves newer recent-message input', async () => {
    const { dir, service } = rig(Array.from({ length: 103 }, (_, n) => row(n)));
    const first = await service.plan('consumer', 'first', on);
    expect(first.batch!.rows).toHaveLength(100);
    expect(first.batch!.rows[0].message.messageId).toBe('3');
    expect((await finish(service, first, true)).recorded).toBe(true);
    fs.appendFileSync(path.join(dir, 'telegram-messages.jsonl'), row(104, 'I will send the report.'));
    const next = await service.plan('consumer', 'next', active);
    expect(next.verdict).toBe('normal');
    expect(next.batch!.rows.at(-1)!.message.messageId).toBe('104');
  });
  it.each(['failed', 'killed', 'running', 'starting'])('status %s cannot certify consumption', async (status) => {
    const { service } = rig(); const plan = await service.plan('consumer', 's', on); const batch = plan.batch!;
    service.bind(batch.batchId, 'sid', 'run');
    expect((await service.complete({ batchId: batch.batchId, sessionName: 's', sessionId: 'sid', runId: 'run', status, consumer: 'consumer', flags: on })).recorded).toBe(false);
    expect((await service.plan('consumer', 'next', active)).verdict).toBe('normal');
  });
  it('source edit, truncation, missing history and consumer changes always review', async () => {
    const { dir, service } = rig(); await finish(service, await service.plan('consumer', 's', on));
    expect((await service.plan('changed-consumer', 'next', active)).verdict).toBe('normal');
    fs.writeFileSync(path.join(dir, 'telegram-messages.jsonl'), row(2, 'Changed source'));
    expect((await service.plan('consumer', 'next', active)).verdict).toBe('normal');
    fs.writeFileSync(path.join(dir, 'telegram-messages.jsonl'), '');
    expect((await service.plan('consumer', 'empty', active)).verdict).toBe('normal');
  });
});

describe('acknowledgement and source uncertainty boundaries', () => {
  it.each(['missing-row', 'duplicate-row', 'unknown-key', 'wrong-hash', 'fake-action', 'changed-batch'])('%s never certifies coverage', async (kind) => {
    const { service } = rig(); const plan = await service.plan('consumer', 's', on); const batch = plan.batch!;
    service.bind(batch.batchId, 'sid', 'run');
    const ack: any = { version: 1, batchId: batch.batchId, sessionName: 's', batchHash: batch.batchHash,
      decisions: batch.rows.map(r => ({ key: r.key, outcome: 'reviewed-no-action' })) };
    if (kind === 'missing-row') ack.decisions.pop();
    if (kind === 'duplicate-row') ack.decisions[1] = ack.decisions[0];
    if (kind === 'unknown-key') ack.privatePrompt = 'PRIVATE-MUST-NOT-PROPAGATE';
    if (kind === 'wrong-hash') ack.batchHash = 'f'.repeat(64);
    if (kind === 'fake-action') ack.decisions[0] = { key: batch.rows[0].key, outcome: 'registered', actionIds: ['ACT-999'] };
    if (kind === 'changed-batch') fs.appendFileSync(batch.batchPath, ' ');
    fs.writeFileSync(batch.ackPath, JSON.stringify(ack));
    expect((await service.complete({ batchId: batch.batchId, sessionName: 's', sessionId: 'sid', runId: 'run', status: 'completed', consumer: 'consumer', flags: on })).recorded).toBe(false);
    expect((await service.plan('consumer', 'again', active)).verdict).toBe('normal');
  });
  it('wrong binding does not consume a real batch; explicit completion records once', async () => {
    const { service } = rig(); const plan = await service.plan('consumer', 's', on); const batch = plan.batch!;
    service.bind(batch.batchId, 'sid', 'run');
    const input = { batchId: batch.batchId, sessionName: 's', sessionId: 'other', runId: 'run', status: 'completed', consumer: 'consumer', flags: on };
    expect((await service.complete(input)).recorded).toBe(false);
    fs.writeFileSync(batch.ackPath, JSON.stringify({ version: 1, batchId: batch.batchId, sessionName: 's', batchHash: batch.batchHash,
      decisions: batch.rows.map(r => ({ key: r.key, outcome: 'reviewed-no-action' })) }));
    expect((await service.complete({ ...input, sessionId: 'sid' })).recorded).toBe(true);
    expect((await service.complete({ ...input, sessionId: 'sid' })).recorded).toBe(false);
  });
  it('source appended after admission is not silently covered', async () => {
    const { dir, service } = rig(); const plan = await service.plan('consumer', 's', on);
    fs.appendFileSync(path.join(dir, 'telegram-messages.jsonl'), row(3));
    expect((await finish(service, plan)).recorded).toBe(true);
    expect((await service.plan('consumer', 'new', active)).verdict).toBe('normal');
  });
  it('an explicit reviewed historical range can close a gap without changing recent selection', async () => {
    const lines = Array.from({ length: 102 }, (_, n) => row(n));
    const { service } = rig(lines); await finish(service, await service.plan('consumer', 'recent', on));
    const gapEnd = Buffer.byteLength(lines[0] + lines[1]);
    const history = await service.plan('consumer', 'explicit-history', on, { start: 0, end: gapEnd });
    expect(history.batch!.rows.map(r => r.message.messageId)).toEqual(['0', '1']);
    expect((await finish(service, history)).recorded).toBe(true);
    expect((await service.plan('consumer', 'next', active)).verdict).toBe('skip');
  });
  it.each(['not-json\n', row(1).trimEnd(), row(1) + '\n'])('malformed or incomplete source remains normal review', async (raw) => {
    const { dir, service } = rig(); fs.writeFileSync(path.join(dir, 'telegram-messages.jsonl'), raw);
    const plan = await service.plan('consumer', 's', active);
    expect(plan.verdict).toBe('normal'); expect(plan.batch).toBeUndefined();
  });
});

describe('canonical message principals and domains', () => {
  it.each(['sender', 'platform', 'mobile-person', 'agent'])('distinct %s identities never share a registration key', async (kind) => {
    const a: any = JSON.parse(row(1)); const b: any = { ...a };
    if (kind === 'sender') b.telegramUserId = 43;
    if (kind === 'platform') { a.platform = 'telegram'; b.platform = 'other-transport'; }
    if (kind === 'mobile-person') {
      a.via = b.via = 'mobile-device'; a.deviceId = b.deviceId = 'device'; a.eventId = b.eventId = 'event';
      a.senderPerson = { machineId: 'm1', userId: 'person1' }; b.senderPerson = { machineId: 'm1', userId: 'person2' };
    }
    if (kind === 'agent') { a.fromUser = b.fromUser = false; a.authorshipAgentId = 'agent1'; b.authorshipAgentId = 'agent2'; }
    const { service } = rig([JSON.stringify(a) + '\n', JSON.stringify(b) + '\n']);
    const plan = await service.plan('consumer', 's', on);
    expect(plan.batch!.rows[0].messageKey).not.toBeNull();
    expect(plan.batch!.rows[0].messageKey).not.toBe(plan.batch!.rows[1].messageKey);
  });
  it('exact mirrored envelopes share action identity despite different physical byte positions', async () => {
    const { service } = rig([row(1), row(1)]); const plan = await service.plan('consumer', 's', on);
    expect(plan.batch!.rows[0].key).not.toBe(plan.batch!.rows[1].key);
    expect(plan.batch!.rows[0].messageKey).toBe(plan.batch!.rows[1].messageKey);
  });
  it('unknown principal/direct-chat context never fabricates a reserved identity', async () => {
    const data = JSON.parse(row(1)); delete data.telegramUserId;
    const { service } = rig([JSON.stringify(data) + '\n']);
    expect((await service.plan('consumer', 'unknown', on)).batch!.rows[0].messageKey).toBeNull();
    const direct = { ...data, topicId: null, telegramUserId: 42 };
    const second = rig([JSON.stringify(direct) + '\n']);
    expect((await second.service.plan('consumer', 'direct', on)).batch!.rows[0].messageKey).toBeNull();
  });
});
