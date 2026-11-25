import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DIGEST_BYTES = 32;
const WIRE_BYTES = NONCE_BYTES + TAG_BYTES + DIGEST_BYTES;
const TOKEN_LENGTH = Math.ceil(WIRE_BYTES * 4 / 3);

export interface AttachmentOpenScope {
  deviceId: string;
  deviceKeyHash: string;
  personId: string | null;
  canonicalConversationKey: string;
}

export interface AttachmentOccurrence {
  eventId: string;
  messageId: string;
  attachmentId: string;
  index: number;
  sha256: string;
  size: number;
}

function associatedData(scope: AttachmentOpenScope, purpose: 'replica' | 'occurrence'): Buffer {
  return Buffer.from(JSON.stringify([
    'app-attachment-open-v1', purpose, scope.deviceId, scope.deviceKeyHash,
    scope.personId, scope.canonicalConversationKey,
  ]));
}

function occurrenceDigest(tuple: AttachmentOccurrence): Buffer {
  return createHash('sha256').update(JSON.stringify([
    tuple.eventId, tuple.messageId, tuple.attachmentId, tuple.index, tuple.sha256, tuple.size,
  ])).digest();
}

/** Share one instance between listing and opening on a serving incarnation. Tokens select evidence only. */
export class AppAttachmentOpenToken {
  private readonly key = randomBytes(32);
  private readonly incarnation = randomBytes(DIGEST_BYTES);

  sealReplica(scope: AttachmentOpenScope): string {
    return this.seal(associatedData(scope, 'replica'), this.incarnation);
  }

  matchesReplica(scope: AttachmentOpenScope, token: unknown): boolean {
    const digest = this.open(associatedData(scope, 'replica'), token);
    return digest !== null && timingSafeEqual(digest, this.incarnation);
  }

  sealOccurrence(scope: AttachmentOpenScope, tuple: AttachmentOccurrence): string {
    return this.seal(associatedData(scope, 'occurrence'), occurrenceDigest(tuple));
  }

  openOccurrence(scope: AttachmentOpenScope, token: unknown): ((tuple: AttachmentOccurrence) => boolean) | null {
    const digest = this.open(associatedData(scope, 'occurrence'), token);
    return digest && (tuple => timingSafeEqual(digest, occurrenceDigest(tuple)));
  }

  private seal(aad: Buffer, digest: Buffer): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(digest), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
  }

  private open(aad: Buffer, token: unknown): Buffer | null {
    if (typeof token !== 'string' || token.length !== TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.length !== WIRE_BYTES || bytes.toString('base64url') !== token) return null;
    try {
      const tagEnd = NONCE_BYTES + TAG_BYTES;
      const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, NONCE_BYTES), { authTagLength: TAG_BYTES });
      decipher.setAAD(aad);
      decipher.setAuthTag(bytes.subarray(NONCE_BYTES, tagEnd));
      return Buffer.concat([decipher.update(bytes.subarray(tagEnd)), decipher.final()]);
    } catch {
      // @silent-fallback-ok: unauthenticated input has the same invalid outcome as malformed input.
      return null;
    }
  }
}
