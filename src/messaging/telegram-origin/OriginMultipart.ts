import { createHash, randomUUID } from 'node:crypto';
import { canonicalOrigin } from './CanonicalOrigin.js';
import { TelegramOriginHoldError, type BotParameters, type OriginAttachmentRef, type SealedBotRequest } from './types.js';
import type { StoredPayloadInput } from './StoreTypes.js';

export const MAX_ORIGIN_UPLOAD_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_ORIGIN_UPLOAD_BATCH_BYTES = 64 * 1024 * 1024;
export interface PreparedOriginAttachments { refs: OriginAttachmentRef[]; payloads: StoredPayloadInput[]; }
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

/** Capture immutable Blob snapshots before preparation; no paths or caller handles survive. */
export async function captureOriginAttachments(body: FormData): Promise<PreparedOriginAttachments> {
  const refs: OriginAttachmentRef[] = [], payloads: StoredPayloadInput[] = [];
  const names = new Set<string>(); let total = 0;
  const entries = [...body.entries()];
  for (const [field, value] of entries) {
    if (names.has(field)) throw new TelegramOriginHoldError('duplicate-multipart-field');
    names.add(field);
    if (typeof value === 'string') continue;
    total += value.size;
    if (value.size > MAX_ORIGIN_UPLOAD_FILE_BYTES || total > MAX_ORIGIN_UPLOAD_BATCH_BYTES || refs.length >= 10) throw new TelegramOriginHoldError('attachment-capacity');
    const filename = value.name || 'attachment'; const mediaType = value.type || 'application/octet-stream';
    if (!/^[A-Za-z0-9_]{1,64}$/.test(field) || !filename || filename.length > 255 || /[\r\n"\\\x00]/.test(filename)
      || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mediaType)) throw new TelegramOriginHoldError('invalid-attachment-metadata');
    const data = new Uint8Array(await value.arrayBuffer());
    const payloadId = randomUUID(), hash = digest(data);
    refs.push({ payloadId, field, filename, mediaType, digest: hash, size: data.byteLength });
    payloads.push({ payloadId, digest: hash, size: data.byteLength, data });
  }
  return { refs, payloads };
}

export function renderOriginMultipart(params: BotParameters, boundary: string,
  refs: OriginAttachmentRef[], payloads: ReadonlyMap<string, Uint8Array>): Buffer {
  if (!/^instar-origin-[a-f0-9-]{36}$/.test(boundary)) throw new TelegramOriginHoldError('invalid-multipart-boundary');
  const chunks: Buffer[] = [];
  const line = (value: string) => chunks.push(Buffer.from(value, 'utf8'));
  for (const key of Object.keys(params).sort()) {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(key)) throw new TelegramOriginHoldError('invalid-multipart-field');
    if (refs.some(ref => ref.field === key && params[key] === `attach://${key}`)) continue;
    const value = typeof params[key] === 'string' ? params[key] as string : canonicalOrigin(params[key]);
    if (value.includes(boundary)) throw new TelegramOriginHoldError('multipart-boundary-collision');
    line(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`);
  }
  let total = 0;
  for (const ref of refs) {
    const data = payloads.get(ref.payloadId);
    if (!data || data.byteLength !== ref.size || digest(data) !== ref.digest) throw new TelegramOriginHoldError('attachment-custody-mismatch');
    total += data.byteLength;
    if (data.byteLength > MAX_ORIGIN_UPLOAD_FILE_BYTES || total > MAX_ORIGIN_UPLOAD_BATCH_BYTES || refs.length > 10) throw new TelegramOriginHoldError('attachment-capacity');
    if (!/^[A-Za-z0-9_]{1,64}$/.test(ref.field) || !ref.filename || ref.filename.length > 255 || /[\r\n"\\\x00]/.test(ref.filename)
      || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(ref.mediaType)) throw new TelegramOriginHoldError('invalid-attachment-metadata');
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (bytes.includes(Buffer.from(boundary))) throw new TelegramOriginHoldError('multipart-boundary-collision');
    line(`--${boundary}\r\nContent-Disposition: form-data; name="${ref.field}"; filename="${ref.filename}"\r\nContent-Type: ${ref.mediaType}\r\n\r\n`);
    chunks.push(bytes); line('\r\n');
  }
  line(`--${boundary}--\r\n`);
  return Buffer.concat(chunks);
}

export function sealOriginMultipart(request: SealedBotRequest, attachments: PreparedOriginAttachments): void {
  const boundary = `instar-origin-${randomUUID()}`;
  const bytes = renderOriginMultipart(JSON.parse(request.body), boundary, attachments.refs,
    new Map(attachments.payloads.map(payload => [payload.payloadId, payload.data])));
  request.multipart = { boundary, wireDigest: digest(bytes), attachments: structuredClone(attachments.refs) };
}
