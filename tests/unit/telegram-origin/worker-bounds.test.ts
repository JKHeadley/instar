import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { OriginStore, OriginStoreBackpressureError } from '../../../src/messaging/telegram-origin/OriginStore.js';
import { admission, compileOriginWorker, hash, temporaryState } from '../../helpers/telegramOriginStore.js';

let worker: URL;
const stores: OriginStore[] = [];
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });

describe('origin worker byte backpressure and bounded archive reads', () => {
  it('rejects excess concurrent clone bytes before enqueue without killing healthy storage', async () => {
    const store = await OriginStore.open({ stateDir: temporaryState(), agentId: 'echo', maxPendingBytes: 64 * 1024 }, worker); stores.push(store);
    const records = Array.from({ length: 32 }, (_, i) => {
      const record = admission(`bounded-${i}`).record;
      record.envelopeJson = JSON.stringify({ padding: 'x'.repeat(4096) });
      record.envelopeDigest = hash(record.envelopeJson); return record;
    });
    const results = await Promise.allSettled(records.map(record => store.putEvidence(record)));
    expect(results.some(result => result.status === 'fulfilled')).toBe(true);
    const refused = results.filter(result => result.status === 'rejected');
    expect(refused.length).toBeGreaterThan(0);
    for (const result of refused) if (result.status === 'rejected') {
      expect(result.reason).toBeInstanceOf(OriginStoreBackpressureError);
      expect(result.reason.mutationMayHaveCommitted).toBe(false);
    }
    expect(store.isUnavailable()).toBe(false);
    await store.healthTransaction();
    for (let i = 0; i < records.length; i++) expect(Boolean(await store.getOrigin(records[i].originId))).toBe(results[i].status === 'fulfilled');
    // Capacity is released after responses, including a failed backend call.
    await expect(store.putEvidence({ ...records[0], envelopeDigest: 'bad' })).rejects.toThrow();
    await expect(store.putEvidence(admission('after-drain').record)).resolves.toMatchObject({ inserted: true });
  });

  it('counts an upload view backing buffer before structured clone copies it', async () => {
    const store = await OriginStore.open({ stateDir: temporaryState(), agentId: 'echo', maxPendingBytes: 64 * 1024 }, worker); stores.push(store);
    const operation = admission('backing-buffer');
    const data = new Uint8Array(new ArrayBuffer(128 * 1024), 0, 1);
    operation.payloads = [{ payloadId: 'tiny-view', data, size: 1, digest: createHash('sha256').update(data).digest('hex') }];
    await expect(store.admit(operation)).rejects.toBeInstanceOf(OriginStoreBackpressureError);
    expect(await store.getOrigin(operation.record.originId)).toBeNull();
    // Opaque structured-clone containers cannot hide uncounted payloads.
    await expect(store.putEvidence(new Map([['payload', new Uint8Array(128 * 1024)]]) as never)).rejects.toThrow('unsupported-worker-input');
    await store.healthTransaction();
  });

  it('verifies a shared archive once per page and paginates by bytes without losing records', async () => {
    const stateDir = temporaryState();
    const store = await OriginStore.open({ stateDir, agentId: 'echo' }, worker); stores.push(store);
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) {
      const operation = admission(`archive-${i}`);
      operation.record.envelopeJson = JSON.stringify({ padding: 'x'.repeat(64 * 1024) });
      operation.record.envelopeDigest = hash(operation.record.envelopeJson);
      await store.admit(operation); ids.push(operation.record.originId);
      const child = operation.children[0];
      const claim = await store.claim({ childId: child.childId, materializationId: child.materializations[0].materializationId, ownerBootId: 'archive-owner', leaseMs: 60_000 });
      if (claim.status !== 'claimed') throw new Error('fixture claim unavailable');
      await store.markDispatched(claim.child);
      await store.recordOutcome({ ...claim.child, outcome: 'accepted', receiptJson: JSON.stringify({ messageId: i + 1 }) });
    }
    const archived = await store.archive({ before: Date.now() + 1, limit: 100 });
    expect(archived.archived).toBe(40);
    const filename = path.join(stateDir, 'state/telegram-origin-archives/echo', `${archived.archiveId}.sqlite`);
    const archiveBytes = (await stat(filename)).size;
    const before = (await store.diagnostics()).archiveReads;
    let page = await store.listOrigins({ limit: 200 });
    expect(page.records.length).toBeGreaterThan(1); expect(page.records.length).toBeLessThan(40);
    expect(page.cursor).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(2 * 1024 * 1024);
    const after = (await store.diagnostics()).archiveReads;
    expect(after.filesVerified - before.filesVerified).toBe(1);
    expect(after.bytesHashed - before.bytesHashed).toBe(archiveBytes);
    const found = page.records.map(record => record.record.originId);
    while (page.cursor) {
      page = await store.listOrigins({ limit: 200, cursor: page.cursor });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(2 * 1024 * 1024);
      found.push(...page.records.map(record => record.record.originId));
    }
    expect(found).toEqual(ids);
    // The verification cache ends with the request, not with the process.
    await writeFile(filename, 'corrupt archive');
    await expect(store.getOrigin(ids[0])).rejects.toThrow('archive-integrity');
    expect(store.isUnavailable()).toBe(false);
  });
});
