/** Browser-to-target AES-GCM records for remote desktop. The relay sees only
 * ciphertext. Direction-specific IV domains and exact sequence progression
 * prevent reflection, reordering and replay. A new ECDH key is used per grant. */
import crypto from 'node:crypto';

export type DesktopDirection = 'frame' | 'input';

function iv(direction: DesktopDirection, sequence: bigint): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeUInt32BE(direction === 'frame' ? 1 : 2, 0);
  nonce.writeBigUInt64BE(sequence, 4);
  return nonce;
}

function aad(requestId: string, direction: DesktopDirection): Buffer {
  return Buffer.from(JSON.stringify(['instar-desktop-aead-v1', requestId, direction]));
}

export class DesktopAead {
  private nextFrame = 1n;
  private nextInput = 1n;

  constructor(private readonly key: Buffer, private readonly requestId: string) {
    if (key.length !== 32 || !/^[0-9a-f-]{36}$/.test(requestId)) throw new Error('desktop AEAD key or scope invalid');
  }

  encryptFrame(frame: Buffer): Buffer {
    if (frame.length < 4 || frame.length > 1_000_000) throw new Error('desktop frame size invalid');
    const sequence = this.nextFrame++;
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv('frame', sequence));
    cipher.setAAD(aad(this.requestId, 'frame'));
    const encrypted = Buffer.concat([cipher.update(frame), cipher.final()]);
    const header = Buffer.alloc(8);
    header.writeBigUInt64BE(sequence);
    return Buffer.concat([header, encrypted, cipher.getAuthTag()]);
  }

  decryptInput(record: Buffer): unknown {
    if (record.length < 8 + 16 + 2 || record.length > 4_096) throw new Error('desktop input record size invalid');
    const sequence = record.readBigUInt64BE(0);
    if (sequence !== this.nextInput) throw new Error('desktop input sequence invalid');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv('input', sequence));
    decipher.setAAD(aad(this.requestId, 'input'));
    decipher.setAuthTag(record.subarray(record.length - 16));
    const plaintext = Buffer.concat([decipher.update(record.subarray(8, record.length - 16)), decipher.final()]);
    this.nextInput++;
    return JSON.parse(plaintext.toString('utf8')) as unknown;
  }
}

export function deriveDesktopKey(browserEcdhPublicKey: Buffer, requestId: string, machineId: string): {
  key: Buffer; targetPublicKey: Buffer; salt: Buffer;
} {
  if (browserEcdhPublicKey.length !== 65 || browserEcdhPublicKey[0] !== 4) throw new Error('browser ECDH key invalid');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const shared = ecdh.computeSecret(browserEcdhPublicKey);
  const salt = crypto.randomBytes(32);
  const info = Buffer.from(`instar-desktop-aead-v1:${requestId}:${machineId}`);
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, salt, info, 32));
  return { key, targetPublicKey: ecdh.getPublicKey(undefined, 'uncompressed'), salt };
}
