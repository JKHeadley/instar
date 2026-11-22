// safe-fs-allow: isolated temporary fixture cleanup.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { findRestartRequestRecord, readLastRestartRequest, recordRestartRequest } from '../../../src/core/restartRequestAttribution.js';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/lifeline/n72-restart-ledger.test.ts' }); });
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'n72-ledger-')); dirs.push(d); return d; };
describe('lifeline restart ledger', () => {
  it('kept and unknown never hide the last confirmed server restart beyond an 8-KiB tail', () => {
    const d = temp(); const original = recordRestartRequest(d, { requestedBy: 'server', reason: 'real server restart' }, 'supervisor');
    for (let i = 0; i < 80; i++) recordRestartRequest(d, { requestedBy: 'TelegramLifeline', reason: 'x'.repeat(100) }, 'lifeline', new Date(), { serverOutcome: i % 2 ? 'kept' : 'unknown' });
    expect(readLastRestartRequest(d)).toEqual(original);
  });
  it('a confirmed lifeline server stop is returned, but cannot acknowledge a pending server request', () => {
    const d = temp(); const now = new Date();
    const row = recordRestartRequest(d, { requestedBy: 'TelegramLifeline' }, 'lifeline', now, { serverOutcome: 'stopped' });
    expect(readLastRestartRequest(d)).toEqual(row);
    expect(findRestartRequestRecord(d, { requestedAt: null, sinceMs: now.getTime() - 1 }).record).toBeNull();
  });
});
