/**
 * The `/internal/telegram-forward` side of media by attachment id (native-conversation-base §3c,
 * producer table). Two callers reach that route with files:
 *
 *  - the lifeline, which downloaded the file on this machine. A current lifeline sends `media[]`
 *    with `localPath`; one still on an older build sends only a tag at position 0 of the text. Either
 *    way a local path is accepted only from a lifeline-proven forward, and only after a realpath check
 *    inside the download directories. Everything after the leading tag is person text.
 *  - the app's file into a Telegram topic (device-authenticated): `media[]` by `attachmentId`, the
 *    attachment already in the media store. Never a path.
 *
 * The result is the text that travels (one path-free sentence per file, then the person's text,
 * escaped) plus the in-process field.
 */
import fs from 'node:fs';
import path from 'node:path';
import { displayName } from '../core/appMediaTypes.js';
import {
  composeInboundPayload, escapeTypedPathTags, MAX_INBOUND_MEDIA, parseInboundMediaField, takeLeadingLegacyTag, toWireMedia,
  type InboundMediaLocal,
} from '../core/inboundMedia.js';

export const DOWNLOAD_FAILED_PHOTO = '[The user sent a photo, but it could not be downloaded.]';
export const DOWNLOAD_FAILED_FILE = '[The user sent a file, but it could not be downloaded.]';

/** The directories a Telegram download lands in, on the poller or the lifeline. */
export function telegramDownloadDirs(stateDir: string): string[] {
  return [path.join(stateDir, 'telegram-images'), path.join(stateDir, 'telegram-documents')];
}

/** A realpath inside one of `roots`, naming a regular file; else null. */
export function confinedDownload(p: unknown, roots: readonly string[]): string | null {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return null;
  try {
    const real = fs.realpathSync(p);
    if (!fs.statSync(real).isFile()) return null;
    const realRoots = roots.map((r) => { try { return fs.realpathSync(r); } catch { return path.resolve(r); } }); // @silent-fallback-ok — a missing root matches nothing
    return realRoots.some((r) => real.startsWith(`${r}${path.sep}`)) ? real : null;
  } catch { return null; } // @silent-fallback-ok — a missing file is not a local download
}

export interface NormalizedForward {
  /** The text that travels and is logged for routing: sentences, then escaped person text. */
  text: string;
  /** The person's own text, escaped (for the history form). */
  personText: string;
  /** In-process: may carry a confined `localPath`. Use `toWireMedia` before it leaves the process. */
  media: InboundMediaLocal[];
  /** True when the sender was told nothing about files (no field, no tag): an older sender's plain text. */
  legacy: boolean;
}

export function normalizeForwardedInbound(input: {
  text: string;
  bodyMedia: unknown;
  messageId: unknown;
  /** A lifeline-proven forward from this machine (never the app path, never an unverified caller). */
  acceptLocalPaths: boolean;
  downloadDirs: readonly string[];
}): NormalizedForward {
  let person = typeof input.text === 'string' ? input.text : '';
  const media: InboundMediaLocal[] = [];
  const prefix: string[] = [];
  const msgId = Number(input.messageId);
  const platformMessageId = Number.isSafeInteger(msgId) && msgId > 0 ? String(msgId) : undefined;
  if (Array.isArray(input.bodyMedia)) {
    for (const raw of (input.bodyMedia as unknown[]).slice(0, MAX_INBOUND_MEDIA)) {
      const ref: InboundMediaLocal | undefined = parseInboundMediaField([raw])?.[0];
      if (!ref) continue;
      if (input.acceptLocalPaths && raw && typeof raw === 'object') {
        const real = confinedDownload((raw as Record<string, unknown>).localPath, input.downloadDirs);
        if (real) ref.localPath = real;
      }
      media.push(ref);
    }
    // A current lifeline keeps its own tag at position 0 for an older server; it is never person text.
    if (input.acceptLocalPaths && media.length > 0) {
      const lead = takeLeadingLegacyTag(person);
      if (lead) person = lead.rest;
    }
  } else if (input.acceptLocalPaths) {
    // An older lifeline: only a tag at position 0 is read; everything after it is person text.
    const lead = takeLeadingLegacyTag(person);
    if (lead) {
      person = lead.rest;
      if (lead.path === 'download-failed') {
        prefix.push(lead.kind === 'photo' ? DOWNLOAD_FAILED_PHOTO : DOWNLOAD_FAILED_FILE);
      } else if (platformMessageId) {
        const real = confinedDownload(lead.path, input.downloadDirs);
        media.push({
          kind: lead.kind, platformMessageId,
          filename: displayName(path.basename(lead.path).replace(/^\d{10,}-/, '')),
          ...(real ? { localPath: real } : {}),
        });
      }
    }
  }
  const personText = escapeTypedPathTags(person);
  const body = composeInboundPayload(personText, toWireMedia(media));
  return {
    text: [...prefix, ...(body ? [body] : [])].join('\n'),
    personText: [...prefix, ...(personText ? [personText] : [])].join('\n'),
    media,
    legacy: !Array.isArray(input.bodyMedia),
  };
}
