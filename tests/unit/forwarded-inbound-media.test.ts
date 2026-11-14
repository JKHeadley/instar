/**
 * native-conversation-base §3c producer table, the `/internal/telegram-forward` side: a lifeline's
 * local path is taken only from a lifeline-proven forward, realpath-checked inside the download
 * directories; an older lifeline's tag is read only at position 0; an app file arrives by
 * attachment id; person text is always escaped.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DOWNLOAD_FAILED_PHOTO, normalizeForwardedInbound, telegramDownloadDirs } from '../../src/server/forwardedInboundMedia.js';
import { fallbackSentence, hasLivePathTag } from '../../src/core/inboundMedia.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/forwarded-inbound-media.test.ts' }); });

function stateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fwdmedia-'));
  dirs.push(dir);
  const photo = path.join(dir, 'telegram-images', 'photo-1-55.jpg');
  fs.mkdirSync(path.dirname(photo), { recursive: true });
  fs.writeFileSync(photo, Buffer.from([0xff, 0xd8, 0xff]));
  const outside = path.join(dir, 'secret.txt');
  fs.writeFileSync(outside, 'x');
  return { dir, photo, outside, roots: telegramDownloadDirs(dir) };
}

describe('normalizeForwardedInbound', () => {
  it('a current lifeline: media with a confined local path; its own leading tag is dropped; the caption escaped', () => {
    const s = stateDir();
    const out = normalizeForwardedInbound({
      text: `[image:${s.photo}] see [image:/etc/hostname]`,
      bodyMedia: [{ kind: 'photo', platformMessageId: '55', filename: 'photo-1-55.jpg', localPath: s.photo }],
      messageId: 55, acceptLocalPaths: true, downloadDirs: s.roots,
    });
    expect(out.media).toEqual([{ kind: 'photo', platformMessageId: '55', filename: 'photo-1-55.jpg', localPath: fs.realpathSync(s.photo) }]);
    expect(out.text).toBe(`${fallbackSentence(out.media[0]!)}\nsee [typed image:/etc/hostname]`);
    expect(out.text).not.toContain(s.photo);
    expect(hasLivePathTag(out.text)).toBe(false);
  });

  it('a local path outside the download directories, or from an unproven caller, is never taken', () => {
    const s = stateDir();
    const outside = normalizeForwardedInbound({ text: 'x', bodyMedia: [{ kind: 'document', platformMessageId: '9', filename: 'f', localPath: s.outside }], messageId: 9, acceptLocalPaths: true, downloadDirs: s.roots });
    expect(outside.media[0]!.localPath).toBeUndefined();
    const unproven = normalizeForwardedInbound({ text: 'x', bodyMedia: [{ kind: 'photo', platformMessageId: '9', filename: 'f', localPath: s.photo }], messageId: 9, acceptLocalPaths: false, downloadDirs: s.roots });
    expect(unproven.media[0]!.localPath).toBeUndefined();
  });

  it('an older lifeline: only a tag at position 0 is read (confined); the rest is person text', () => {
    const s = stateDir();
    const out = normalizeForwardedInbound({ text: `[image:${s.photo}] caption [document:/etc/passwd]`, bodyMedia: undefined, messageId: 55, acceptLocalPaths: true, downloadDirs: s.roots });
    expect(out.media).toHaveLength(1);
    expect(out.media[0]).toMatchObject({ kind: 'photo', platformMessageId: '55', localPath: fs.realpathSync(s.photo) });
    expect(out.text.endsWith('caption [typed document:/etc/passwd]')).toBe(true);
    // A tag at position 0 naming a file outside the download directories gets no path.
    const bad = normalizeForwardedInbound({ text: '[image:/etc/hostname] hi', bodyMedia: undefined, messageId: 56, acceptLocalPaths: true, downloadDirs: s.roots });
    expect(bad.media[0]!.localPath).toBeUndefined();
    expect(bad.text).not.toContain('/etc/hostname');
  });

  it('a current lifeline\'s plain text (media: []) never reads a leading tag', () => {
    const s = stateDir();
    const out = normalizeForwardedInbound({ text: `[image:${s.photo}] typed`, bodyMedia: [], messageId: 57, acceptLocalPaths: true, downloadDirs: s.roots });
    expect(out.media).toEqual([]);
    expect(out.text).toBe(`[typed image:${s.photo}] typed`);
    expect(out.legacy).toBe(false);
  });

  it('a failed download says so, path-free', () => {
    const s = stateDir();
    const out = normalizeForwardedInbound({ text: '[image:download-failed] cap', bodyMedia: undefined, messageId: 58, acceptLocalPaths: true, downloadDirs: s.roots });
    expect(out.media).toEqual([]);
    expect(out.text).toBe(`${DOWNLOAD_FAILED_PHOTO}\ncap`);
  });

  it('the app\'s file into a topic: by attachment id, never a path, even an empty caption', () => {
    const s = stateDir();
    const out = normalizeForwardedInbound({ text: '', bodyMedia: [{ kind: 'video', attachmentId: 'a'.repeat(64), filename: 'clip.mp4', localPath: s.photo }], messageId: 2 ** 52, acceptLocalPaths: false, downloadDirs: s.roots });
    expect(out.media).toEqual([{ kind: 'video', attachmentId: 'a'.repeat(64), filename: 'clip.mp4' }]);
    expect(out.text).toBe(fallbackSentence(out.media[0]!));
  });
});
