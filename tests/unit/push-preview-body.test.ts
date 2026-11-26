import { describe, it, expect } from 'vitest';
import { pushPreviewBody, PUSH_PREVIEW_CHARS, type AppAttachment } from '../../src/core/appMediaTypes.js';
import { buildPayload } from '../../src/core/MobilePush.js';

const att = (kind: AppAttachment['kind'], filename = 'x.bin'): AppAttachment => ({
  attachmentId: 'a', index: 0, sha256: 'f'.repeat(64), size: 1, declaredKind: kind, kind, mediaType: 'application/octet-stream', declaredType: 'application/octet-stream', filename,
});

describe('pushPreviewBody (chat-media §4.11)', () => {
  it('text replies: the first 100 characters, whitespace folded', () => {
    expect(pushPreviewBody([], 'Short\n\nanswer')).toBe('Short answer');
    const long = 'x'.repeat(250);
    const b = pushPreviewBody([], long);
    expect(b.length).toBe(PUSH_PREVIEW_CHARS);
    expect(b.endsWith('…')).toBe(true);
    expect(pushPreviewBody([], '   ')).toBe('New reply');
  });
  it('files: a fixed phrase, then the caption', () => {
    expect(pushPreviewBody([att('photo')], '')).toBe('sent a photo');
    expect(pushPreviewBody([att('video')], 'the clip')).toBe('sent a video: the clip');
    expect(pushPreviewBody([att('voice')], '')).toBe('sent a voice message');
    expect(pushPreviewBody([att('file', 'report.pdf')], '')).toBe('sent a file: report.pdf');
    expect(pushPreviewBody([att('photo'), att('file')], 'both')).toBe('sent 2 files: both');
  });
});

describe('reply push payload', () => {
  it('carries the message id and machine so the phone can fetch the preview, never the text', () => {
    const p = buildPayload('Echo', 'echo', 'd1', { kind: 'reply', conversationKey: 'k', messageId: 'am-abc', machine: 'm1', count: 1 });
    expect(p.instar).toMatchObject({ conversationKey: 'k', messageId: 'am-abc', machine: 'm1' });
    expect((p.aps as { alert: { body: string } }).alert.body).toBe('New reply');
  });
  it('drops a message id that is not a plain id', () => {
    const p = buildPayload('Echo', 'echo', 'd1', { kind: 'reply', conversationKey: 'k', messageId: 'A-b', count: 1 });
    expect((p.instar as Record<string, unknown>).messageId).toBeUndefined();
  });
});
