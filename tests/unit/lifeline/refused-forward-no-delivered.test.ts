/**
 * A message the server's inbound gate refused (Chief of Staff owner-only rule) is never
 * acknowledged "✓ Delivered" by the lifeline, nor counted in the delayed-delivery notice.
 * Echo Bugs topic 10000002533 — the operator's refused messages were reported as delivered.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readForwardRefused } from '../../../src/lifeline/TelegramLifeline.js';

const src = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'src', 'lifeline', 'TelegramLifeline.ts'), 'utf-8');

describe('readForwardRefused', () => {
  it('reads refused:true from the accepted-forward body', async () => {
    expect(await readForwardRefused({ json: async () => ({ ok: true, forwarded: true, refused: true }) })).toBe(true);
  });
  it('an older server (no field), a non-true value, an unreadable or missing body all read as not refused', async () => {
    expect(await readForwardRefused({ json: async () => ({ ok: true, forwarded: true }) })).toBe(false);
    expect(await readForwardRefused({ json: async () => ({ refused: 'yes' }) })).toBe(false);
    expect(await readForwardRefused({ json: async () => { throw new Error('bad json'); } })).toBe(false);
    expect(await readForwardRefused({ json: async () => null })).toBe(false);
    expect(await readForwardRefused({})).toBe(false);
  });
});

describe('every lifeline "✓ Delivered" asks whether the server refused the message', () => {
  it('text, photo and document acks are all conditional on !fwd.refused', () => {
    const acks = src.match(/sendFixedNotice\(topicId, '✓ Delivered'\)/g) ?? [];
    const guarded = src.match(/if \(!fwd\.refused\) await this\.sendFixedNotice\(topicId, '✓ Delivered'\)/g) ?? [];
    expect(acks.length).toBe(3);
    expect(guarded.length).toBe(3);
  });
  it('both accepted-forward branches record the refusal', () => {
    expect(src).toContain('if (ack) ack.refused = await readForwardRefused(response);');
    expect(src).toContain('if (r2.ok) { if (ack) ack.refused = await readForwardRefused(r2); return true; }');
  });
  it('a refused replay is handled (never re-queued) but not counted as delivered', () => {
    const loop = src.slice(src.indexOf('private async replayQueue('), src.indexOf('private async replayQueue(') + 8000);
    expect(loop).toContain('}, replayAck);');
    const mark = loop.indexOf("this.queue.markDelivered(msg.id); // remember id so a redelivery can't re-queue it");
    const guard = loop.indexOf('if (!replayAck.refused) {');
    const count = loop.indexOf('replayed++;');
    expect(mark).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(mark);
    expect(count).toBeGreaterThan(guard);
  });
});
