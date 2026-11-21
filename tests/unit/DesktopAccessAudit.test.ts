import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopAccessAudit } from '../../src/core/DesktopAccessAudit.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('DesktopAccessAudit', () => {
  it('persists only hashed principals and coarse activity, mode 0600', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-audit-'));
    try {
      const audit = new DesktopAccessAudit(dir);
      audit.record({ kind: 'start', grantId: 'grant-secret', machineId: 'machine-1', operatorUid: '7812716706' });
      audit.record({ kind: 'stop', grantId: 'grant-secret', machineId: 'machine-1',
        operatorUid: '7812716706', inputBucket: '1-9' });
      const file = path.join(dir, 'logs', `desktop-access-${new Date().toISOString().slice(0, 10)}.jsonl`);
      const text = fs.readFileSync(file, 'utf8');
      expect(text).not.toContain('7812716706');
      expect(text).not.toContain('grant-secret');
      expect(text).toContain('"inputBucket":"1-9"');
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'DesktopAccessAudit.test.ts cleanup' });
    }
  });

  it('reports a session start only inside the window', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-audit-'));
    try {
      const audit = new DesktopAccessAudit(dir);
      const day = 24 * 60 * 60_000;
      expect(audit.hasStartWithin(30 * day)).toBe(false);
      audit.record({ kind: 'stop', grantId: 'g', machineId: 'm', operatorUid: 'u' });
      expect(audit.hasStartWithin(30 * day)).toBe(false);
      audit.record({ kind: 'start', grantId: 'g', machineId: 'm', operatorUid: 'u' });
      expect(audit.hasStartWithin(30 * day)).toBe(true);
      expect(audit.hasStartWithin(30 * day, Date.now() + 31 * day)).toBe(false);
      const old = new Date(Date.now() - 40 * day).toISOString();
      const other = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-audit-old-'));
      fs.mkdirSync(path.join(other, 'logs'), { recursive: true });
      fs.writeFileSync(path.join(other, 'logs', `desktop-access-${old.slice(0, 10)}.jsonl`),
        JSON.stringify({ at: old, kind: 'start', machineId: 'm' }) + '\n{torn\n');
      // Constructing prunes files past 30 days, so read the stale one through a fresh audit at an earlier "now".
      const stale = Object.create(DesktopAccessAudit.prototype) as DesktopAccessAudit;
      (stale as unknown as { dir: string }).dir = path.join(other, 'logs');
      expect(stale.hasStartWithin(30 * day)).toBe(false);
      expect(stale.hasStartWithin(30 * day, Date.now() - 35 * day)).toBe(true);
      SafeFsExecutor.safeRmSync(other, { recursive: true, force: true, operation: 'DesktopAccessAudit.test.ts cleanup' });
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'DesktopAccessAudit.test.ts cleanup' });
    }
  });
});
