import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import type { PublicationScope } from './FencedPublicationStore.js';

export interface PublicationFloor extends PublicationScope {
  epoch: number;
  holder: string;
  head: string;
  position: number;
  witnessGeneration: number;
  witness: string;
}

export interface OrderedPublicationDecision extends PublicationFloor {
  operationKey: string;
  payloadDigest: string;
}

export interface WitnessTransfer {
  floor: PublicationFloor;
  nextWitness: string;
  nextWitnessGeneration: number;
}

export type WitnessPins = ReadonlyMap<string, string>;

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const digestPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[A-Za-z0-9_.:-]{1,256}$/;
const orderedNamespaces = new Set(['needs-you', 'mobile-ingress']);

function fields(floor: PublicationFloor) {
  return [floor.agentId, floor.namespace, floor.epoch, floor.holder, floor.head,
    floor.position, floor.witnessGeneration, floor.witness];
}

export function validPublicationFloor(floor: PublicationFloor): boolean {
  return idPattern.test(floor.agentId) && idPattern.test(floor.holder) &&
    idPattern.test(floor.witness) && floor.holder !== floor.witness &&
    digestPattern.test(floor.head) && Number.isSafeInteger(floor.position) && floor.position >= 0 &&
    Number.isSafeInteger(floor.epoch) && floor.epoch > 0 &&
    Number.isSafeInteger(floor.witnessGeneration) && floor.witnessGeneration > 0;
}

export function samePublicationFloor(left: PublicationFloor, right: PublicationFloor): boolean {
  return JSON.stringify(fields(left)) === JSON.stringify(fields(right));
}

export function orderedDecisionBytes(decision: OrderedPublicationDecision): Buffer {
  return Buffer.from(JSON.stringify(['instar-ordered-publication-v1', ...fields(decision),
    decision.operationKey, decision.payloadDigest]));
}

export function witnessTransferBytes(transfer: WitnessTransfer, role: 'offer' | 'receipt'): Buffer {
  return Buffer.from(JSON.stringify(['instar-publication-witness-transfer-v1', role,
    ...fields(transfer.floor), transfer.nextWitnessGeneration, transfer.nextWitness]));
}

function verifies(pins: WitnessPins, signer: string, bytes: Buffer, signature: Buffer): boolean {
  const pin = pins.get(signer);
  if (!pin || signature.length !== 64) return false;
  try {
    const der = Buffer.from(pin, 'base64');
    if (der.toString('base64') !== pin) return false;
    const key = createPublicKey({ key: der, type: 'spki', format: 'der' });
    return key.asymmetricKeyType === 'ed25519' &&
      key.export({ type: 'spki', format: 'der' }).equals(der) && verify(null, bytes, key, signature);
  } catch {
    return false;
  }
}

/** Validate evidence against an authority-owned floor. The caller must serialize its effect with that floor. */
export function verifiedOrderedSuccessor(
  current: PublicationFloor, decision: OrderedPublicationDecision, exactPayload: string,
  signature: Buffer, pins: WitnessPins,
): PublicationFloor | null {
  if (!validPublicationFloor(current) || !orderedNamespaces.has(current.namespace) ||
      !samePublicationFloor(current, decision) || !idPattern.test(decision.operationKey) ||
      hash(exactPayload) !== decision.payloadDigest || current.position >= Number.MAX_SAFE_INTEGER) return null;
  const bytes = orderedDecisionBytes(decision);
  if (!verifies(pins, current.witness, bytes, signature)) return null;
  return { ...current, position: current.position + 1, head: hash(bytes) };
}

export function verifiedWitnessSuccessor(
  current: PublicationFloor, transfer: WitnessTransfer, offer: Buffer, receipt: Buffer, pins: WitnessPins,
): PublicationFloor | null {
  if (!validPublicationFloor(current) || !samePublicationFloor(current, transfer.floor) ||
      !idPattern.test(transfer.nextWitness) || transfer.nextWitness === current.holder ||
      transfer.nextWitness === current.witness || !Number.isSafeInteger(transfer.nextWitnessGeneration) ||
      transfer.nextWitnessGeneration !== current.witnessGeneration + 1 ||
      !verifies(pins, current.witness, witnessTransferBytes(transfer, 'offer'), offer) ||
      !verifies(pins, transfer.nextWitness, witnessTransferBytes(transfer, 'receipt'), receipt)) return null;
  return { ...current, witness: transfer.nextWitness, witnessGeneration: transfer.nextWitnessGeneration };
}

export interface OrderedHolderHandover {
  floor: PublicationFloor;
  nextEpoch: number;
  nextHolder: string;
  sealDigest: string;
}

export function holderHandoverBytes(handover: OrderedHolderHandover): Buffer {
  return Buffer.from(JSON.stringify(['instar-ordered-holder-handover-v1', ...fields(handover.floor),
    handover.nextEpoch, handover.nextHolder, handover.sealDigest]));
}

/** The witness attests the exact sealed transition, including the prior head. */
export function verifiedHolderSuccessor(
  current: PublicationFloor, handover: OrderedHolderHandover, signature: Buffer, pins: WitnessPins,
): PublicationFloor | null {
  if (!validPublicationFloor(current) || !samePublicationFloor(current, handover.floor) ||
      !Number.isSafeInteger(handover.nextEpoch) || handover.nextEpoch <= current.epoch ||
      !idPattern.test(handover.nextHolder) || handover.nextHolder === current.witness ||
      !digestPattern.test(handover.sealDigest) || current.position >= Number.MAX_SAFE_INTEGER) return null;
  const bytes = holderHandoverBytes(handover);
  if (!verifies(pins, current.witness, bytes, signature)) return null;
  return {
    ...current, epoch: handover.nextEpoch, holder: handover.nextHolder,
    head: hash(bytes), position: current.position + 1,
  };
}

export interface OrderedFloorChallenge {
  destination: string;
  scope: PublicationScope;
  commit: string;
  nonce: string;
}

export interface OrderedFloorReadback {
  floor: PublicationFloor;
  signature: Buffer;
}

export function orderedFloorReadbackBytes(challenge: OrderedFloorChallenge, floor: PublicationFloor): Buffer {
  return Buffer.from(JSON.stringify(['instar-ordered-floor-readback-v1', challenge.destination,
    challenge.scope.agentId, challenge.scope.namespace, challenge.commit, challenge.nonce, ...fields(floor)]));
}

/**
 * Verify a fresh readback from the currently enrolled independent witness.
 * This is a read boundary for local evidence, separate from authority CAS.
 */
export function createOrderedFloorReader(deps: {
  /** Receiver-pinned canonical repository plus fully qualified ref. */
  destination: string;
  pins: WitnessPins;
  readGitTip(scope: PublicationScope): string | null;
  currentWitness(scope: PublicationScope): { id: string; generation: number } | null;
  /** The witness must independently observe the challenged commit before responding. */
  readWitness(challenge: OrderedFloorChallenge): OrderedFloorReadback | null;
}): (scope: PublicationScope) => PublicationFloor | null {
  return scope => {
    const commit = deps.readGitTip(scope);
    const enrolled = deps.currentWitness(scope);
    if (!commit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) || !enrolled) return null;

    const challenge = Object.freeze({
      destination: deps.destination, scope: Object.freeze({ ...scope }), commit,
      nonce: randomBytes(32).toString('hex'),
    });
    const readback = deps.readWitness(challenge);
    if (!readback) return null;

    const { floor, signature } = readback;
    if (!validPublicationFloor(floor) || floor.agentId !== scope.agentId || floor.namespace !== scope.namespace ||
        floor.witness !== enrolled.id || floor.witnessGeneration !== enrolled.generation ||
        !verifies(deps.pins, enrolled.id, orderedFloorReadbackBytes(challenge, floor), signature)) return null;
    const latest = deps.currentWitness(scope);
    return latest?.id === enrolled.id && latest.generation === enrolled.generation && deps.readGitTip(scope) === commit
      ? { ...floor } : null;
  };
}

/** The authenticated peer comes from the transport, never from the challenge. */
export function createOrderedFloorResponder(deps: {
  destination: string;
  scope: PublicationScope;
  witnessId: string;
  mayRead(peer: string, scope: PublicationScope): boolean;
  /** An independent, current and durable snapshot of the accepted Git/floor pair. */
  readAcceptedSnapshot(scope: PublicationScope): { commit: string; floor: PublicationFloor } | null;
  /** Machine-local signer pinned to witnessId by enrollment. */
  signReadback(bytes: Buffer): Buffer;
}): (peer: string, challenge: OrderedFloorChallenge) => OrderedFloorReadback | null {
  const { destination, witnessId } = deps;
  const scope = Object.freeze({ ...deps.scope });
  return (peer, challenge) => {
    if (!challenge?.scope || challenge.destination !== destination ||
        challenge.scope.agentId !== scope.agentId || challenge.scope.namespace !== scope.namespace ||
        !/^[a-f0-9]{64}$/.test(challenge.nonce) ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(challenge.commit) || !deps.mayRead(peer, scope)) return null;

    const exactChallenge = { destination, scope, commit: challenge.commit, nonce: challenge.nonce };
    const snapshot = deps.readAcceptedSnapshot(scope);
    if (!snapshot || snapshot.commit !== exactChallenge.commit) return null;
    const floor = { ...snapshot.floor };
    if (!validPublicationFloor(floor) || floor.agentId !== scope.agentId || floor.namespace !== scope.namespace ||
        floor.witness !== witnessId) return null;

    const signature = deps.signReadback(orderedFloorReadbackBytes(exactChallenge, floor));
    return signature.length === 64 ? { floor, signature } : null;
  };
}
