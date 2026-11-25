import { createHash } from 'node:crypto';
import type { Request } from 'express';
import type { AppConversationService } from '../core/AppConversationService.js';
import { isAppConversationKey } from '../core/appConversationText.js';
import { isAppRemovalConversationOwner } from './mobileAppMessageRemovalAdmission.js';
import { exactMessageReader } from './mobileExactMessageAuthority.js';
import { deviceAdmissionIdentity, principalOf, type MobilePairingService } from './mobilePairingRoutes.js';
import type { RemovalSyncAuthority } from './mobileAppRemovalSyncCursor.js';

interface RemovalSyncEvidence {
  machineTrustRevision: (custodian: string) => string | null;
  journalRevision: (conversationKey: string) => string | null;
  teamVisibilityRevision?: () => string | null;
}

type Result = { ok: true; authority: RemovalSyncAuthority }
  | { ok: false; status: 403 | 404 | 503; error: string };

const unavailable = { ok: false, status: 503, error: 'message-removal-sync-unavailable' } as const;
const noAccess = { ok: false, status: 404, error: 'unknown-conversation' } as const;

const hash = (fields: unknown[]) => createHash('sha256').update(JSON.stringify(fields)).digest('base64url');

/** Private owner-only read scope. Team readers require a verifier-backed visibility revision. */
export function resolveOwnerRemovalSyncAuthority(req: Request, pairing: MobilePairingService,
  service: AppConversationService, evidence: RemovalSyncEvidence): Result {
  const principal = principalOf(req);
  const admitted = deviceAdmissionIdentity(req);
  if (req.method !== 'GET' || principal.kind !== 'device' || !admitted) {
    return { ok: false, status: 403, error: 'operator-device-required' };
  }
  try {
    const key = req.params.key;
    const current = exactMessageReader(pairing, req);
    const reader = current();
    if (!isAppConversationKey(key) || reader?.role !== 'owner' || !service.liveConversation(key)
      || !pairing.mayUse(reader, key, 'read')) return noAccess;
    const machine = service.deps.machineId();
    const creation = service.store.getCreationRecord(key);
    if (!creation || !isAppRemovalConversationOwner(reader, creation, machine)) return noAccess;
    const ownsCustody = () => machine !== 'local' && service.deps.machineId() === machine && pairing.machineId() === machine
      && service.serves(key);
    if (creation.machineId !== machine || !ownsCustody()) return unavailable;
    const owner = pairing.ownerIdentity();
    const account = [reader.userId ?? null, owner.telegramOwnerId ?? null, owner.slackOwnerUserId ?? null];
    if (account.every((value) => value === null)) return noAccess;
    const readRevision = () => {
      const keyRevision = pairing.keyLedger?.verificationRevision();
      const trust = evidence.machineTrustRevision(machine);
      const journal = evidence.journalRevision(key);
      const team = evidence.teamVisibilityRevision?.() ?? null;
      if (!keyRevision || !trust || !journal || (evidence.teamVisibilityRevision && !team)) return null;
      return hash([keyRevision, trust, journal, team]);
    };
    const revision = readRevision();
    if (!revision || readRevision() !== revision) return unavailable;
    const finalReader = current();
    const finalOwner = pairing.ownerIdentity();
    if (finalReader?.role !== reader.role || finalReader.userId !== reader.userId
      || (finalOwner.telegramOwnerId ?? null) !== account[1] || (finalOwner.slackOwnerUserId ?? null) !== account[2]
      || !service.liveConversation(key) || !pairing.mayUse(finalReader, key, 'read')) return noAccess;
    const finalCreation = service.store.getCreationRecord(key);
    if (!finalCreation || !isAppRemovalConversationOwner(finalReader, finalCreation, machine)) return noAccess;
    if (finalCreation.machineId !== machine || !ownsCustody()) return unavailable;
    return { ok: true, authority: {
      custodianMachineId: machine, conversationKey: key, deviceId: principal.deviceId,
      deviceKeyHash: admitted.keyHash, readerId: hash(account),
      visibilityRevision: revision,
    } };
  } catch {
    return unavailable; // @silent-fallback-ok — uncertain authority cannot issue or resume a cursor
  }
}
