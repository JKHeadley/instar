import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { reportTelegramInjectionFailure, TELEGRAM_INJECTION_REFUSAL_NOTICE } from '../../src/messaging/telegramInjectionFailure.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'N80 isolated unit fixture cleanup' }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n80-failure-unit-')); dirs.push(dir);
  const telegram = new TelegramAdapter({ token: '123:synthetic', chatId: '-1001' }, dir);
  const tracker = new CommitmentTracker({ stateDir: dir });
  const sendNotice = vi.fn(async (_topicId: number, _text: string) => ({ messageId: 900 }));
  const reportDegradation = vi.fn();
  return { dir, telegram, tracker, sendNotice, reportDegradation,
    deps: { telegram, getTracker: () => tracker, sendNotice, reportDegradation } };
}
const source = { namespace: '123:-1001', topicId: 41, messageId: '157' };

describe('Truthful Telegram injection failure', () => {
  it('retains attempt-qualified attention and one existing obligation across concurrent reports', async () => {
    const f = fixture();
    const outcomes = await Promise.all([reportTelegramInjectionFailure(f.deps, source), reportTelegramInjectionFailure(f.deps, source)]);
    expect(outcomes).toEqual([expect.objectContaining({ attentionPersisted: true, followThroughRecorded: true, notice: 'delivered' }), expect.objectContaining({ followThroughRecorded: true })]);
    expect(f.tracker.getActive()).toHaveLength(1);
    const c = f.tracker.getActive()[0];
    expect(c).toMatchObject({ owner: 'agent', source: 'sentinel', topicId: 41, sourceConversationKey: 'telegram:41', sourceMessageId: '157', beaconEnabled: true, status: 'pending' });
    expect(c.userRequest).toBe(TELEGRAM_INJECTION_REFUSAL_NOTICE);
    expect(f.telegram.getAttentionItems()).toHaveLength(1);
    const stored = f.telegram.getAttentionItems()[0];
    expect(stored.summary).toContain('This attempt stopped before sending');
    expect(stored.summary).toContain('cannot confirm whether an earlier attempt delivered');
    expect(stored.summary).not.toContain('Try sending');
    expect(stored.summary).not.toContain('message was not delivered');
    expect(f.sendNotice.mock.calls[0][1]).toContain('cannot confirm whether an earlier attempt delivered');
    const reload = new CommitmentTracker({ stateDir: f.dir });
    expect(reload.getActive()[0].externalKey).toBe(c.externalKey);
    const adapterReload = new TelegramAdapter({ token: '123:synthetic', chatId: '-1001' }, f.dir);
    expect(adapterReload.getAttentionItems()[0].id).toBe(stored.id);
  });

  it('does not conflate distinct source messages or bot/forum namespaces', async () => {
    const f = fixture();
    for (const s of [source, { ...source, messageId: '159' }, { ...source, namespace: '456:-1001' }]) await reportTelegramInjectionFailure(f.deps, s);
    expect(f.tracker.getActive()).toHaveLength(3);
  });

  it('reports unconfirmed disk persistence instead of trusting an in-memory attention item', async () => {
    const f = fixture();
    vi.spyOn(f.telegram, 'isAttentionItemPersisted').mockReturnValue(false);
    const outcome = await reportTelegramInjectionFailure(f.deps, source);
    expect(outcome.attentionPersisted).toBe(false);
    expect(f.reportDegradation).toHaveBeenCalledWith('attention-persistence-unconfirmed');
    expect(f.sendNotice.mock.calls[0][1]).toContain('could not confirm that the attention record was saved');
  });

  it('does not count a failed attention save as durable', async () => {
    const f = fixture();
    const write = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('isolated disk failure'); });
    const item = await f.telegram.createAttentionItem({ id: 'persist-failure', title: 'Failure', summary: 'Attempt unknown', category: 'delivery', priority: 'HIGH' }, { recordOnly: true });
    expect(f.telegram.isAttentionItemPersisted(item)).toBe(false);
    write.mockRestore();
  });

  it('never claims a quiet record is platform delivery', async () => {
    const f = fixture();
    const outcome = await reportTelegramInjectionFailure({ ...f.deps, sendNotice: async () => ({ recorded: true, delivered: false, quietId: 'quiet-fixture' }) }, source);
    expect(outcome.notice).toBe('recorded');
  });

  it('reports combined storage, tracking and outbound failure without a saved or informed claim', async () => {
    const f = fixture();
    vi.spyOn(f.telegram, 'createAttentionItem').mockRejectedValue(new Error('fixture unavailable'));
    const send = vi.fn(async (_topicId: number, _text: string) => { throw new Error('fixture send unavailable'); });
    const outcome = await reportTelegramInjectionFailure({ ...f.deps, getTracker: () => null, sendNotice: send }, source);
    expect(outcome).toEqual({ attentionPersisted: false, followThroughRecorded: false, notice: 'failed' });
    expect(f.reportDegradation).toHaveBeenCalledWith('failure-visibility-and-follow-through-unsecured');
    expect(send.mock.calls[0][1]).toContain('could not secure a tracked follow-up');
  });

  it('does not expose the bot credential in the source namespace', () => {
    const f = fixture();
    expect(f.telegram.getInboundSourceNamespace()).toBe('123:-1001');
    expect(f.telegram.getInboundSourceNamespace()).not.toContain('synthetic');
  });

  it('provides the same awareness on fresh generation and existing-agent migration', () => {
    const f = fixture();
    const fresh = generateClaudeMd('fixture', 'Fixture', 4042, true);
    const title = 'Follow up when a message attempt cannot reach its conversation';
    expect(fresh).toContain(title);
    expect(fresh).toContain('Do not automatically resend');
    const migrator = new PostUpdateMigrator({ projectDir: f.dir, stateDir: path.join(f.dir, '.instar'), port: 4042, hasTelegram: true, projectName: 'fixture' });
    const patch = (migrator as unknown as { patchClaudeMdContent: (s: string, result: unknown) => { content: string } }).patchClaudeMdContent.bind(migrator);
    const once = patch('# Existing Agent\n', { upgraded: [], skipped: [], errors: [] }).content;
    expect(once).toContain(title);
    const twice = patch(once, { upgraded: [], skipped: [], errors: [] }).content;
    expect(twice.match(new RegExp(title, 'g'))?.length).toBe(once.match(new RegExp(title, 'g'))?.length);
  });
});
