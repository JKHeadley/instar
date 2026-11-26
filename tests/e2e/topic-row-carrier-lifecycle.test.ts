// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.

/**
 * context-budget-layered-summaries §14 / §18 Tier 3 — the relay-path row carrier
 * on the production modules across a real restart:
 *
 *  1. This process is the forwarder: a real TopicMemory, the real row writer and
 *     the real carrier build the carried row exactly as the router's `carryRow`
 *     does. The owner is a CHILD PROCESS (vite-node, the production modules, the
 *     real deliverMessage handler wired the way server.ts wires it). The first
 *     owner process dies between the row write and the receipt (a crash); the
 *     forwarder, having no ack, re-delivers to a fresh owner process on the same
 *     state directory, which answers `queued` and holds exactly one row: none
 *     lost, none doubled. A second scenario dies BEFORE the row is written and
 *     shows the redelivery lands it.
 *  2. WIRED source checks (dead-code guard): server.ts builds the carrier beside
 *     the row writer, carries the row on the router's forward and placement hop,
 *     lands it in the deliverMessage handler, serves `topic-row-pull`, builds the
 *     pull coordinator, and hands the fold coordinator `topicRowsPresent` from the
 *     carrier (no longer a constant false). The verb is registered read/observe.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { TopicRowWriter } from '../../src/memory/topicRowWriter.js';
import { TopicRowWatermarkStore } from '../../src/memory/topicRowWatermark.js';
import { TopicRowCarrier, slackSyntheticTopicId } from '../../src/memory/topicRowCarrier.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/e2e/topic-row-carrier-lifecycle.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOPIC = 5150;

// The owner process. `crash` = 'after-row' | 'before-row' | 'none'.
const OWNER = `
import fs from 'node:fs';
import path from 'node:path';
import { TopicMemory } from ${JSON.stringify(path.join(ROOT, 'src/memory/TopicMemory.ts'))};
import { TopicRowWriter } from ${JSON.stringify(path.join(ROOT, 'src/memory/topicRowWriter.ts'))};
import { TopicRowWatermarkStore } from ${JSON.stringify(path.join(ROOT, 'src/memory/topicRowWatermark.ts'))};
import { TopicRowCarrier, slackSyntheticTopicId } from ${JSON.stringify(path.join(ROOT, 'src/memory/topicRowCarrier.ts'))};
import { createDeliverMessageHandler } from ${JSON.stringify(path.join(ROOT, 'src/core/DeliverMessageHandler.ts'))};
const [stateDir, cmdFile, crash] = process.argv.slice(-3);
const tm = new TopicMemory(stateDir);
await tm.open();
const store = new TopicRowWatermarkStore({ dbPath: path.join(stateDir, 'state', 'topic-row-carrier', 'carrier.db'), machineId: 'm_owner' });
const writer = new TopicRowWriter({ topicMemory: () => tm });
const carrier = new TopicRowCarrier({ store, topicMemory: () => tm, writer, enabled: () => true, slackTopicId: slackSyntheticTopicId });
const receiptsFile = path.join(stateDir, 'receipts.json');
const receipts = new Set(fs.existsSync(receiptsFile) ? JSON.parse(fs.readFileSync(receiptsFile, 'utf-8')) : []);
const handler = createDeliverMessageHandler({
  ownerEpochOf: () => 1,
  landRow: (cmd) => {
    if (crash === 'before-row') process.exit(17);
    carrier.land(cmd.session, cmd.messageId, cmd.row);
  },
  recordReceipt: (messageId) => {
    if (crash === 'after-row') process.exit(17); // the row is on disk; the receipt never is
    if (receipts.has(messageId)) return false;
    receipts.add(messageId);
    fs.writeFileSync(receiptsFile, JSON.stringify([...receipts]));
    return true;
  },
});
const ack = handler(JSON.parse(fs.readFileSync(cmdFile, 'utf-8')), 'm_router', {});
console.log(JSON.stringify({ ack, rows: tm.getRecentMessages(${TOPIC}, 50).length, present: carrier.rowsPresent('${TOPIC}'), gaps: carrier.status(${TOPIC}).gaps }));
store.close(); tm.close();
process.exit(0);
`;

describe('row carrier across a real owner restart', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });
  const mk = (tag: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `row-carrier-e2e-${tag}-`)); dirs.push(d); return d; };

  async function forwarderCommand(dir: string, id: number, text: string): Promise<string> {
    const tm = new TopicMemory(dir);
    await tm.open();
    const store = new TopicRowWatermarkStore({ dbPath: path.join(dir, 'carrier.db'), machineId: 'm_router' });
    const writer = new TopicRowWriter({ topicMemory: () => tm });
    const carrier = new TopicRowCarrier({ store, topicMemory: () => tm, writer, enabled: () => true, slackTopicId: slackSyntheticTopicId });
    // The adapter logs the inbound message first (S2 writer), as the Telegram poller does.
    writer.writeRow({ channel: 'telegram', nativeId: id }, { topicId: TOPIC, text, fromUser: true, timestamp: '2026-11-10T12:00:00.000Z', sessionName: null, senderName: 'Justin' });
    const row = carrier.carry(String(TOPIC), String(id));
    store.close(); tm.close();
    const cmdFile = path.join(dir, `cmd-${id}.json`);
    fs.writeFileSync(cmdFile, JSON.stringify({ type: 'deliverMessage', session: String(TOPIC), messageId: String(id), payload: text, ownershipEpoch: 1, row }));
    return cmdFile;
  }

  const runOwner = (stateDir: string, cmdFile: string, crash: string) => {
    const script = path.join(stateDir, 'owner.ts');
    fs.writeFileSync(script, OWNER);
    return spawnSync(path.join(ROOT, 'node_modules/.bin/vite-node'), [script, stateDir, cmdFile, crash], { cwd: ROOT, encoding: 'utf-8', timeout: 90_000 });
  };
  const parse = (stdout: string) => JSON.parse(stdout.trim().split('\n').pop() as string) as { ack: { accepted: string }; rows: number; present: boolean; gaps: unknown[] };

  it('a crash after the row write and before the receipt: the redelivery is queued and the row is there once', async () => {
    const fwd = mk('fwd'); const owner = mk('owner');
    const cmd = await forwarderCommand(fwd, 701, 'survives the crash');
    const crashed = runOwner(owner, cmd, 'after-row');
    expect(crashed.status, crashed.stderr).toBe(17);
    const again = runOwner(owner, cmd, 'none');
    expect(again.status, again.stderr).toBe(0);
    expect(parse(again.stdout)).toEqual({ ack: { messageId: '701', accepted: 'queued' }, rows: 1, present: true, gaps: [] });
    // A further duplicate redelivery: still one row.
    const dup = parse(runOwner(owner, cmd, 'none').stdout);
    expect(dup).toMatchObject({ ack: { accepted: 'duplicate' }, rows: 1, present: true });
  }, 240_000);

  it('a crash before the row write: the redelivery lands it', async () => {
    const fwd = mk('fwd2'); const owner = mk('owner2');
    const cmd = await forwarderCommand(fwd, 702, 'lands on redelivery');
    expect(runOwner(owner, cmd, 'before-row').status).toBe(17);
    const tm = new TopicMemory(owner); await tm.open();
    expect(tm.getMessageCount(TOPIC)).toBe(0);
    tm.close();
    expect(parse(runOwner(owner, cmd, 'none').stdout)).toEqual({ ack: { messageId: '702', accepted: 'queued' }, rows: 1, present: true, gaps: [] });
  }, 240_000);
});

describe('WIRED: server.ts runs the carrier on the production boot path', () => {
  const server = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
  const rpc = fs.readFileSync(path.join(ROOT, 'src/core/MeshRpc.ts'), 'utf-8');

  it('builds the carrier beside the row writer, gated on contextBudget.enabled through the dev gate', () => {
    const i = server.indexOf('const topicRowWriter = new TopicRowWriter(');
    const block = server.slice(i, i + 3000);
    expect(block).toContain('new TopicRowWatermarkStore(');
    expect(block).toContain('_topicRowCarrier = new TopicRowCarrier(');
    expect(block).toMatch(/enabled: \(\) => rowCarrierEnabled\(liveConfig\.get<boolean \| undefined>\('contextBudget\.enabled'/);
    expect(block).toContain('writer: topicRowWriter');
  });

  it('the router carries the row on the forward and the placement hop', () => {
    const i = server.indexOf('_sessionRouter = new routerMod.SessionRouter(');
    const block = server.slice(i, i + 12000);
    expect(block).toContain('carryRow: (msg) => _topicRowCarrier?.carry(msg.sessionKey, msg.messageId) ?? null');
    expect(block).toContain('...(env.row != null ? { row: env.row } : {})');
    expect(block).toMatch(/spawnOnMachine: async \(machineId, msg, ownershipEpoch, row\)/);
    expect(block).toContain('...(row != null ? { row } : {})');
  });

  it('the deliverMessage handler lands the row and starts the arrival pull', () => {
    const i = server.indexOf('const deliverMessageHandler = deliverMod.createDeliverMessageHandler(');
    const block = server.slice(i, i + 9000);
    expect(block).toContain('landRow: (cmd, sender) => {');
    expect(block).toContain('carrier.land(cmd.session, cmd.messageId, (cmd as { row?: unknown }).row, sender || undefined)');
    expect(block).toContain('_topicRowPulls?.onTopicAccepted(addr.topicId, cmd.ownershipEpoch)');
  });

  it('serves topic-row-pull and builds the pull coordinator on the signed client', () => {
    expect(server).toContain("'topic-row-pull': (cmd) => _topicRowCarrier");
    const i = server.indexOf('_topicRowPulls = new TopicRowPullCoordinator(');
    expect(i).toBeGreaterThan(0);
    const block = server.slice(i, i + 2500);
    expect(block).toContain('meshClient.send(');
    expect(block).toContain('timeoutMs: ROW_PULL_TIMEOUT_MS');
    expect(block).toContain("kind: 'topic-placement'");
    expect(rpc).toMatch(/case 'topic-history-pull':\n\s+case 'topic-row-pull':/);
  });

  it('runs the repair sweep on a timer and pulls rows when this machine claims a topic for itself', () => {
    const i = server.indexOf('const rowSweep = setInterval(');
    expect(i).toBeGreaterThan(0);
    expect(server.slice(i, i + 400)).toContain('_topicRowPulls?.sweep()');
    const j = server.indexOf('casClaimOwnership: (sk, machineId) => {');
    expect(server.slice(j, j + 1800)).toContain('_topicRowPulls?.onTopicAcquired(rowTopic, prevOwner');
  });

  it('the fold precondition reads the carrier, not a constant', () => {
    expect(server).toContain('topicRowsPresent: (topicKey) => _topicRowCarrier?.rowsPresent(topicKey) ?? false');
    expect(server).not.toContain('topicRowsPresent: () => false');
  });

  it('the Slack synthetic id the carrier derives is the one the server files rows under', () => {
    expect(server).toContain('const syntheticId = slackSyntheticTopicId(channelId);');
  });
});
