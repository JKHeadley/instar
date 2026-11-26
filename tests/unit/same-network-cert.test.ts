/** Identity A4 point 11: the agent's own certificate writer (src/core/SameNetworkCert.ts). */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOrCreateSameNetworkIdentity, newSameNetworkKey, spkiHashOf, writeSelfSignedCert, SAME_NETWORK_KEY_FILE, SAME_NETWORK_CERT_FILE } from '../../src/core/SameNetworkCert.js';
import { KEY_MATERIAL_PATHS, KEY_MATERIAL_FILES } from '../../src/core/keyMaterialPaths.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/same-network-cert.test.ts' }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'sn-cert-')); dirs.push(d); return d; };

describe('same-network certificate', () => {
  it('writes a well-formed self-signed P-256 certificate that Node parses and verifies', () => {
    const key = newSameNetworkKey();
    const pem = writeSelfSignedCert(key, 'wintest-desktop.local', ['192.168.1.20']);
    const x = new crypto.X509Certificate(pem);
    expect(x.verify(x.publicKey)).toBe(true);
    expect(x.subject).toBe('CN=wintest-desktop.local');
    expect(x.subjectAltName).toContain('DNS:wintest-desktop.local');
    expect(x.subjectAltName).toContain('IP Address:192.168.1.20');
    expect(x.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    expect(Date.parse(x.validTo)).toBeGreaterThan(Date.now() + 10 * 365 * 86_400_000);
    expect(spkiHashOf(x.publicKey)).toBe(spkiHashOf(key));
  });

  it('keeps the key (and so the pinned hash) across loads, and rewrites only the certificate when the name changes', () => {
    const dir = tmp();
    const a = loadOrCreateSameNetworkIdentity(dir, 'a-one.local');
    expect(a.created).toBe(true);
    expect((fs.statSync(path.join(dir, SAME_NETWORK_KEY_FILE)).mode & 0o777)).toBe(0o600);
    const b = loadOrCreateSameNetworkIdentity(dir, 'a-one.local');
    expect(b.created).toBe(false);
    expect(b.spkiHash).toBe(a.spkiHash);
    expect(b.certPem).toBe(a.certPem);
    const c = loadOrCreateSameNetworkIdentity(dir, 'a-two.local');
    expect(c.spkiHash).toBe(a.spkiHash);
    expect(c.certPem).not.toBe(a.certPem);
    expect(new crypto.X509Certificate(fs.readFileSync(path.join(dir, SAME_NETWORK_CERT_FILE), 'utf8')).subjectAltName).toContain('DNS:a-two.local');
  });

  it('an unreadable key is replaced, and the caller is told (a new key means pairing again)', () => {
    const dir = tmp();
    const a = loadOrCreateSameNetworkIdentity(dir, 'x.local');
    fs.writeFileSync(path.join(dir, SAME_NETWORK_KEY_FILE), 'not a key');
    const b = loadOrCreateSameNetworkIdentity(dir, 'x.local');
    expect(b.created).toBe(true);
    expect(b.spkiHash).not.toBe(a.spkiHash);
  });

  it('the private key and the listener state are machine key material: never served, backed up or synced', () => {
    expect(KEY_MATERIAL_PATHS).toContain('state/same-network-tls.key');
    expect(KEY_MATERIAL_PATHS).toContain('state/same-network.json');
    expect(KEY_MATERIAL_FILES).toContain('state/same-network-tls.key');
  });
});
