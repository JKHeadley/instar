import {
  exactAppMessageFrame, type AppConversationStore, type AppMessageIndexKey,
  type MediaMessageEvent, type StoredAppEvent,
} from './AppConversationStore.js';
import { isAppAttachmentBoundary } from './AppAttachmentCursor.js';
import { canonicalConversationKey } from './appConversationText.js';
import type { AppAttachment, MediaKind } from './appMediaTypes.js';

const MAX_ROWS = 50;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_RESULTS = 15;
const MAX_RESPONSE_BYTES = 128 * 1024;

type BrowseStore = Pick<AppConversationStore, 'attachmentIndexWindow' | 'readExactAttachmentEvent' | 'mediaRef'>;
type AttachmentDescriptor = Pick<AppAttachment, 'attachmentId' | 'index' | 'kind' | 'filename' | 'size' | 'mediaType'>;

interface AttachmentRow {
  eventId: string;
  messageId: string;
  at: string;
  attachments: Array<AttachmentDescriptor & { openToken?: string }>;
}

export interface AppAttachmentPage {
  v: 1;
  kind: MediaKind;
  scope: 'local';
  coverage: 'local' | 'incomplete';
  rows: AttachmentRow[];
  nextCursor: string | null;
  replicaBinding?: string;
}

export class AppAttachmentPageChanged extends Error {}

interface Options {
  store: BrowseStore;
  conversationKey: string;
  kind: MediaKind;
  before: AppMessageIndexKey | null;
  signal: AbortSignal;
  canRead: (event: StoredAppEvent) => boolean;
  sealCursor: (key: AppMessageIndexKey) => string;
  indexHasGap?: boolean;
  openBinding?: { replica: string; seal: (event: MediaMessageEvent, attachment: AppAttachment) => string };
}

function project(event: MediaMessageEvent, options: Options, canonicalKey: string) {
  const attachments: AttachmentDescriptor[] = [];
  let incomplete = false;
  for (const item of event.attachments) {
    if (item.kind !== options.kind) continue;
    const ref = options.store.mediaRef(item.attachmentId);
    if (!ref || ref.canonicalKey !== canonicalKey || ref.messageId !== event.messageId
      || ref.attachmentId !== item.attachmentId || ref.idx !== item.index
      || ref.sha256 !== item.sha256 || ref.size !== item.size) {
      incomplete = true;
      continue;
    }
    if (ref.purged || ref.tombstoned) continue;
    const { attachmentId, index, kind, filename, size, mediaType } = item;
    attachments.push({ attachmentId, index, kind, filename, size, mediaType });
  }
  return { attachments, incomplete };
}

/**
 * Project one bounded page for an already admitted caller. The caller owns slot lifetime,
 * signed conversation admission and the final grant check before publishing this result.
 */
export async function browseAppAttachments(options: Options): Promise<AppAttachmentPage> {
  const { store, conversationKey, kind, before, signal } = options;
  signal.throwIfAborted();
  const canonicalKey = canonicalConversationKey(conversationKey);
  const candidates = store.attachmentIndexWindow(canonicalKey, before);
  const included: Array<StoredAppEvent & MediaMessageEvent> = [];
  let readBytes = 0;
  const projectedMatches: AttachmentDescriptor[][] = [];
  let page: AppAttachmentPage = { v: 1, kind, replicaBinding: options.openBinding?.replica, scope: 'local', coverage: options.indexHasGap ? 'incomplete' : 'local', rows: [], nextCursor: null };

  for (let i = 0; i < Math.min(MAX_ROWS, candidates.length) && page.rows.length < MAX_RESULTS; i++) {
    signal.throwIfAborted();
    const candidate = candidates[i];
    if (!isAppAttachmentBoundary(candidate)) throw new Error('Unrepresentable attachment browse boundary');
    const bytes = exactAppMessageFrame(candidate)?.bytes ?? 0;
    if (readBytes + bytes > MAX_READ_BYTES) break;
    readBytes += bytes;
    const event = bytes ? await store.readExactAttachmentEvent(canonicalKey, candidate, signal) : null;
    signal.throwIfAborted();

    let coverage = event ? page.coverage : 'incomplete';
    let row: AttachmentRow | undefined;
    let descriptors: AttachmentDescriptor[] | undefined;
    if (event?.kind === 'media-message' && options.canRead(event)) {
      const projection = project(event, options, canonicalKey);
      if (projection.incomplete) coverage = 'incomplete';
      if (projection.attachments.length) {
        descriptors = projection.attachments;
        const binding = options.openBinding;
        const attachments = binding ? descriptors.map(descriptor => ({
          ...descriptor,
          openToken: binding.seal(event, event.attachments[descriptor.index]),
        })) : descriptors;
        row = { at: event.at, eventId: event.eventId, messageId: event.messageId, attachments };
      }
    }
    const nextPage: AppAttachmentPage = {
      ...page, coverage, rows: row ? [...page.rows, row] : page.rows,
      nextCursor: i + 1 < candidates.length
        ? options.sealCursor({ at: candidate.at, eventId: candidate.eventId }) : null,
    };
    if (Buffer.byteLength(JSON.stringify(nextPage)) > MAX_RESPONSE_BYTES) {
      if (i === 0) throw new Error('Attachment browse row exceeds page ceiling');
      break;
    }
    page = nextPage;
    if (descriptors && event?.kind === 'media-message') {
      included.push(event);
      projectedMatches.push(descriptors);
    }
  }

  // An earlier candidate may have changed while awaiting a later descriptor.
  // If its evidence changed, retry the whole page rather than advancing past it.
  for (const [i, event] of included.entries()) {
    if (!options.canRead(event)
      || JSON.stringify(project(event, options, canonicalKey).attachments) !== JSON.stringify(projectedMatches[i])) {
      throw new AppAttachmentPageChanged('Attachment browse evidence changed');
    }
  }
  return page;
}
