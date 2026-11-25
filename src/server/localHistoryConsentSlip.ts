// E2E-PAIRING: EXEMPT — unmounted proof helper with no HTTP route or runtime caller.
import { CLAUDE_CODE_FRAMEWORK } from '../core/frameworkFacts.js';
import type { LocalSessionSource } from '../import/localSessionParsers.js';
import type { WorkBoardService } from '../core/WorkBoardService.js';
import type { LocalHistoryConsentCardBinding, LocalHistoryUploadStaging } from '../import/LocalHistoryUploadStaging.js';
import { canonicalJson, isCardId, isRestrictingTap, sha256Hex, type CardFold } from '../core/WorkCardStore.js';
import { verifyPresenceSignature } from './mobileConsoleTicket.js';
import { ActionChallengeStore, permissionPresenceMessage } from './mobilePermissionsRoutes.js';

const digest = /^[a-f0-9]{64}$/;
const id = /^[a-f0-9]{32}$/;
const opaque = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;

export interface LocalHistoryConsentMaterial {
  cardId: string;
  materialHash: string;
  cardRevision: string;
  disclosureHash: string;
  ownerUserId: string;
  previewId: string;
  previewDigest: string;
  sources: readonly { kind: LocalSessionSource; machineId: string; artifactDigest: string }[];
  destination: { machineId: string; machineKeyHash: string; agentId: string; ownerUserId: string; bootId: string; origin: string };
  expiresAt: number;
  applyRequestId: string;
}

type ConsentPreview = ReturnType<LocalHistoryUploadStaging['readOwnerConsentPreview']>;

interface OwnedSourceCapture {
  operationId: string;
  ownerUserId: string;
  machineId: string;
  files: readonly { fileId: string; kind: LocalSessionSource; captureDigest: string }[];
}

/** Join the staged preview with a capture returned by a trusted server-side
 * resolver. The resolver must independently establish current source ownership
 * and machine identity. The uploaded manifest establishes neither. */
export function readLocalHistoryConsentSources(preview: ConsentPreview,
  resolveOwnedCapture: (operationId: string, destination: ConsentPreview['destination']) => OwnedSourceCapture | undefined,
): LocalHistoryConsentMaterial['sources'] {
  const capture = resolveOwnedCapture(preview.operationId, preview.destination);
  const refuse = (): never => { throw new Error('local-history-consent-source-binding'); };
  if (!capture || capture.operationId !== preview.operationId || capture.ownerUserId !== preview.ownerUserId
    || !matches(opaque, capture.machineId) || !Array.isArray(capture.files)
    || capture.files.length !== preview.artifacts.length) return refuse();
  return Object.freeze(preview.artifacts.map((artifact, index) => {
    const file = capture.files[index];
    if (!file || file.fileId !== artifact.fileId || file.kind !== artifact.kind
      || file.captureDigest !== artifact.captureDigest) return refuse();
    return Object.freeze({ kind: artifact.kind, machineId: capture.machineId, artifactDigest: artifact.artifactDigest });
  }));
}


/** Distinguishes a material edit and revert, as well as a Work Board reopen. */
export function localHistoryConsentCardRevision(card: Pick<CardFold, 'materialRevision' | 'reopens' | 'taps'>): string {
  if (!card.materialRevision) throw new Error('local-history-consent-card-stale');
  const restrictions = card.taps.filter(tap => isRestrictingTap(tap.action)).map(tap => tap.id);
  return sha256Hex(canonicalJson([card.materialRevision, card.reopens, restrictions]));
}

const closedCardStatuses = new Set(['removed', 'unknown', 'archived', 'done', 'held']);

/** Read the actual folded Work Board revision for one server-owned association.
 * A generic Work Board approval still provides no import authority. */
export function readLocalHistoryConsentCard(board: Pick<WorkBoardService, 'view'>,
  binding: LocalHistoryConsentCardBinding, preview: ConsentPreview): Readonly<{ cardId: string; materialHash: string; cardRevision: string }> {
  if (!isCardId(binding.cardId) || !matches(digest, binding.materialHash) || binding.operationId !== preview.operationId
    || binding.previewId !== preview.previewId || binding.previewDigest !== preview.previewDigest
    || binding.ownerUserId !== preview.ownerUserId) throw new Error('local-history-consent-card-binding');
  const view = board.view(binding.cardId);
  if (!view || closedCardStatuses.has(view.status) || !view.card.created || view.card.cardId !== binding.cardId
    || view.card.redacted || view.card.withdrawn || view.card.materialHash !== binding.materialHash
    || localHistoryConsentCardRevision(view.card) !== binding.cardRevision) {
    throw new Error('local-history-consent-card-stale');
  }
  return Object.freeze({ cardId: view.card.cardId, materialHash: view.card.materialHash, cardRevision: binding.cardRevision });
}

interface OwnerPhone {
  deviceId: string;
  host: string;
  ownerUserId: string;
  presenceKey: string;
}

function shape(object: object, keys: readonly string[]): boolean {
  return object !== null && typeof object === 'object' && !Array.isArray(object)
    && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
}

function matches(pattern: RegExp, value: unknown): boolean {
  return typeof value === 'string' && pattern.test(value);
}

/** The caller constructs this material from the live Work Board card and the
 * sealed preview. It must never accept a phone-supplied preview projection. */
export function localHistoryConsentActionLine(material: LocalHistoryConsentMaterial): string {
  const refuse = () => { throw new Error('local-history-consent-material'); };
  if (!shape(material, ['cardId', 'materialHash', 'cardRevision', 'disclosureHash', 'ownerUserId', 'previewId', 'previewDigest', 'sources',
    'destination', 'expiresAt', 'applyRequestId'])) refuse();
  const { destination, sources } = material;
  if (!isCardId(material.cardId) || ![material.materialHash, material.cardRevision, material.disclosureHash, material.previewDigest].every(value => matches(digest, value))
    || !matches(opaque, material.ownerUserId) || !matches(id, material.previewId) || !matches(id, material.applyRequestId)
    || !Number.isSafeInteger(material.expiresAt) || material.expiresAt <= 0
    || !Array.isArray(sources) || sources.length < 1 || sources.length > 1024
    || !Array.from(sources).every(source => shape(source, ['kind', 'machineId', 'artifactDigest'])
      && (source.kind === 'codex' || source.kind === CLAUDE_CODE_FRAMEWORK)
      && matches(opaque, source.machineId) && matches(digest, source.artifactDigest))
    || !shape(destination, ['machineId', 'machineKeyHash', 'agentId', 'ownerUserId', 'bootId', 'origin'])
    || ![destination.machineId, destination.agentId, destination.bootId].every(value => matches(opaque, value))
    || !matches(digest, destination.machineKeyHash) || material.ownerUserId !== destination.ownerUserId) refuse();
  if (typeof destination.origin !== 'string' || destination.origin.length > 512) refuse();
  const origin = new URL(destination.origin);
  if (origin.origin !== destination.origin || (origin.protocol !== 'https:'
    && !(origin.protocol === 'http:' && origin.hostname === '127.0.0.1'))) refuse();
  return `local-history-copy ${material.cardId} ${sha256Hex(canonicalJson({ version: 1, ...material }))}`;
}

function challengeBinding(line: string, presenceKey: string): string {
  return line + '\n' + sha256Hex(presenceKey);
}

/** Dormant proof adapter for an eventual native route. Its current-phone
 * resolver must enforce native owner admission and key revocation on each call.
 * A successful proof is not a permit and this adapter never writes history. */
export class LocalHistoryConsentChallenges {
  private readonly challenges: ActionChallengeStore;
  constructor(private readonly currentPhone: (deviceId: string) => OwnerPhone | undefined,
    private readonly now: () => number = Date.now) {
    this.challenges = new ActionChallengeStore(now);
  }

  issue(deviceId: string, host: string, material: LocalHistoryConsentMaterial) {
    const line = localHistoryConsentActionLine(material);
    const owner = this.phone(deviceId, host, material);
    const issued = this.challenges.issue(deviceId, host, challengeBinding(line, owner.presenceKey));
    return { ...issued, expiresAt: Math.min(issued.expiresAt, material.expiresAt) };
  }

  confirm(deviceId: string, host: string, material: LocalHistoryConsentMaterial, challenge: string, signature: unknown):
    Readonly<{ actionLine: string; proofRef: string; expiresAt: number; presenceBinding: string }> {
    const actionLine = localHistoryConsentActionLine(material);
    const owner = this.phone(deviceId, host, material);
    if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)
      || !verifyPresenceSignature(owner.presenceKey, permissionPresenceMessage(deviceId, host, challenge, actionLine), signature)) {
      throw new Error('local-history-consent-presence');
    }
    const proof = this.challenges.take(challenge, deviceId, host, challengeBinding(actionLine, owner.presenceKey));
    if (!proof) throw new Error('local-history-consent-challenge');
    return Object.freeze({ actionLine, proofRef: proof.ref, expiresAt: Math.min(proof.expiresAt, material.expiresAt),
      presenceBinding: sha256Hex(owner.presenceKey) });
  }

  currentPresenceBinding(deviceId: string, host: string, material: LocalHistoryConsentMaterial): string {
    return sha256Hex(this.phone(deviceId, host, material).presenceKey);
  }

  private phone(deviceId: string, host: string, material: LocalHistoryConsentMaterial): OwnerPhone {
    const phone = this.currentPhone(deviceId);
    if (!phone || phone.deviceId !== deviceId || phone.host.toLowerCase() !== host.toLowerCase()
      || phone.ownerUserId !== material.ownerUserId || this.now() >= material.expiresAt) {
      throw new Error('local-history-consent-owner');
    }
    return phone;
  }
}
