/** Disk Steward post text and envelopes (spec docs/specs/disk-steward.md §3.5). */
import { describe, it, expect } from 'vitest';
import { renderPost, cleanName, makeDiskStewardSender } from '../../src/monitoring/DiskStewardPoster.js';
import { notificationContext, QuietRecordedError } from '../../src/messaging/NotificationSelectivityGate.js';
import type { DuePost } from '../../src/monitoring/DiskSteward.js';

const GiB = 1024 ** 3;
const NOW = 1_800_000_000_000;
const base: DuePost = {
  postId: 'p', machineId: 'm_studio', machineName: 'Mac Studio', kind: 'alert', level: 'warn', critical: false,
  episodeStart: NOW, stage: 0, createdAt: NOW, free: 82 * GiB, total: 926 * GiB, change24h: -14 * GiB, daysToFloor: 2.6,
  cleared: [{ category: 'npm-cache', bytes: 9 * GiB }], cacheReclaimableBytes: 4 * GiB,
  worktrees: { reclaimable: 1, reclaimableBytes: 0.4 * GiB, kept: { 'in-use': 171, 'uncommitted-changes': 120 } },
  reaperArmed: false, biggest: [{ name: '.instar/lanes', bytes: 151 * GiB }, { name: '.worktrees-deps', bytes: 92 * GiB }], sizesAt: NOW - 2 * 3_600_000,
  pruneEnabled: true, cleanupNotHelping: false, failures: 0, nextAttemptAt: NOW,
};

describe('renderPost', () => {
  it('names the machine, the numbers, what was cleared, and a next step on every line', () => {
    const text = renderPost(base, NOW);
    expect(text).toContain('Mac Studio: 82 GiB free of 926 GiB (9%), down 14 GiB in the last day.');
    expect(text).toContain('reaches the danger line (5%) in about 3 days');
    expect(text).toContain('I cleared 9.0 GiB just now: npm cache 9.0 GiB.');
    expect(text).toContain('reply "clear disk on Mac Studio"');
    expect(text).toContain('switched off on Mac Studio, and I can turn it on if you ask');
    expect(text).toContain('`.instar/lanes` 151 GiB');
    expect(text).toContain('sized 2 h ago');
  });
  it('offers the manual clear only when there is something to clear', () => {
    expect(renderPost({ ...base, cacheReclaimableBytes: 0 }, NOW)).not.toContain('clear disk on');
  });
  it('drops machine-supplied names it cannot trust', () => {
    expect(cleanName('a/b-c_d.e')).toBe('a/b-c_d.e');
    expect(cleanName('[click](http://x)')).toBeNull();
    expect(cleanName('../../etc')).toBeNull();
    expect(cleanName('x'.repeat(61))).toBeNull();
    const text = renderPost({ ...base, biggest: [{ name: 'evil\nline', bytes: GiB }] }, NOW);
    expect(text).not.toContain('evil');
  });
  it('a recovery is one short line', () => {
    expect(renderPost({ ...base, kind: 'recovery', free: 200 * GiB }, NOW)).toBe('Mac Studio: back to normal, 200 GiB free of 926 GiB (22%).');
  });
});

describe('makeDiskStewardSender', () => {
  it('uses the disk-steward category for a warn, and the significant floor envelope when critical', async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const send = makeDiskStewardSender({ resolveTopicId: async () => 140571, sendToTopic: async () => { seen.push(notificationContext.getStore() as never); return {}; }, log: () => {} });
    expect(await send(base)).toBe('posted');
    expect(await send({ ...base, critical: true, stage: 2 })).toBe('posted');
    expect(seen[0]).toMatchObject({ category: 'disk-steward' });
    expect(seen[1]).toMatchObject({ category: 'attention-item', significantClass: 'agent-cannot-operate', sourceContext: `disk-steward:m_studio:${NOW}:2` });
  });
  it('a quiet record counts as posted; no topic or a thrown send is a failure', async () => {
    const quiet = makeDiskStewardSender({ resolveTopicId: async () => 1, sendToTopic: async () => { throw new QuietRecordedError({ delivered: false, recorded: true, quietId: 'q1' }); }, log: () => {} });
    expect(await quiet(base)).toBe('posted');
    const noTopic = makeDiskStewardSender({ resolveTopicId: async () => null, sendToTopic: async () => ({}), log: () => {} });
    expect(await noTopic(base)).toBe('failed');
    const broken = makeDiskStewardSender({ resolveTopicId: async () => 1, sendToTopic: async () => { throw new Error('down'); }, log: () => {} });
    await expect(broken(base)).rejects.toThrow('down');
  });
});
