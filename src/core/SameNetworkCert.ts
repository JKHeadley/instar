/**
 * The agent's own TLS certificate for the same-network listener (identity A4, point 11;
 * docs/specs/identity-security-piece3e-same-network-first-phone.md §3.2).
 *
 * A small self-contained X.509 writer: an ECDSA P-256 key made with node:crypto and a self-signed
 * certificate written as DER here. No outside service and no new package. The phone never trusts
 * the certificate's signature or names: it pins the hash of the certificate's public key, read from
 * the QR code on the computer's own screen. So the certificate only has to be well formed and carry
 * the key; Node's own X509Certificate parses and verifies every one this file writes.
 *
 * The private key is machine key material (src/core/keyMaterialPaths.ts): never served, backed up,
 * synced or committed. A replaced key means pairing the phone again (install-experience §6).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Relative to the state dir; listed in KEY_MATERIAL_PATHS. */
export const SAME_NETWORK_KEY_FILE = 'state/same-network-tls.key';
export const SAME_NETWORK_CERT_FILE = 'state/same-network-tls.crt';
const VALIDITY_YEARS = 20;

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let x = n; x > 0; x = Math.floor(x / 256)) bytes.unshift(x & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}
const seq = (...p: Buffer[]): Buffer => tlv(0x30, ...p);
const set = (...p: Buffer[]): Buffer => tlv(0x31, ...p);
function oid(dotted: string): Buffer {
  const a = dotted.split('.').map(Number);
  const out: number[] = [40 * a[0] + a[1]];
  for (const v of a.slice(2)) {
    const b: number[] = [v & 0x7f];
    for (let x = Math.floor(v / 128); x > 0; x = Math.floor(x / 128)) b.unshift(0x80 | (x & 0x7f));
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
}
function integer(raw: Buffer): Buffer {
  let b = raw;
  while (b.length > 1 && b[0] === 0 && (b[1] & 0x80) === 0) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}
function derTime(d: Date): Buffer {
  const p = (n: number): string => String(n).padStart(2, '0');
  const y = d.getUTCFullYear();
  const rest = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return y < 2050 ? tlv(0x17, Buffer.from(String(y).slice(2) + rest, 'ascii')) : tlv(0x18, Buffer.from(String(y) + rest, 'ascii'));
}
function ipBytes(ip: string): Buffer | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split('.').map(Number);
    return parts.every((n) => n <= 255) ? Buffer.from(parts) : null;
  }
  return null;
}

export interface SameNetworkIdentity {
  keyPem: string;
  certPem: string;
  /** base64url SHA-256 of the certificate's SubjectPublicKeyInfo (DER): the value the phone pins. */
  spkiHash: string;
}

/** base64url SHA-256 over a public key's SPKI DER. */
export function spkiHashOf(key: crypto.KeyObject | string): string {
  const pub = typeof key === 'string' ? crypto.createPublicKey(key) : (key.type === 'private' ? crypto.createPublicKey(key) : key);
  const der = pub.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('base64url');
}

/** Write a self-signed certificate for `keyPem`'s key, naming `dnsName` (and any IPv4 `ips`). */
export function writeSelfSignedCert(keyPem: string, dnsName: string, ips: string[] = [], now = new Date()): string {
  const priv = crypto.createPrivateKey(keyPem);
  const pub = crypto.createPublicKey(priv);
  const spki = pub.export({ type: 'spki', format: 'der' });
  const cn = dnsName.slice(0, 64);
  const name = seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn, 'utf8')))));
  const sigAlg = seq(oid('1.2.840.10045.4.3.2'));
  const notBefore = new Date(now.getTime() - 60 * 60_000);
  const notAfter = new Date(now.getTime());
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + VALIDITY_YEARS);
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  if (serial[0] === 0) serial[0] = 1;
  const sanEntries: Buffer[] = [tlv(0x82, Buffer.from(dnsName, 'ascii'))];
  for (const ip of ips) { const b = ipBytes(ip); if (b) sanEntries.push(tlv(0x87, b)); }
  const ext = (id: string, critical: boolean, value: Buffer): Buffer =>
    seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));
  const extensions = tlv(0xa3, seq(
    ext('2.5.29.19', true, seq()), // basicConstraints: not a CA
    ext('2.5.29.15', true, tlv(0x03, Buffer.from([0x07, 0x80]))), // keyUsage: digitalSignature
    ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))), // extKeyUsage: serverAuth
    ext('2.5.29.17', false, seq(...sanEntries)), // subjectAltName
  ));
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(serial),
    sigAlg,
    name,
    seq(derTime(notBefore), derTime(notAfter)),
    name,
    Buffer.from(spki),
    extensions,
  );
  const sig = crypto.sign('sha256', tbs, { key: priv, dsaEncoding: 'der' });
  const cert = seq(tbs, sigAlg, tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
  const b64 = cert.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

/** A fresh P-256 private key, PEM (PKCS#8). */
export function newSameNetworkKey(): string {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

function writePrivate(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* @silent-fallback-ok — the write already used mode 0600; chmod only repairs an older file */ }
}

/**
 * The agent's same-network identity: the stored key and certificate, made on first use. The
 * certificate is rewritten (same key, so the same pinned hash) when its name no longer matches;
 * a key that cannot be read is replaced, which means pairing again, and the caller is told.
 */
export function loadOrCreateSameNetworkIdentity(stateDir: string, dnsName: string): SameNetworkIdentity & { created: boolean } {
  const keyFile = path.join(stateDir, SAME_NETWORK_KEY_FILE);
  const certFile = path.join(stateDir, SAME_NETWORK_CERT_FILE);
  let keyPem: string | null = null;
  try {
    keyPem = fs.readFileSync(keyFile, 'utf8');
    crypto.createPrivateKey(keyPem);
  } catch {
    // @silent-fallback-ok — no key yet (or an unreadable one): a new key is made and `created` says so.
    keyPem = null;
  }
  let created = false;
  if (!keyPem) {
    keyPem = newSameNetworkKey();
    writePrivate(keyFile, keyPem);
    created = true;
  }
  let certPem: string | null = null;
  try {
    certPem = fs.readFileSync(certFile, 'utf8');
    const x = new crypto.X509Certificate(certPem);
    const sameKey = spkiHashOf(x.publicKey) === spkiHashOf(keyPem);
    const sameName = (x.subjectAltName ?? '').split(/,\s*/).includes(`DNS:${dnsName}`);
    if (!sameKey || !sameName || Date.parse(x.validTo) <= Date.now()) certPem = null;
  } catch {
    // @silent-fallback-ok — no certificate yet (or an unreadable one): rewritten from the same key, so the pin is unchanged.
    certPem = null;
  }
  if (!certPem) {
    certPem = writeSelfSignedCert(keyPem, dnsName);
    fs.mkdirSync(path.dirname(certFile), { recursive: true });
    fs.writeFileSync(certFile, certPem, { mode: 0o644 });
  }
  return { keyPem, certPem, spkiHash: spkiHashOf(keyPem), created };
}
