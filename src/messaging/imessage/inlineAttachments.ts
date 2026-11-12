/**
 * iMessage text with its attachments inlined. iMessage stores the attachment placeholder character
 * (\uFFFC) in the text where the photo sits, but not the path. Each placeholder becomes an explicit
 * `[image:/path]` or `[file:/path]` tag (the Telegram pattern) so the session can read the file;
 * with no placeholders the tags are appended. Attachments are hardlinked into
 * .instar/imessage/attachments/ by the user-context sync script.
 *
 * native-conversation-base §3c / FD-12: every path tag the person typed is made inert FIRST, so the
 * only live tags are the ones added here from the adapter's own attachment list.
 */
import { escapeTypedPathTags } from '../../core/inboundMedia.js';
// CONTRACT-EVIDENCE: EXEMPT — a pure text helper extracted from server.ts; it reads the attachment list
// the iMessage adapter already produced and calls no iMessage API.

export interface IMessageAttachmentRef { filename?: string; mimeType?: string; path?: string }

export function inlineIMessageAttachments(content: string, attachments: ReadonlyArray<IMessageAttachmentRef>): string {
  let text = escapeTypedPathTags(content ?? '');
  if (attachments.length === 0) return text;
  const tags = attachments.map((a) => {
    if (!a.path) return '[attachment path unavailable]';
    const isImage = (a.mimeType || '').startsWith('image/');
    return `[${isImage ? 'image' : 'file'}:${a.path}]`;
  });
  if (text.includes('\uFFFC')) {
    let i = 0;
    text = text.replace(/\uFFFC/g, () => tags[i++] ?? '[image:missing]');
  } else {
    text = (text ? `${text} ` : '') + tags.join(' ');
  }
  return text;
}
