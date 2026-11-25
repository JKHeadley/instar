import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Current signed authority. The revision must change even when a grant is removed and restored. */
export interface RemovalSyncAuthority {
  custodianMachineId: string;
  conversationKey: string;
  deviceId: string;
  deviceKeyHash: string;
  readerId: string;
  visibilityRevision: string;
}

type CursorResult =
  | { kind: 'resume'; sequence: number }
  | { kind: 'reset' }
  | { kind: 'invalid' };

const BASE64URL_MAC = /^[A-Za-z0-9_-]{43}$/;
const SEQUENCE = /^(0|[1-9][0-9]{0,15})$/;

/** Private process-scoped cursor codec. Production must supply a current authority revision. */
export function createRemovalSyncCursorCodec() {
  const key = randomBytes(32);
  const mac = (domain: string, fields: readonly unknown[]) =>
    createHmac('sha256', key).update(JSON.stringify([domain, ...fields])).digest('base64url');
  const scope = (authority: RemovalSyncAuthority) => [
    authority.custodianMachineId, authority.conversationKey, authority.deviceId,
    authority.deviceKeyHash, authority.readerId,
  ];
  const epochFor = (authority: RemovalSyncAuthority) =>
    mac('app-removal-sync-epoch-v1', [...scope(authority), authority.visibilityRevision]);

  return {
    epochFor,
    issue(authority: RemovalSyncAuthority, sequence: number): string {
      if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('invalid removal sync sequence');
      const epoch = epochFor(authority);
      const signature = mac('app-removal-sync-cursor-v1', [...scope(authority), epoch, sequence]);
      return `1.${epoch}.${sequence}.${signature}`;
    },
    read(authority: RemovalSyncAuthority, token: unknown): CursorResult {
      if (typeof token !== 'string' || token.length > 106) return { kind: 'invalid' };
      const [version, epoch, rawSequence, signature, extra] = token.split('.');
      if (version !== '1' || extra !== undefined || !BASE64URL_MAC.test(epoch) || !SEQUENCE.test(rawSequence)
        || !BASE64URL_MAC.test(signature)) return { kind: 'invalid' };
      const sequence = Number(rawSequence);
      if (!Number.isSafeInteger(sequence)) return { kind: 'invalid' };
      const expected = mac('app-removal-sync-cursor-v1', [...scope(authority), epoch, sequence]);
      if (!timingSafeEqual(Buffer.from(signature, 'ascii'), Buffer.from(expected, 'ascii'))) return { kind: 'invalid' };
      if (epoch !== epochFor(authority)) return { kind: 'reset' };
      return { kind: 'resume', sequence };
    },
  };
}
