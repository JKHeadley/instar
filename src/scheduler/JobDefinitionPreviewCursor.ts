import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface JobDefinitionPreviewPosition {
  fingerprint: string;
  nextIndex: number;
}

export interface JobDefinitionPreviewCursorScope {
  sessionId: string;
  machineId: string;
}

const KEY = randomBytes(32);
const TTL_MS = 5 * 60_000;
const MAX_TOKEN_LENGTH = 512;

function context(scope: JobDefinitionPreviewCursorScope): Buffer {
  return Buffer.from(JSON.stringify(['local-job-definitions-v1', scope.machineId, scope.sessionId]));
}

export function isJobDefinitionPreviewPosition(value: unknown): value is JobDefinitionPreviewPosition {
  if (!value || typeof value !== 'object') return false;
  const { fingerprint, nextIndex } = value as JobDefinitionPreviewPosition;
  return typeof fingerprint === 'string' && /^[a-f0-9]{64}$/.test(fingerprint)
    && Number.isSafeInteger(nextIndex) && nextIndex > 0 && nextIndex <= 11_000;
}

export class JobDefinitionPreviewCursor {
  encode(scope: JobDefinitionPreviewCursorScope, position: JobDefinitionPreviewPosition): string {
    if (!isJobDefinitionPreviewPosition(position)) throw new Error('Invalid preview position');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', KEY, nonce);
    cipher.setAAD(context(scope));
    const payload = JSON.stringify([Date.now() + TTL_MS, position.fingerprint, position.nextIndex]);
    const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
  }

  decode(scope: JobDefinitionPreviewCursorScope, token: string): JobDefinitionPreviewPosition | null {
    if (token.length > MAX_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
    try {
      const packed = Buffer.from(token, 'base64url');
      if (packed.length <= 28 || packed.toString('base64url') !== token) return null;
      const decipher = createDecipheriv('aes-256-gcm', KEY, packed.subarray(0, 12));
      decipher.setAAD(context(scope));
      decipher.setAuthTag(packed.subarray(12, 28));
      const plain = Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]);
      const [expiry, fingerprint, nextIndex] = JSON.parse(plain.toString('utf8'));
      const now = Date.now();
      const position = { fingerprint, nextIndex };
      if (!Number.isSafeInteger(expiry) || expiry <= now || expiry > now + TTL_MS
        || !isJobDefinitionPreviewPosition(position)) return null;
      return position;
    } catch {
      return null;
    }
  }
}
