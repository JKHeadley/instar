/** standby-durable-forward-without-token §10 — evidence rides to the holder, recorded once per (sender, id). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import {
  StandbyEvidenceOutbox, HolderEvidenceRecorder, sanitizeForwardContext, FORWARD_CONTEXT_MAX_EVENTS, TOKENLESS_FORWARD_FEATURE_ID, SEEN_ID_RETENTION_MS,
} from '../../../src/messaging/telegram-origin/TokenlessForwardEvidence.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tokenless-forward-evidence:test-cleanup' }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenless-evidence-')); dirs.push(d); return d; };

describe('StandbyEvidenceOutbox', () => {
  it('keeps events until acked, with ids fixed at write time', () => {
    const box = new StandbyEvidenceOutbox(tmp());
    const a = box.add('expired-undelivered');
    const b = box.add('not-sent-while-live');
    expect(box.pending().map(e => e.id)).toEqual([a, b]);
    box.ack([a]);
    expect(box.pending().map(e => e.id)).toEqual([b]);
  });
  it('hands over at most one command worth of events', () => {
    const box = new StandbyEvidenceOutbox(tmp());
    for (let i = 0; i < FORWARD_CONTEXT_MAX_EVENTS + 5; i++) box.add('expired-undelivered');
    expect(box.pending()).toHaveLength(FORWARD_CONTEXT_MAX_EVENTS);
  });
});

describe('sanitizeForwardContext', () => {
  it('ignores anything that is not a token-less context', () => {
    expect(sanitizeForwardContext(undefined)).toBeNull();
    expect(sanitizeForwardContext({ tokenless: false })).toBeNull();
  });
  it('drops malformed events and caps the count', () => {
    const events = [{ id: 'ok-1', kind: 'expired-undelivered', at: 1 }, { id: 'bad kind', kind: 'x', at: 1 }, { id: 'ok-2', kind: 'nope', at: 1 },
      ...Array.from({ length: 80 }, (_, i) => ({ id: `e${i}`, kind: 'not-sent-while-live', at: i }))];
    const ctx = sanitizeForwardContext({ tokenless: true, events })!;
    expect(ctx.events!.length).toBe(FORWARD_CONTEXT_MAX_EVENTS);
    expect(ctx.events![0].id).toBe('ok-1');
  });
});

describe('HolderEvidenceRecorder', () => {
  it('records each event once per sender, acks every seen id, and one fired row per delivered operation', () => {
    const record = vi.fn();
    let now = 1_000;
    const rec = new HolderEvidenceRecorder(tmp(), record, () => now);
    const ctx = { tokenless: true as const, resealed: true, events: [{ id: 'e1', kind: 'expired-undelivered' as const, at: 1 }] };
    expect(rec.observe('m5', ctx, { operationId: 'op-1~r1-abcdef01' })).toEqual(['e1']);
    expect(rec.observe('m5', ctx, { operationId: 'op-1~r1-abcdef01' })).toEqual(['e1']);
    const kinds = record.mock.calls.map(c => [c[0], c[1].kind]);
    expect(kinds).toEqual([[TOKENLESS_FORWARD_FEATURE_ID, 'error'], [TOKENLESS_FORWARD_FEATURE_ID, 'fired']]);
    expect(record.mock.calls[1][1]).toMatchObject({ reason: 'resealed-delivery', context: { resealed: true, originMachineId: 'm5' } });
    // the same id from ANOTHER machine is a different event
    rec.observe('mini', ctx);
    expect(record).toHaveBeenCalledTimes(3);
    // seen ids expire with the window
    now += SEEN_ID_RETENTION_MS + 1;
    rec.observe('m5', ctx);
    expect(record).toHaveBeenCalledTimes(4);
  });
});
