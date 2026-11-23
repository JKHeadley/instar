import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { deviceKeyHashOf } from '../../src/core/AppRecordSignatures.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { dateCursor, parseDateCursor } from '../../src/server/localSearchPage.js';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import { ImportedHistoryStore } from '../../src/import/ImportedHistoryStore.js';
import { createConversationSearchRouter, sanitizePeerHit, searchLocal, type ConversationSearchRouteDeps } from '../../src/server/mobileConversationSearchRoutes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { force: true, recursive: true, operation: 'tests/unit/imported-conversation-search.test.ts' });
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-import-search-'));
  dirs.push(dir);
  const store = new ImportedHistoryStore(dir);
  store.addConversation({
    from: 'claude', originalId: 'private-id', title: 'Private chat', createdAt: null,
    messages: ['2026-05-01', '2026-05-04'].map((at, i) => ({
      key: 'private-' + i, at: new Date(at).toISOString(), role: 'operator', senderName: 'Me', text: 'a private rocket',
    })),
    overflow: [], stats: { redactions: 0, splitMessages: 0, droppedBranches: 0 },
  });
  store.flush();
  const read = vi.fn(() => ImportedHistoryStore.openIfPresent(dir));
  const peers = vi.fn(() => []);
  const publicKey = makeDevice().publicKey;
  const records = [
    { id: 'phone', role: 'owner', userId: 'operator', status: 'active', client: 'phone', publicKey, browserPublicKey: publicKey },
    { id: 'browser', role: 'owner', userId: 'operator', status: 'active', client: 'browser', publicKey, browserPublicKey: publicKey },
  ];
  const grants: Record<string, { ownerConversations: boolean }> = {};
  const config = { mobilePairing: { enabled: true, native: { enabled: true } } };
  const deps = {
    config,
    pairing: {
      deps: { config }, nativeOn: true, enabled: () => true, browserOn: () => true, mayUse: () => true, mayReadStored: () => true,
      devices: { get: (id: string) => records.find(r => r.id === id), list: () => records },
      keyLedger: { isRevoked: () => false }, grants: { all: () => grants },
      personOfDevice: (r: typeof records[number]) => ({ ok: true, role: r.role, userId: r.userId }),
      people: () => ({ getUser: (id: string) => ({ userId: id, permissions: ['admin:*'], orgRole: 'owner' }) }),
      ownerIdentity: () => ({ telegramOwnerId: null, slackOwnerUserId: null }),
    },
    service: { store: {
      listConversations: () => ({ conversations: [{ conversationKey: '606a4445-38fa-4250-8254-9598de470014', title: 'Native' }], nextCursor: null }),
      browseMessages: () => ({ messages: [{ eventId: 'live', at: '2026-05-02T00:00:00.000Z', role: 'operator', text: 'rocket' }], nextBefore: null }),
    } },
    machineId: () => 'home-machine', importedHistory: read, pool: { resolvePeerUrls: peers, config: {} },
  } as unknown as ConversationSearchRouteDeps;
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, {
      instarPrincipal: { kind: req.get('x-test-caller') ?? 'device', deviceId: req.get('x-test-client') === 'browser' ? 'browser' : 'phone' },
      instarDeviceAdmittedAt: Date.now(),
      instarDeviceAdmissionIdentity: { keyHash: deviceKeyHashOf(publicKey), role: req.get('x-test-role') ?? 'owner', userId: 'operator' },
      instarDevicePerson: { ok: true, userId: 'operator', role: req.get('x-test-role') ?? 'owner' },
      instarDeviceClient: req.get('x-test-client'),
    });
    next();
  });
  app.use(createConversationSearchRouter(deps));
  return { app, read, peers, records, grants, deps, store };
}

it('omits local session sources from legacy search before results and source labels are built', async () => {
  const { app, store } = fixture();
  await store.withWriter(async () => { for (const from of ['codex', 'claude-code'] as const) {
    const claim = store.assertOrClaimLocalSource({ ownerUserId: 'operator', source: from, originalId: 'local-private',
      projectPath: '/synthetic', representation: from === 'codex' ? 'canonical' : 'claude-records', parserContractVersion: 1 });
    store.addConversation({ from, originalId: claim.destinationId, title: 'Private local title', createdAt: null,
      messages: [{ key: 'local', at: '2028-01-01T00:00:00.000Z', role: 'operator', senderName: 'Me', text: 'rocket local secret' }],
      overflow: [], stats: { redactions: 0, splitMessages: 0, droppedBranches: 0 } });
  } store.flush(); });
  const result = await request(app).get('/mobile/conversations/search?q=rocket&order=date&limit=1');
  expect(result.status).toBe(200);
  expect(JSON.stringify(result.body)).not.toContain('local-private');
  expect(result.body.results[0].ref).toBe('imported:claude:private-id');
  expect(store.search('local secret')).toEqual({ hits: [], complete: true });
});

it('finds local imported messages for the native owner, with source, machine and stable dated pages', async () => {
  const { app } = fixture();
  const url = '/mobile/conversations/search?q=rocket&order=date&limit=1';
  const first = await request(app).get(url);
  expect(first.status).toBe(200);
  expect(first.body.results).toMatchObject([{ platform: 'imported', ref: 'imported:claude:private-id', messageId: 'private-1', machine: 'home-machine', label: 'Imported from Claude' }]);
  expect(first.body.nextCursor).toEqual(expect.any(String));
  const next = await request(app).get(url + '&cursor=' + encodeURIComponent(first.body.nextCursor));
  expect(next.body.results.map((hit: { messageId: string }) => hit.messageId)).toEqual(['live']);
  const third = await request(app).get(url + '&cursor=' + encodeURIComponent(next.body.nextCursor));
  expect(third.body.results.map((hit: { messageId: string }) => hit.messageId)).toEqual(['private-0']);
  expect(third.body.nextCursor).toBeNull();
  expect((await request(app).get('/mobile/conversations/search?q=rocket')).body.results[0].messageId).toBe('live');
  expect(await request(app).get(url + '&scope=pool')).toHaveProperty('status', 400);
});

it('never opens the import store for a token, browser or team device and never fans out an imported ref', async () => {
  const { app, read, peers } = fixture();
  const base = '/mobile/conversations/search?q=rocket';
  for (const headers of [{ 'x-test-caller': 'token' }, { 'x-test-client': 'browser' }, { 'x-test-role': 'team' }, { 'x-test-role': 'msp' }]) {
    const res = await request(app).get(base).set(headers as Record<string, string>);
    expect(res.body.results.some((h: { platform: string }) => h.platform === 'imported')).toBe(false);
    const scoped = await request(app).get(base + '&scope=pool&ref=imported:claude:private-id').set(headers as Record<string, string>);
    expect(scoped.status).toBe(404);
  }
  expect(read).not.toHaveBeenCalled();
  const scoped = await request(app).get(base + '&scope=pool&ref=imported:claude:private-id');
  expect(scoped.body.results).toHaveLength(2);
  expect(peers).not.toHaveBeenCalled();
  expect(sanitizePeerHit(scoped.body.results[0], 'home-machine')).toBeNull();
});

it('supports multiple native devices of the same owner and refuses ambiguous profiles and MSP sharing', async () => {
  const { app, read, records, grants } = fixture();
  const match = '/mobile/conversations/search?q=private&ref=imported:claude:private-id';
  records.push({ ...records[0]!, id: 'other-phone' });
  expect((await request(app).get(match)).status).toBe(200);
  read.mockClear();
  records[2]!.userId = 'different-owner';
  expect((await request(app).get(match)).status).toBe(404);
  records[2]!.userId = 'operator';
  grants.advisor = { ownerConversations: true };
  expect((await request(app).get(match)).status).toBe(404);
  expect(read).not.toHaveBeenCalled();
});

it('paginates across more than 500 Telegram messages tied on time and then reaches the older hit', async () => {
  const { deps } = fixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tied-search-'));
  dirs.push(dir);
  const memory = new TopicMemory(dir);
  await memory.open();
  try {
    memory.insertMessages(Array.from({ length: 512 }, (_, i) => ({
      messageId: 1000 - i, topicId: 42, fromUser: false, text: 'rocket', sessionName: null,
      timestamp: i === 511 ? '2025-01-01T00:00:00.000Z' : '2026-01-01T00:00:00.000Z',
    })));
    const d = { ...deps, topicMemory: () => memory, telegramTopics: () => [{ topicId: 42, topicName: 'Ties' }] };
    const ids: string[] = [];
    let cursor = null;
    for (let i = 0; i < 12; i++) {
      const page = searchLocal(d, { terms: ['rocket'], only: 'telegram:42', limit: 50, newest: true, cursor },
        { may: () => true, mayReadApp: () => true }).results;
      ids.push(...page.map(h => h.messageId));
      if (page.length < 50) break;
      cursor = parseDateCursor(dateCursor(page[page.length - 1]!));
    }
    expect(ids).toHaveLength(512);
    expect(new Set(ids).size).toBe(512);
    expect(ids.at(-1)).toBe('out:489');
  } finally { memory.close(); }
});

it('withholds the complete result if owner sharing changes during peer fan-out', async () => {
  const { app, grants, peers } = fixture();
  peers.mockImplementation(() => {
    grants.newAdvisor = { ownerConversations: true };
    return [];
  });
  const res = await request(app).get('/mobile/conversations/search?q=private&scope=pool');
  expect(res.status).toBe(403);
  expect(res.body).toEqual({ error: 'owner-admission-changed' });
});
