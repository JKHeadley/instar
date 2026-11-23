import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HistoryAcquisitionWorker, type WorkerOptions } from '../../src/import/HistoryAcquisitionWorker.js';
import { ImportedHistoryStore } from '../../src/import/ImportedHistoryStore.js';
import { makeZip } from '../helpers/exportZip.js';

const owner = { owner: 'owner', machine: 'test-mac', conversation: 'private-chat' };
const account = { provider: 'chatgpt' as const, expectedEmail: 'tester@example.test', workspace: 'personal' as const, profileId: 'test-personal' };
const zip = makeZip([
  { name: 'chat.html', data: '<html></html>' },
  {
    name: 'conversations.json', data: JSON.stringify([{
      conversation_id: 'c1', title: 'Test meal', current_node: 'm1',
      mapping: { m1: { id: 'm1', parent: null, children: [], message: { id: 'm1', author: { role: 'user' }, content: { parts: ['Lentil soup'] }, create_time: 1740823200 } } }
    }])
  },
]);

describe('personal history acquisition from request through receipt and confirmation', () => {
  let stateDir: string, now: number, clicks: number, hasGrant: boolean;
  let worker: HistoryAcquisitionWorker, options: WorkerOptions;
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acquisition-e2e-'));
    now = Date.now(); clicks = 0; hasGrant = true;
    options = {
      stateDir, now: () => now, authorized: chat => chat.owner === owner.owner && chat.machine === owner.machine && chat.conversation === owner.conversation,
      connection: {
        available: () => ['chatgpt'],
        accounts: () => [account],
        delivery: () => hasGrant ? {
          now: () => now, resourcePaths: ['/test-export'],
          readNotice: async binding => ({
            kind: 'notice', notice: {
              provider: 'chatgpt', recipient: account.expectedEmail, workspace: 'personal', receivedAt: binding.requestedAt,
              authenticatedSenderDomain: 'openai.com', link: 'https://chatgpt.com/test-export?token=fixture-only',
            }
          }),
          verifyIdentity: async () => ({ provider: 'chatgpt', account: account.expectedEmail, workspace: 'personal' }),
          fetch: async () => new Response(new Uint8Array(zip), { headers: { 'content-type': 'application/zip' } }),
        } : undefined,
      },
      request: async (_target, { reserveSubmission }) => {
        if (!await reserveSubmission()) return { status: 'already-reserved' };
        clicks++; return { status: 'outcome-unknown' };
      },
      observe: async () => ({ status: 'outcome-unknown' }),
    };
    worker = new HistoryAcquisitionWorker(options);
  });
  afterEach(async () => { await worker.close(); SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'cleanup history acquisition test' }); });
  it('resumes after uncertain submission, previews without writing and applies only a fresh owner confirmation', async () => {
    const { id, phase } = await worker.start(owner, 'chatgpt', account.expectedEmail, 'button-tap');
    expect(phase).toBe('submitting'); expect(clicks).toBe(1);
    expect(() => new HistoryAcquisitionWorker(options)).toThrow();
    await worker.close(); worker = new HistoryAcquisitionWorker(options);
    expect((await worker.start(owner, 'chatgpt', account.expectedEmail, 'button-tap')).id).toBe(id);
    expect(worker.status(owner, id).phase).toBe('review'); expect(clicks).toBe(1);
    const old = await worker.preview(owner, id);
    expect(old.preview.chats).toBe(1);
    expect(new ImportedHistoryStore(stateDir).listConversations()).toHaveLength(0);
    await worker.close(); worker = new HistoryAcquisitionWorker(options);
    await expect(worker.apply(owner, id, old.confirmation)).rejects.toThrow('fresh-preview-required');
    const fresh = await worker.preview(owner, id);
    await expect(worker.apply({ ...owner, conversation: 'someone-else' }, id, fresh.confirmation)).rejects.toThrow();
    expect((await worker.apply(owner, id, fresh.confirmation)).chatsAdded).toBe(1);
    expect(worker.status(owner, id).phase).toBe('complete');
    expect(new ImportedHistoryStore(stateDir).listConversations()).toHaveLength(1);
    expect((await worker.start(owner, 'chatgpt', account.expectedEmail, 'button-tap')).phase).toBe('complete');
    expect(clicks).toBe(1);
    for (const p of fs.readdirSync(path.join(stateDir, 'history-acquisition'))) {
      const f = path.join(stateDir, 'history-acquisition', p);
      if (fs.statSync(f).isFile()) expect(fs.readFileSync(f).includes(Buffer.from('fixture-only'))).toBe(false);
    }
  });
  it('requires delivery access before the provider click and preserves a cancellation across restart', async () => {
    hasGrant = false;
    const { id, phase, attention } = await worker.start(owner, 'chatgpt', account.expectedEmail, 'tap');
    expect([phase, attention, clicks]).toEqual(['ready', 'mail-access', 0]);
    expect(worker.cancel(owner, id)).toBe(true);
    hasGrant = true; await worker.close(); worker = new HistoryAcquisitionWorker(options);
    expect((await worker.start(owner, 'chatgpt', account.expectedEmail, 'tap')).phase).toBe('cancelled');
    expect(clicks).toBe(0);
  });

  it('rechecks delivery permission at the last possible point before submitting', async () => {
    await worker.close();
    worker = new HistoryAcquisitionWorker({
      ...options,
      request: async (_job, { reserveSubmission }) => {
        hasGrant = false;
        if (await reserveSubmission()) clicks++;
        return { status: 'already-reserved' };
      },
    });
    const { id } = await worker.start(owner, 'chatgpt', account.expectedEmail, 'tap');
    expect(clicks).toBe(0);
    expect(worker.status(owner, id)).toEqual({ phase: 'ready', attention: 'mail-access' });
    await worker.close();
    worker = new HistoryAcquisitionWorker(options);
    expect(worker.status(owner, id)).toEqual({ phase: 'ready', attention: 'mail-access' });
  });
});
