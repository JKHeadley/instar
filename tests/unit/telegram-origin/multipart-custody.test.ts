import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { captureOriginAttachments, renderOriginMultipart } from '../../../src/messaging/telegram-origin/OriginMultipart.js';
import { OriginStore } from '../../../src/messaging/telegram-origin/OriginStore.js';
import { admission, compileOriginWorker, temporaryState } from '../../helpers/telegramOriginStore.js';

let worker: URL;
const stores: OriginStore[] = [];
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); });
async function upload() {
  const form = new FormData(); form.set('chat_id', '-100123');
  form.set('document', new Blob([new Uint8Array([0, 1, 255, 10])], { type: 'application/octet-stream' }), 'sample.bin');
  return captureOriginAttachments(form);
}
describe('immutable multipart custody', () => {
  it('renders byte-identical multipart requests from signed refs and rejects altered bytes', async () => {
    const captured = await upload();
    const boundary = 'instar-origin-11111111-1111-4111-8111-111111111111';
    const params = { chat_id: '-100123', document: 'attach://document', caption: 'caption' };
    const payloads = new Map(captured.payloads.map(payload => [payload.payloadId, payload.data]));
    const first = renderOriginMultipart(params, boundary, captured.refs, payloads);
    expect(renderOriginMultipart(params, boundary, captured.refs, payloads)).toEqual(first);
    const decoded = await new Response(first, { headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } }).formData();
    expect(decoded.get('caption')).toBe('caption');
    expect(new Uint8Array(await (decoded.get('document') as Blob).arrayBuffer())).toEqual(captured.payloads[0].data);
    captured.payloads[0].data[0] = 9;
    expect(() => renderOriginMultipart(params, boundary, captured.refs, payloads)).toThrow('attachment-custody-mismatch');
  });
  it('refuses duplicate fields and header injection before preparation', async () => {
    const duplicate = new FormData(); duplicate.append('document', new Blob(['first']), 'first.txt'); duplicate.append('document', new Blob(['second']), 'second.txt');
    await expect(captureOriginAttachments(duplicate)).rejects.toThrow('duplicate-multipart-field');
    const injected = new FormData(); injected.set('document', new Blob(['bytes']), 'bad"name.txt');
    await expect(captureOriginAttachments(injected)).rejects.toThrow('invalid-attachment-metadata');
  });
  it('atomically admits bytes, survives worker restart, and drops only payload bytes at expiry', async () => {
    const options = { stateDir: temporaryState(), agentId: 'fixture' };
    let store = await OriginStore.open(options, worker); stores.push(store);
    const captured = await upload(), input = admission('attachment-lifecycle');
    input.payloads = captured.payloads; input.payloadBytes += captured.payloads[0].size;
    await store.admit(input);
    await store.admit(input); // same immutable custody remains idempotent
    await store.close();
    store = await OriginStore.open(options, worker); stores.push(store);
    expect(await store.getPayload(captured.refs[0].payloadId)).toEqual(captured.payloads[0].data);
    const auditBefore = await store.getOrigin(input.record.originId);
    expect(JSON.stringify(auditBefore)).not.toContain('payloads');
    await store.cleanupPayloads(input.deadlineAt);
    await expect(store.getPayload(captured.refs[0].payloadId)).rejects.toThrow('attachment-custody-unavailable');
    expect((await store.getOrigin(input.record.originId))?.record).toEqual(auditBefore?.record);
  });
  it('does not admit an operation when its attachment digest or byte budget is invalid', async () => {
    const store = await OriginStore.open({ stateDir: temporaryState(), agentId: 'fixture' }, worker); stores.push(store);
    const captured = await upload(), input = admission('attachment-invalid');
    input.payloads = captured.payloads; input.payloads[0].digest = createHash('sha256').update('different').digest('hex');
    await expect(store.admit(input)).rejects.toThrow('invalid-attachment-custody');
    expect(await store.getOrigin(input.record.originId)).toBeNull();
    input.payloads = (await upload()).payloads; input.payloadBytes = 1;
    await expect(store.admit(input)).rejects.toThrow('payload-budget');
    expect(await store.getOperation(input.operationId)).toBeNull();
  });
});
