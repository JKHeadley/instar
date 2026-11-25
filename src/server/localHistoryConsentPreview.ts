// E2E-PAIRING: EXEMPT — the production server leaves the consent preview service unset.
import { isCardId } from '../core/WorkCardStore.js';
import type { WorkBoardService } from '../core/WorkBoardService.js';
import { LOCAL_HISTORY_PLAINTEXT_BYTES } from '../import/LocalHistoryChannel.js';
import type { LocalHistoryChannelExchange, LocalHistoryChannelRegistry } from '../import/LocalHistoryChannelRegistry.js';
import type { LocalHistoryUploadStaging } from '../import/LocalHistoryUploadStaging.js';
import { readLocalHistoryConsentCard, readLocalHistoryConsentSources } from './localHistoryConsentSlip.js';
import { LOCAL_HISTORY_CONSENT_PREVIEW_PATH, type SignedLocalHistoryIntakeService } from './signedLocalHistoryIntake.js';

const channelQuery = /^\?channelId=([0-9a-f-]{36})&sequence=([1-9][0-9]{0,19})$/;
const operationIdPattern = /^[a-f0-9]{32}$/;

/** Construct only with current server-side capture ownership and the target's
 * real channel, exchange lease, staging and Work Board. The production
 * intake deliberately supplies no instance. */
export function createLocalHistoryConsentPreview(options: {
  withExchange: SignedLocalHistoryIntakeService['withExchange'];
  channels: Pick<LocalHistoryChannelRegistry, 'open'>;
  staging: Pick<LocalHistoryUploadStaging, 'readOwnerConsentPreview' | 'readOwnerConsentCard'>;
  board: Pick<WorkBoardService, 'view'>;
  resolveOwnedCapture: Parameters<typeof readLocalHistoryConsentSources>[1];
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
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2
          || typeof input.operationId !== 'string' || !operationIdPattern.test(input.operationId) || !isCardId(input.cardId)) {
          throw new Error('local-history-consent-preview-request');
        }
        const preview = options.staging.readOwnerConsentPreview(device, input.operationId);
        const binding = options.staging.readOwnerConsentCard(device, input.operationId);
        if (preview.ownerUserId !== device.ownerUserId || !binding || binding.cardId !== input.cardId) {
          throw new Error('local-history-consent-preview-binding');
        }
        const card = readLocalHistoryConsentCard(options.board, binding, preview);
        const sources = readLocalHistoryConsentSources(preview, options.resolveOwnedCapture);
        reply = {
          ...card,
          previewId: preview.previewId,
          previewDigest: preview.previewDigest,
          expiresAt: preview.expiresAt,
          destination: preview.destination,
          files: preview.artifacts.map(({ fileId, kind, projectPath, messages, newMessages, redactions }, index) => ({
            fileId, kind, projectPath, messages, newMessages, redactions,
            machineId: sources[index].machineId, artifactDigest: sources[index].artifactDigest,
          })),
        };
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
