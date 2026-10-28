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
});
