// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.

/**
 * context-budget-layered-summaries §14 — e2e lifecycle of the channel-neutral
 * TopicMemory row writer:
 *
 *  1. Two child processes (vite-node, the production modules, no mocks) each
 *     stand for one machine: each opens its own real TopicMemory database and
 *     writes the SAME Slack and app-conversation messages through the real
 *     writer, then exits. This process then reopens both databases (a restart)
 *     and checks that every row survived and that both machines derived the
 *     same integer key for every message: the property §14 exists for.
 *  2. WIRED source check (dead-code guard): server.ts builds the writer on the
 *     real boot path, routes Telegram, Slack and app-conversation rows through
 *     it, no longer casts Slack ids to 0, gates app rows on
 *     `contextBudget.enabled` (read live), and hands the fold coordinator the
 *     writer's hasRowSource.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { deriveRowKey, appEventHlc } from '../../src/memory/topicRowWriter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/e2e/topic-row-writer-lifecycle.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SLACK_TOPIC = -4242;
const APP_TOPIC = -(2 ** 33) - 9;

const CHILD = `
import { TopicMemory } from ${JSON.stringify(path.join(ROOT, 'src/memory/TopicMemory.ts'))};
import { TopicRowWriter, writeSlackLogRow, writeAppConversationRow } from ${JSON.stringify(path.join(ROOT, 'src/memory/topicRowWriter.ts'))};
const [stateDir] = process.argv.slice(-1);
const tm = new TopicMemory(stateDir);
await tm.open();
const refusals = [];
const writer = new TopicRowWriter({ topicMemory: () => tm, channelEnabled: () => true, reportRefusal: (e) => refusals.push(e) });
const slack = (ts, text) => writeSlackLogRow(writer,
  { messageId: ts, channelId: 'D0OPS', text, fromUser: true, timestamp: new Date(Number(ts.split('.')[0]) * 1000).toISOString(), sessionName: null, platformUserId: 'U0OP' },
  { topicIdFor: () => ${SLACK_TOPIC}, resolveUserId: (id) => id === 'U0OP' ? 'u-operator' : null });
const app = (eventId, at, role, text) => writeAppConversationRow(writer,
  { eventId, kind: 'message', conversationKey: 'c-1', at, role, text },
  { aliasFor: () => ${APP_TOPIC}, ownerUserId: () => 'u-operator' });
const results = [
  slack('1762800000.000100', 'slack one'),
  slack('1762800003.000200', 'slack two'),
  app('ev-a', '2026-11-10T02:00:00.000Z', 'operator', 'app one'),
  app('ev-b', '2026-11-10T02:00:00.000Z', 'agent', 'app two, same millisecond'),
];
tm.close();
console.log(JSON.stringify({ results, refusals }));
process.exit(0);
`;

describe('TopicRowWriter across real processes and a restart', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

  const machine = () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'row-writer-e2e-'));
    dirs.push(stateDir);
    const script = path.join(stateDir, 'child.ts');
    fs.writeFileSync(script, CHILD);
    const r = spawnSync(path.join(ROOT, 'node_modules/.bin/vite-node'), [script, stateDir], { cwd: ROOT, encoding: 'utf-8', timeout: 90_000 });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.trim().split('\n').pop() as string) as { results: Array<{ written: boolean }>; refusals: unknown[] };
    expect(out.refusals).toEqual([]);
    expect(out.results.every((x) => x.written)).toBe(true);
    return stateDir;
  };

  it('rows survive a restart and every machine derives the same keys', async () => {
    const a = machine();
    const b = machine();
    const read = async (dir: string) => {
      const tm = new TopicMemory(dir);
      await tm.open();
      try {
        return [...tm.getRecentMessages(SLACK_TOPIC, 10), ...tm.getRecentMessages(APP_TOPIC, 10)]
          .map((r) => ({ messageId: r.messageId, channelMessageId: r.channelMessageId, text: r.text, userId: r.userId ?? null, fromUser: r.fromUser }));
      } finally { tm.close(); }
    };
    const rowsA = await read(a);
    const rowsB = await read(b);
    expect(rowsA).toHaveLength(4);
    expect(rowsB).toEqual(rowsA);
    // The keys are the §14 rule, recomputed here independently.
    const slackKey = deriveRowKey({ channel: 'slack', ts: '1762800003.000200' }) as { messageId: number };
    expect(rowsA.find((r) => r.text === 'slack two')?.messageId).toBe(slackKey.messageId);
    const appKey = deriveRowKey({ channel: 'app', eventId: 'ev-b', hlc: appEventHlc({ eventId: 'ev-b', at: '2026-11-10T02:00:00.000Z' })! }) as { messageId: number };
    expect(rowsA.find((r) => r.text === 'app two, same millisecond')?.messageId).toBe(appKey.messageId);
    // Two app messages in the same millisecond are still two distinct keys.
    expect(new Set(rowsA.filter((r) => r.channelMessageId?.startsWith('ev-')).map((r) => r.messageId)).size).toBe(2);
    // §6.1: the operator rows carry the operator's person; the agent row none.
    expect(rowsA.map((r) => r.userId)).toEqual(['u-operator', 'u-operator', 'u-operator', null]);
  }, 180_000);

  it('server.ts wires the writer on the real boot path for every channel that has one', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf-8');
    const built = src.indexOf('const topicRowWriter = new TopicRowWriter({');
    expect(built).toBeGreaterThan(0);
    // App rows are gated on the context-budget switch, read live (never a boot snapshot).
    const ctor = src.slice(built, built + 400);
    expect(ctor).toContain("liveConfig.get<boolean>('contextBudget.enabled', false)");
    expect(ctor).toContain('topicMemory: () => topicMemory');

    // Telegram: the dual-write goes through the key rule.
    const tg = src.indexOf('telegram.onMessageLogged = (entry) => {');
    expect(tg).toBeGreaterThan(built);
    expect(src.slice(tg, tg + 1500)).toContain("topicRowWriter.writeRow({ channel: 'telegram', nativeId: entry.messageId }");

    // Slack: through writeSlackLogRow, and the old cast-to-0 key is gone.
    const sl = src.indexOf('_slackAdapter.onMessageLogged = (entry) => {');
    expect(sl).toBeGreaterThan(built);
    const slBlock = src.slice(sl, sl + 1500);
    expect(slBlock).toContain('writeSlackLogRow(topicRowWriter, entry, {');
    expect(slBlock).not.toContain("messageId: typeof entry.messageId === 'number' ? entry.messageId : 0,\n                topicId: synId");

    // App conversations: an append observer on the real store.
    const app = src.indexOf('appSvc.store.addAppendListener((ev) => {');
    expect(app).toBeGreaterThan(built);
    expect(src.slice(app, app + 600)).toContain('writeAppConversationRow(topicRowWriter, ev, {');

    // The fold precondition reads the writer (§14: fold-skipped no-row-source).
    const fold = src.indexOf("await import('../monitoring/foldCoordinatorBoot.js')");
    expect(src.slice(fold, fold + 3000)).toContain('hasRowSource: (topicId) => topicRowWriter.hasRowSource(topicId)');
  });
});
