/** standby-durable-forward-without-token §10 — one expiry is one evidence event, however often its report is retried. */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StandbyEvidenceOutbox } from '../../../src/messaging/telegram-origin/TokenlessForwardEvidence.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'test:tokenless-evidence-dedupe:cleanup' }); });

describe('StandbyEvidenceOutbox ids', () => {
  it('a keyed event gets a fixed id and is written once across retries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-evidence-')); dirs.push(dir);
    const box = new StandbyEvidenceOutbox(dir);
    const a = box.add('expired-undelivered', 'op-1');
    const b = box.add('expired-undelivered', 'op-1');
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-zA-Z0-9-]{1,64}$/);
    expect(box.pending()).toHaveLength(1);
    expect(box.add('expired-undelivered', 'op-2')).not.toBe(a);
    expect(box.pending()).toHaveLength(2);
  });
  it('an acked keyed event re-added keeps its id, so the holder (which dedupes by id) still counts it once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-evidence-')); dirs.push(dir);
    const box = new StandbyEvidenceOutbox(dir);
    const id = box.add('expired-undelivered', 'op-1');
    box.ack([id]);
    expect(box.add('expired-undelivered', 'op-1')).toBe(id);
  });
  it('unkeyed events stay distinct', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-evidence-')); dirs.push(dir);
    const box = new StandbyEvidenceOutbox(dir);
    expect(box.add('not-sent-while-live')).not.toBe(box.add('not-sent-while-live'));
  });
});
