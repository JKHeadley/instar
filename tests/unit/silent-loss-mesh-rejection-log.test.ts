/**
 * silent-loss-refusal-conservation §2.B — the machine-local mesh-rejection trace
 * log. Fields EXACTLY {ts, reason, session, messageId, senderUid}, never payload;
 * 0600; bounded via maybeRotateJsonl on the append path (re-chmod'd after rotation).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import os from 'node:os';
import path from 'node:path';
import { appendMeshRejection, meshRejectionsLogPath } from '../../src/core/meshRejectionLog.js';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'slrc-mrl-'));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'test-cleanup' }); } catch { /* ok */ } });

describe('§2.B mesh-rejection log', () => {
  it('appends exactly {ts, reason, session, messageId, senderUid} — never payload', () => {
    const dir = tmp();
    appendMeshRejection(dir, { reason: 'sender-rejected', session: '42', messageId: 'm1', senderUid: 7 });
    const raw = fs.readFileSync(meshRejectionsLogPath(dir), 'utf-8').trim();
    const row = JSON.parse(raw);
    expect(Object.keys(row).sort()).toEqual(['messageId', 'reason', 'senderUid', 'session', 'ts']);
    expect(row).toMatchObject({ reason: 'sender-rejected', session: '42', messageId: 'm1', senderUid: 7 });
    expect(row.ts).toBeTruthy();
  });

  it('omits senderUid when absent (metadata-only, never a fabricated 0)', () => {
    const dir = tmp();
    appendMeshRejection(dir, { reason: 'sender-rejected', session: 's', messageId: 'm2' });
    const row = JSON.parse(fs.readFileSync(meshRejectionsLogPath(dir), 'utf-8').trim());
    expect(row).not.toHaveProperty('senderUid');
  });

  it('the log file is created 0600', function () {
    if (process.platform === 'win32') return; // mode semantics differ on Windows
    const dir = tmp();
    appendMeshRejection(dir, { reason: 'sender-rejected', session: 's', messageId: 'm' });
    const mode = fs.statSync(meshRejectionsLogPath(dir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('never throws on an unwritable directory (a trace fault never changes the NACK)', () => {
    // A path whose parent cannot be created (a file where a dir is expected).
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'logs'), 'not a dir'); // logs is a FILE
    expect(() => appendMeshRejection(dir, { reason: 'sender-rejected', session: 's', messageId: 'm' })).not.toThrow();
  });

  it('multiple appends accumulate as JSONL lines', () => {
    const dir = tmp();
    appendMeshRejection(dir, { reason: 'sender-rejected', session: 'a', messageId: '1' });
    appendMeshRejection(dir, { reason: 'sender-rejected', session: 'b', messageId: '2' });
    const lines = fs.readFileSync(meshRejectionsLogPath(dir), 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
  });
});
