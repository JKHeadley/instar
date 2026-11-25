// E2E-PAIRING: EXEMPT — the production server leaves the consent preview service unset.
import { canonicalJson, isCardId, sha256Hex } from '../core/WorkCardStore.js';
import type { WorkBoardService } from '../core/WorkBoardService.js';
import { LOCAL_HISTORY_PLAINTEXT_BYTES } from '../import/LocalHistoryChannel.js';
import type { LocalHistoryChannelExchange, LocalHistoryChannelRegistry } from '../import/LocalHistoryChannelRegistry.js';
import type { LocalHistoryUploadStaging } from '../import/LocalHistoryUploadStaging.js';
import { localHistoryConsentActionLine, readLocalHistoryConsentCard, readLocalHistoryConsentSources,
  type LocalHistoryConsentChallenges, type LocalHistoryConsentMaterial } from './localHistoryConsentSlip.js';
import { isLocalHistoryConsentPath, LOCAL_HISTORY_CONSENT_CHALLENGE_PATH, LOCAL_HISTORY_CONSENT_CONFIRM_PATH, LOCAL_HISTORY_CONSENT_PREVIEW_PATH, type SignedLocalHistoryIntakeRequest, type SignedLocalHistoryIntakeService } from './signedLocalHistoryIntake.js';

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

const previewFields = ['operationId', 'cardId'];
const selectionFields = [...previewFields, 'disclosureHash', 'applyRequestId'];
const confirmFields = [...selectionFields, 'challenge', 'signature'];

function hasFields(input: unknown, fields: readonly string[]): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).length === fields.length && fields.every(field => Object.hasOwn(input, field));
}

type ConsentActions = ReturnType<typeof createLocalHistoryConsentChallengeBinding>;

function readSelection(input: unknown, fields: readonly string[]): LocalHistoryConsentSelection {
  if (!hasFields(input, fields) || typeof input.operationId !== 'string' || !isCardId(input.cardId)
    || typeof input.applyRequestId !== 'string' || !operationIdPattern.test(input.applyRequestId)
    || typeof input.disclosureHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.disclosureHash)) {
    throw new Error('local-history-consent-request');
  }
  return { operationId: input.operationId, cardId: input.cardId, applyRequestId: input.applyRequestId, disclosureHash: input.disclosureHash };
}

function readConsentReply(options: ConsentReviewDeps, request: SignedLocalHistoryIntakeRequest, input: unknown,
  actions: ConsentActions | undefined): object {
  const { pathname, device, host } = request;
  if (pathname === LOCAL_HISTORY_CONSENT_PREVIEW_PATH) {
    if (!hasFields(input, previewFields) || typeof input.operationId !== 'string' || !isCardId(input.cardId)) {
      throw new Error('local-history-consent-request');
    }
    const { disclosure, disclosureHash } = readReview(options, device, input.operationId, input.cardId);
    return { ...disclosure, disclosureHash };
  }
  if (!actions || !host) throw new Error('local-history-consent-unavailable');
  if (pathname === LOCAL_HISTORY_CONSENT_CHALLENGE_PATH) {
    const { secret, expiresAt, actionLine } = actions.issue(device, host, readSelection(input, selectionFields));
    return { challenge: secret, expiresAt, actionLine };
  }
  if (pathname === LOCAL_HISTORY_CONSENT_CONFIRM_PATH && hasFields(input, confirmFields)
    && typeof input.challenge === 'string' && typeof input.signature === 'string') {
    return actions.confirm(device, host, readSelection(input, confirmFields), input.challenge, input.signature);
  }
  throw new Error('local-history-consent-request');
}

/** The production intake deliberately supplies no instance. */
export function createLocalHistoryConsentPreview(options: ConsentReviewDeps & {
  withExchange: SignedLocalHistoryIntakeService['withExchange'];
  channels: Pick<LocalHistoryChannelRegistry, 'open'>;
  challenges?: LocalHistoryConsentChallenges;
}): SignedLocalHistoryIntakeService {
  const actions = options.challenges && createLocalHistoryConsentChallengeBinding(options, options.challenges);
  return {
    withExchange: options.withExchange,
    dispatch(request) {
      const { body, device, method, pathname, signal } = request;
      const match = channelQuery.exec(request.query);
      if (signal.aborted || method !== 'POST' || !isLocalHistoryConsentPath(pathname)
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
        reply = readConsentReply(options, request, input, actions);
      } catch {
        status = 404;
        reply = { error: pathname === LOCAL_HISTORY_CONSENT_PREVIEW_PATH
          ? 'local-history-consent-preview-unavailable' : 'local-history-consent-unavailable' };
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
