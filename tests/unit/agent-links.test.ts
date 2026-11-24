/**
 * Permanent agent links (docs/specs/permanent-agent-links.md): grammar, builder, strict identity
 * read, proof transcript. The accept/reject vectors are shared with site/public/a.js (tested
 * against the same file below) and the app's Swift tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { pathToFileURL } from 'node:url';
import {
  parseAgentLink, canonicalFragment, buildAgentLink, readLinkIdentity, parseNonce,
  proofTranscript, signProof, verifyProof, MAX_FRAGMENT,
} from '../../src/core/AgentLinks.js';
import { computeCanonicalId } from '../../src/identity/types.js';
import vectors from '../fixtures/agent-link-vectors.json';

const ID = 'a'.repeat(64);

function keypair(): { pub: Buffer; priv: Buffer } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  return { pub: Buffer.from(pub), priv: Buffer.from(priv) };
}

function writeIdentity(file: string, k: { pub: Buffer; priv: Buffer }, extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ publicKey: k.pub.toString('base64'), privateKey: k.priv.toString('base64'), createdAt: '2026-01-01T00:00:00Z', ...extra }));
}

describe('agent link grammar (shared vectors)', () => {
  for (const v of vectors.accept) {
    it(`accepts ${v.name}`, () => {
      const p = parseAgentLink(v.fragment);
      expect(p).not.toBeNull();
      expect(p).toEqual(v.parsed);
      // Canonical form round-trips.
      expect(parseAgentLink(canonicalFragment(p!))).toEqual(p);
    });
  }
  for (const v of vectors.reject) {
    it(`rejects ${v.name}`, () => {
      expect(parseAgentLink(v.fragment)).toBeNull();
    });
  }
  it('the length bound is finite and refuses longer input before parsing', () => {
    expect(Number.isFinite(MAX_FRAGMENT)).toBe(true);
    expect(parseAgentLink(`v=1&i=${ID}&t=home&` + 'x'.repeat(MAX_FRAGMENT))).toBeNull();
  });
  it('site/public/a.js agrees with the server parser on every vector', async () => {
    const site = await import(pathToFileURL(path.resolve(__dirname, '../../site/public/a.js')).href);
    for (const v of [...vectors.accept, ...vectors.reject]) {
      const a = site.parseAgentLink(v.fragment);
      const b = parseAgentLink(v.fragment);
      expect(a === null ? null : { ...a }, v.name).toEqual(b);
    }
  });
});

describe('buildAgentLink', () => {
  it('builds home, doc (with and without comment) and conversation links that parse back', () => {
    const home = buildAgentLink(ID, { target: 'home' });
    expect(home).toMatchObject({ ok: true, url: `https://instar.sh/a#v=1&i=${ID}&t=home`, appUrl: `instar://a#v=1&i=${ID}&t=home` });
    const doc = buildAgentLink(ID, { target: 'doc', ref: '12345678-1234-1234-1234-123456789ABC' });
    expect(doc.ok && doc.link.ref).toBe('12345678-1234-1234-1234-123456789abc');
    const withComment = buildAgentLink(ID, { target: 'doc', ref: '12345678-1234-1234-1234-123456789abc', comment: 'p1:12345678-1234-1234-1234-123456789abc' });
    expect(withComment.ok && withComment.url).toContain('&c=p1%3A12345678');
    const tg = buildAgentLink(ID, { target: 'conversation', ref: 144473 });
    expect(tg.ok && tg.link.ref).toBe('tg:144473');
  });
  it('refuses anything outside the grammar', () => {
    expect(buildAgentLink(ID, { target: 'settings' })).toEqual({ ok: false, error: 'bad-target' });
    expect(buildAgentLink(ID, { target: 'home', ref: 'x' })).toEqual({ ok: false, error: 'bad-target' });
    expect(buildAgentLink(ID, { target: 'doc' })).toEqual({ ok: false, error: 'bad-target' });
    expect(buildAgentLink(ID, { target: 'conversation', ref: '../../api' })).toEqual({ ok: false, error: 'bad-target' });
    expect(buildAgentLink(ID, { target: 'conversation', ref: 'tg:1', comment: 'p:12345678-1234-1234-1234-123456789abc' })).toEqual({ ok: false, error: 'bad-target' });
    expect(buildAgentLink(ID, { target: 'conversation', ref: -5 })).toEqual({ ok: false, error: 'bad-target' });
    expect(buildAgentLink('not-an-id', { target: 'home' })).toEqual({ ok: false, error: 'bad-target' });
  });
});

describe('readLinkIdentity (strict)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-links-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/agent-links.test.ts' }); });

  it('no file → no-agent-identity', () => {
    expect(readLinkIdentity(dir)).toEqual({ ok: false, error: 'no-agent-identity' });
  });
  it('identity.json decides; the id is computed from the public key, not a stored field', () => {
    const k = keypair();
    writeIdentity(path.join(dir, 'identity.json'), k, { canonicalId: 'f'.repeat(64) });
    const r = readLinkIdentity(dir);
    expect(r.ok && r.canonicalId).toBe(computeCanonicalId(k.pub));
  });
  it('only the Threadline legacy file → used', () => {
    const k = keypair();
    writeIdentity(path.join(dir, 'threadline', 'identity.json'), k);
    const r = readLinkIdentity(dir);
    expect(r.ok && r.canonicalId).toBe(computeCanonicalId(k.pub));
  });
  it('unusable identity.json → identity-unreadable, no fall-through to a good legacy file', () => {
    fs.writeFileSync(path.join(dir, 'identity.json'), '{not json');
    writeIdentity(path.join(dir, 'threadline', 'identity.json'), keypair());
    expect(readLinkIdentity(dir)).toEqual({ ok: false, error: 'identity-unreadable' });
  });
  it('encrypted identity.json → identity-key-locked', () => {
    const k = keypair();
    writeIdentity(path.join(dir, 'identity.json'), k, { privateKey: 'Y2lwaGVydGV4dA==', privateKeyEncryption: 'scrypt-aes' });
    expect(readLinkIdentity(dir)).toEqual({ ok: false, error: 'identity-key-locked' });
  });
  it('both readable with different keys → identity-split', () => {
    writeIdentity(path.join(dir, 'identity.json'), keypair());
    writeIdentity(path.join(dir, 'threadline', 'identity.json'), keypair());
    expect(readLinkIdentity(dir)).toEqual({ ok: false, error: 'identity-split' });
  });
  it('both files with the same key → ok', () => {
    const k = keypair();
    writeIdentity(path.join(dir, 'identity.json'), k);
    writeIdentity(path.join(dir, 'threadline', 'identity.json'), k);
    expect(readLinkIdentity(dir).ok).toBe(true);
  });
  it('never writes or repairs a file', () => {
    const k = keypair();
    const file = path.join(dir, 'identity.json');
    // Hex-encoded keys are a repairable form; a strict read must leave the file untouched.
    fs.writeFileSync(file, JSON.stringify({ publicKey: k.pub.toString('hex'), privateKey: k.priv.toString('hex') }));
    const before = fs.readFileSync(file, 'utf-8');
    readLinkIdentity(dir);
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });
});

describe('proof', () => {
  it('nonce must be exactly 32 bytes of unpadded base64url', () => {
    const good = crypto.randomBytes(32).toString('base64url');
    expect(parseNonce(good)).toBe(good);
    expect(parseNonce(good + '=')).toBeNull();
    expect(parseNonce(crypto.randomBytes(31).toString('base64url'))).toBeNull();
    expect(parseNonce(crypto.randomBytes(32).toString('base64'))).toBeNull(); // padded standard base64
    expect(parseNonce(12)).toBeNull();
  });
  it('transcript bytes are fixed and domain-separated', () => {
    expect(proofTranscript(ID, 'dev-1', 'echo.example.com:8443', 'N').toString('utf-8'))
      .toBe(`instar-agent-link-proof-v1\n${ID}\ndev-1\necho.example.com:8443\nN`);
  });
  it('verifies with the public key, fails for a different device, host or nonce', () => {
    const k = keypair();
    const id = computeCanonicalId(k.pub);
    const nonce = crypto.randomBytes(32).toString('base64url');
    const sig = signProof(k.priv, proofTranscript(id, 'dev-1', 'echo.example.com', nonce));
    expect(verifyProof(k.pub, proofTranscript(id, 'dev-1', 'echo.example.com', nonce), sig)).toBe(true);
    expect(verifyProof(k.pub, proofTranscript(id, 'dev-2', 'echo.example.com', nonce), sig)).toBe(false);
    expect(verifyProof(k.pub, proofTranscript(id, 'dev-1', 'other.example.com', nonce), sig)).toBe(false);
    expect(verifyProof(k.pub, proofTranscript(id, 'dev-1', 'echo.example.com', crypto.randomBytes(32).toString('base64url')), sig)).toBe(false);
    expect(verifyProof(keypair().pub, proofTranscript(id, 'dev-1', 'echo.example.com', nonce), sig)).toBe(false);
  });
});

describe('instar.sh /a page and Apple link file', () => {
  const root = path.resolve(__dirname, '../..');
  it('the page loads exactly one same-origin script and no outside resource', () => {
    // A plain static file: an Astro page would get the site's injected prefetch script (seen on the deployed preview).
    expect(fs.existsSync(path.join(root, 'site/src/pages/a.astro'))).toBe(false);
    const html = fs.readFileSync(path.join(root, 'site/public/a/index.html'), 'utf-8');
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('src="/a.js"');
    // Fetched resources (src=, link href=, url()) are same-origin; only plain navigation links leave the site.
    for (const m of html.matchAll(/\bsrc="([^"]+)"/g)) expect(m[1].startsWith('/')).toBe(true);
    expect(html).not.toMatch(/<link\b[^>]*href="https?:/);
    expect(html).not.toMatch(/url\(\s*['"]?https?:/);
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toMatch(/http-equiv="refresh"/i);
  });
  it('the Apple link file lists /a for the iPhone app and the Mac app', () => {
    // Read as text: importing the site module would pull in the site's own Astro tsconfig.
    const src = fs.readFileSync(path.join(root, 'site/src/pages/.well-known/apple-app-site-association.ts'), 'utf-8');
    const block = (appId: string): string[] => {
      const at = src.indexOf(`appIDs: ['${appId}']`);
      expect(at, appId).toBeGreaterThan(-1);
      const end = src.indexOf(']', src.indexOf('components:', at));
      return [...src.slice(at, end).matchAll(/'\/': '([^']+)'/g)].map((m) => m[1]);
    };
    expect(block('AG9AE2H87X.io.sagemindai.instar')).toEqual(['/pair', '/doc', '/link/computer', '/a', '/a/']);
    expect(block('AG9AE2H87X.io.sagemindai.instar.mac')).toEqual(['/a', '/a/']);
  });
});
