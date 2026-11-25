// E2E-PAIRING: EXEMPT — the production server leaves the consent preview service unset.
import { canonicalJson, isCardId, sha256Hex } from '../core/WorkCardStore.js';
import type { WorkBoardService } from '../core/WorkBoardService.js';
import { LOCAL_HISTORY_PLAINTEXT_BYTES } from '../import/LocalHistoryChannel.js';
import type { LocalHistoryChannelExchange, LocalHistoryChannelRegistry } from '../import/LocalHistoryChannelRegistry.js';
import type { LocalHistoryUploadStaging } from '../import/LocalHistoryUploadStaging.js';
import { localHistoryConsentActionLine, readLocalHistoryConsentCard, readLocalHistoryConsentSources,
  type LocalHistoryConsentChallenges, type LocalHistoryConsentMaterial } from './localHistoryConsentSlip.js';
import { LOCAL_HISTORY_CONSENT_PREVIEW_PATH, type SignedLocalHistoryIntakeRequest, type SignedLocalHistoryIntakeService } from './signedLocalHistoryIntake.js';

const channelQuery = /^\?channelId=([0-9a-f-]{36})&sequence=([1-9][0-9]{0,19})$/;
const operationIdPattern = /^[a-f0-9]{32}$/;

type Device = SignedLocalHistoryIntakeRequest['device'];

interface ConsentReviewDeps {
  staging: Pick<LocalHistoryUploadStaging, 'readOwnerConsentPreview' | 'readOwnerConsentCard'>;
  board: Pick<WorkBoardService, 'view'>;
  resolveOwnedCapture: Parameters<typeof readLocalHistoryConsentSources>[1];
}

export interface LocalHistoryConsentSelection {
  readonly operationId: string;
  readonly cardId: string;
  readonly disclosureHash: string;
  readonly applyRequestId: string;
}

function readReview(options: ConsentReviewDeps, device: Device, operationId: string, cardId: string) {
  if (typeof operationId !== 'string' || !operationIdPattern.test(operationId) || !isCardId(cardId)) {
    throw new Error('local-history-consent-preview-request');
  }
  const preview = options.staging.readOwnerConsentPreview(device, operationId);
  const binding = options.staging.readOwnerConsentCard(device, operationId);
  if (preview.ownerUserId !== device.ownerUserId || !binding || binding.cardId !== cardId) {
    throw new Error('local-history-consent-preview-binding');
  }
  const card = readLocalHistoryConsentCard(options.board, binding, preview);
  const sources = readLocalHistoryConsentSources(preview, options.resolveOwnedCapture);
  const disclosure = {
    ...card,
    operationId,
    previewId: preview.previewId,
    previewDigest: preview.previewDigest,
    expiresAt: preview.expiresAt,
    destination: preview.destination,
    files: preview.artifacts.map(({ fileId, kind, projectPath, messages, newMessages, redactions }, index) => ({
      fileId, kind, projectPath, messages, newMessages, redactions,
      machineId: sources[index].machineId, artifactDigest: sources[index].artifactDigest,
    })),
  };
  return { disclosure, sources, ownerUserId: preview.ownerUserId, disclosureHash: sha256Hex(canonicalJson(disclosure)) };
}

/** Dormant native consent path. The transport supplies the admitted device and
 * verified Host. Each call independently rebuilds the same private disclosure.
 * Confirming proves presence only and does not create an apply permit. */
export function createLocalHistoryConsentChallengeBinding(options: ConsentReviewDeps, challenges: LocalHistoryConsentChallenges) {
  function material(device: Device, selection: LocalHistoryConsentSelection): LocalHistoryConsentMaterial {
    const { operationId, cardId, applyRequestId } = selection;
    const { disclosure, sources, ownerUserId, disclosureHash } = readReview(options, device, operationId, cardId);
    if (selection.disclosureHash !== disclosureHash) throw new Error('local-history-consent-disclosure-changed');
    const { materialHash, cardRevision, previewId, previewDigest, destination, expiresAt } = disclosure;
    return { cardId, materialHash, cardRevision, disclosureHash, ownerUserId, previewId, previewDigest,
      destination, expiresAt, sources, applyRequestId };
  }
  return {
    issue(device: Device, host: string, selection: LocalHistoryConsentSelection) {
      const selected = material(device, selection);
      return { ...challenges.issue(device.deviceId, host, selected), actionLine: localHistoryConsentActionLine(selected) };
    },
    confirm(device: Device, host: string, selection: LocalHistoryConsentSelection, challenge: string, signature: unknown) {
      return challenges.confirm(device.deviceId, host, material(device, selection), challenge, signature);
    },
  };
}

/** The production intake deliberately supplies no instance. */
export function createLocalHistoryConsentPreview(options: ConsentReviewDeps & {
  withExchange: SignedLocalHistoryIntakeService['withExchange'];
  channels: Pick<LocalHistoryChannelRegistry, 'open'>;
}): SignedLocalHistoryIntakeService {
  return {
    withExchange: options.withExchange,
    dispatch(request) {
      const { body, device, method, pathname, signal } = request;
      const match = channelQuery.exec(request.query);
      if (signal.aborted || method !== 'POST' || pathname !== LOCAL_HISTORY_CONSENT_PREVIEW_PATH
        || request.recordHeader !== undefined || !match || body.length < 24 || body.readBigUInt64BE().toString() !== match[2]) {
        throw new Error('local-history-consent-preview-record');
      }
      let opened: LocalHistoryChannelExchange | undefined;
      request.onDispose(() => opened?.close());
      const exchange = opened = options.channels.open(device, match[1], { method, path: pathname }, body);
      let status = 200;
      let reply: object;
      try {
        const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(exchange.plaintext));
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2) {
          throw new Error('local-history-consent-preview-request');
        }
        const { disclosure, disclosureHash } = readReview(options, device, input.operationId, input.cardId);
        reply = { ...disclosure, disclosureHash };
      } catch {
        status = 404;
        reply = { error: 'local-history-consent-preview-unavailable' };
      }
      if (signal.aborted || exchange.signal.aborted) throw new Error('local-history-consent-preview-disconnected');
      const plaintext = Buffer.from(JSON.stringify(reply));
      try {
        if (plaintext.length > LOCAL_HISTORY_PLAINTEXT_BYTES) throw new Error('local-history-consent-preview-size');
        return { status, type: 'application/octet-stream', body: exchange.sealResponse(plaintext) };
      } finally { plaintext.fill(0); }
    },
  };
}
