import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AppMessageIndexKey } from './AppConversationStore.js';
import type { MediaKind } from './appMediaTypes.js';

const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SCOPE_BYTES = 32;
const HEADER_BYTES = 1 + SCOPE_BYTES;
const MAX_AT_UNITS = 64;
const MAX_EVENT_ID_UNITS = 128;
// A JSON two-string array adds 7 bytes. A UTF-16 code unit can need a six-byte escape.
const MAX_BOUNDARY_BYTES = 7 + 6 * (MAX_AT_UNITS + MAX_EVENT_ID_UNITS);
const MAX_WIRE_BYTES = NONCE_BYTES + TAG_BYTES + HEADER_BYTES + MAX_BOUNDARY_BYTES;
const MIN_WIRE_BYTES = NONCE_BYTES + TAG_BYTES + HEADER_BYTES + 7;
const MAX_TOKEN_LENGTH = Math.ceil(MAX_WIRE_BYTES * 4 / 3);
const AAD = Buffer.from('GET /mobile/chat/app/:key/attachments');
const utf8 = new TextDecoder('utf-8', { fatal: true });

export interface AppAttachmentCursorScope {
  deviceId: string;
  deviceKeyHash: string;
  personId: string | null;
  canonicalConversationKey: string;
  kind: MediaKind;
}

export function isAppAttachmentBoundary(key: AppMessageIndexKey): boolean {
  return typeof key.eventId === 'string' && key.eventId.length > 0 && key.eventId.length <= MAX_EVENT_ID_UNITS
    && typeof key.at === 'string' && key.at.length > 0 && key.at.length <= MAX_AT_UNITS
    && !Number.isNaN(Date.parse(key.at));
}

/** Construct once per serving process. The owning route must independently reauthorize each page. */
export class AppAttachmentCursor {
  private readonly encryptionKey = randomBytes(32);
  private readonly scopeKey = randomBytes(32);

  seal(scope: AppAttachmentCursorScope, key: AppMessageIndexKey): string {
    if (!isAppAttachmentBoundary(key)) throw new Error('Unrepresentable attachment browse boundary');
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(AAD);
    const plaintext = Buffer.concat([
      Buffer.from([VERSION]),
      this.scopeDigest(scope),
      Buffer.from(JSON.stringify([key.at, key.eventId])),
    ]);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
  }

  open(scope: AppAttachmentCursorScope, token: unknown): AppMessageIndexKey | null {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.length < MIN_WIRE_BYTES || bytes.length > MAX_WIRE_BYTES || bytes.toString('base64url') !== token) return null;
    try {
      const nonce = bytes.subarray(0, NONCE_BYTES);
      const tagEnd = NONCE_BYTES + TAG_BYTES;
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, nonce, { authTagLength: TAG_BYTES });
      decipher.setAAD(AAD);
      decipher.setAuthTag(bytes.subarray(NONCE_BYTES, tagEnd));
      const plaintext = Buffer.concat([decipher.update(bytes.subarray(tagEnd)), decipher.final()]);
      if (plaintext[0] !== VERSION || !timingSafeEqual(plaintext.subarray(1, HEADER_BYTES), this.scopeDigest(scope))) return null;

      const fields: unknown = JSON.parse(utf8.decode(plaintext.subarray(HEADER_BYTES)));
      if (!Array.isArray(fields) || fields.length !== 2) return null;
      const [at, eventId] = fields;
      const key = { at, eventId };
      return isAppAttachmentBoundary(key) ? key : null;
    } catch {
      // @silent-fallback-ok: malformed or unauthenticated cursors produce one invalid outcome.
      return null;
    }
  }

  private scopeDigest(scope: AppAttachmentCursorScope): Buffer {
    return createHmac('sha256', this.scopeKey)
      .update(JSON.stringify([scope.deviceId, scope.deviceKeyHash, scope.personId, scope.canonicalConversationKey, scope.kind]))
      .digest();
  }
}
