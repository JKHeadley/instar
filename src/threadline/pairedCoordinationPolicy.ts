import { createHash } from 'node:crypto';
import type { PairingState } from './AgentTrustManager.js';

const scope = 'threadline.own-paired-agents.work-coordination.v1' as const;
export const PAIRED_COORDINATION_APPROVAL = 'Allow my own paired agents to message each other for work coordination. This applies only while both agents belong to me and their pairing is current. I can turn it off at any time.';

interface OperatorBinding {
  operatorId: string;
  ownerRevision: string;
}
interface Grant extends OperatorBinding {
  scope: typeof scope;
  revision: number;
  state: 'allowed' | 'revoked';
}
interface Peer extends OperatorBinding {
  /** Full keys from authenticated transport and the local pairing record, respectively. */
  authenticatedKeyHex: string;
  pairedKeyHex: string;
  pairingState: PairingState;
}
interface GrantChange extends OperatorBinding {
  expectedRevision: number;
  action: 'allow' | 'revoke';
}
interface PinApproval {
  authorizationId: string;
  operatorId: string;
  requestDigest: string;
}

const fingerprint = /^[a-f0-9]{32}$/;
const publicKey = /^[a-f0-9]{64}$/;
const workId = /^[A-Za-z0-9_-]{1,128}$/;

function sameOperator(a: OperatorBinding, b: OperatorBinding): boolean {
  return !!a.operatorId && !!a.ownerRevision && a.operatorId === b.operatorId && a.ownerRevision === b.ownerRevision;
}

export function pairedCoordinationGrantDigest(change: GrantChange): string {
  return createHash('sha256').update(JSON.stringify([
    scope, change.operatorId, change.ownerRevision, change.expectedRevision, change.action,
  ])).digest('hex');
}

/** Dark policy. Call with exact recipient identity from the transport and authority-owned evidence only. */
export function createPairedCoordinationPolicy(deps: {
  enabled?: boolean;
  /** Read live pairing, verified membership and current grant under the same authority snapshot. */
  readRecipient: (recipientFingerprint: string, coordinationId: string) => {
    sender: OperatorBinding; peer: Peer; grant: Grant; blocked: boolean;
    /** A verified work record bound to the exact outgoing message and full recipient key. */
    work: { coordinationId: string; messageDigest: string; recipientKeyHex: string };
  } | null;
  /** This is the control-plane owner PIN approval, scoped to the exact change digest. */
  readPinApproval: (authorizationId: string) => PinApproval | null;
  /** Atomically recheck owner revision and expected grant revision, consume the approval and record the change. */
  commitGrantChange: (change: Readonly<GrantChange>, approval: Readonly<PinApproval>) => boolean;
}) {
  return {
    admitsWorkCoordination(recipient: Readonly<{ fingerprint: string; authenticatedKeyHex: string }>,
      action: Readonly<{ coordinationId: string; messageDigest: string }>): boolean {
      if (deps.enabled !== true || typeof recipient?.fingerprint !== 'string' || !fingerprint.test(recipient.fingerprint)
        || typeof recipient.authenticatedKeyHex !== 'string' || !publicKey.test(recipient.authenticatedKeyHex)
        || !recipient.authenticatedKeyHex.startsWith(recipient.fingerprint)
        || typeof action?.coordinationId !== 'string' || !workId.test(action.coordinationId)
        || typeof action.messageDigest !== 'string' || !publicKey.test(action.messageDigest)) return false;
      const current = deps.readRecipient(recipient.fingerprint, action.coordinationId);
      if (!current || current.blocked || current.grant.scope !== scope || current.grant.state !== 'allowed'
        || !Number.isSafeInteger(current.grant.revision) || current.grant.revision < 1) return false;
      const { sender, peer, grant, work } = current;
      return work.coordinationId === action.coordinationId && work.messageDigest === action.messageDigest
        && work.recipientKeyHex === recipient.authenticatedKeyHex && sameOperator(sender, peer) && sameOperator(sender, grant)
        && (peer.pairingState === 'mutual-verified' || peer.pairingState === 'identity-verified')
        && recipient.authenticatedKeyHex === peer.authenticatedKeyHex
        && recipient.authenticatedKeyHex === peer.pairedKeyHex;
    },

    changeGrant(input: GrantChange, authorizationId: string): boolean {
      const change = Object.freeze({ ...input });
      if (deps.enabled !== true || !change.operatorId || !change.ownerRevision
        || !Number.isSafeInteger(change.expectedRevision) || change.expectedRevision < 0
        || (change.action !== 'allow' && change.action !== 'revoke')) return false;
      const proof = deps.readPinApproval(authorizationId);
      if (!proof || !proof.authorizationId || proof.authorizationId !== authorizationId
        || proof.operatorId !== change.operatorId || proof.requestDigest !== pairedCoordinationGrantDigest(change)) return false;
      return deps.commitGrantChange(change, Object.freeze({ ...proof }));
    },
  };
}
