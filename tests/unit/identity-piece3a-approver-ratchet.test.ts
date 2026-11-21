/**
 * identity-security piece 3a §7 (mobile-approver-mark §3.1): one reader decides who may approve. No source file but
 * the device registry and the approver module reads a device record's presence key or checks a presence signature
 * directly; everything else goes through approverPresenceKey / verifyApproverPresence.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../../src');
const ALLOWED = new Set(['core/MobileDeviceKeys.ts', 'server/mobileApprover.ts', 'server/mobileConsoleTicket.ts#definition']);
// A device record's presence key: `devices.get(x)?.presenceKey`, or a record variable's `.presenceKey`.
const RECORD_READ = /(?:devices\.get\([^)]*\)\??|\b(?:d|dev|device|local|rec|row|record|existing|current)\??)\.presenceKey\b/;
const DIRECT_VERIFY = /\bverifyPresenceSignature\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('the approver ratchet', () => {
  it('no file but the registry and the approver module reads presence keys or verifies presence signatures', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (ALLOWED.has(rel)) continue;
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        if (/^\s*\*/.test(code)) return; // doc comments
        if (rel === 'server/mobileConsoleTicket.ts' && /export function verifyPresenceSignature\(/.test(code)) return;
        if (RECORD_READ.test(code) || DIRECT_VERIFY.test(code)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('a file that checks a P-256 signature itself and talks about presence is named here, with its reason', () => {
    // documents/originCheck.ts re-checks a STORED decision row; its key comes from approverPresenceKey through
    // DeviceKeyLookup.localPresenceKey (AgentServer), and the live decision went through verifyApproverPresence.
    // core/ownerRecord.ts verifies owner-record ENTRY signatures by P-256 owner keys (its own message prefix).
    const NAMED = new Set(['documents/originCheck.ts', 'core/MobileDeviceKeys.ts', 'server/mobileConsoleTicket.ts', 'core/ownerRecord.ts']);
    const found: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      const text = fs.readFileSync(file, 'utf8');
      if (/dsaEncoding:\s*'der'/.test(text) && /presence/i.test(text) && !NAMED.has(rel)) found.push(rel);
    }
    expect(found).toEqual([]);
  });

  it('the patterns catch the forms they guard (both sides)', () => {
    expect(RECORD_READ.test('const k = svc.devices.get(id)?.presenceKey;')).toBe(true);
    expect(RECORD_READ.test('if (!d?.presenceKey) return;')).toBe(true);
    expect(RECORD_READ.test('return { presenceKey: approverKey };')).toBe(false);
    expect(DIRECT_VERIFY.test('verifyPresenceSignature(k, m, s)')).toBe(true);
    expect(DIRECT_VERIFY.test('verifyApproverPresence(svc, id, m, s)')).toBe(false);
  });
});
