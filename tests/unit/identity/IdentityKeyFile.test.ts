/**
 * Unit — the identity key-file reader/repairer (ACT-062).
 * Spec: docs/specs/threadline-identity-single-writer.md
 *
 * Covers both sides of every boundary: base64 (valid, untouched), hex (the same
 * key in the wrong encoding → repaired, same key, same fingerprint), and
 * everything else (refused loudly, file untouched, nothing minted).
 *
 * Assertions compare buffers with .equals() and never interpolate key material
 * into a message, so a failure prints no key.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  IdentityFileInvalidError,
  createFileExclusiveOwnerOnly,
  decodeKey32,
  derivePublicKey,
  readIdentityKeyFile,
  writeFileAtomicOwnerOnly,
} from '../../../src/identity/IdentityKeyFile.js';
import { CanonicalIdentityManager } from '../../../src/identity/IdentityManager.js';
import { migrateFromLegacy } from '../../../src/identity/Migration.js';
import { computeCanonicalId, computeDisplayFingerprint } from '../../../src/identity/types.js';
import { IdentityManager } from '../../../src/threadline/client/IdentityManager.js';
import { computeFingerprint } from '../../../src/threadline/client/MessageEncryptor.js';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const mode = (file: string): number => fs.statSync(file).mode & 0o777;
const readJson = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, 'utf-8'));
const sameBytes = (a: Buffer, b: Buffer): boolean => a.equals(b);

describe('identity key file — validate on read, repair hex, refuse the rest', () => {
  let stateDir: string;
  let legacyFile: string;
  let canonicalFile: string;
  let kp: { publicKey: Buffer; privateKey: Buffer };

  /** Exactly what the removed HandshakeManager writer produced. */
  const writeHexLegacy = (): void => {
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(legacyFile, JSON.stringify({
      publicKey: kp.publicKey.toString('hex'),
      privateKey: kp.privateKey.toString('hex'),
    }, null, 2), { mode: 0o644 });
  };

  /** Exactly what the old migration produced from that file: the hex strings
   *  copied through, and identifiers computed from the 48-byte mis-decode. */
  const writePoisonedCanonical = (): void => {
    const misdecoded = Buffer.from(kp.publicKey.toString('hex'), 'base64');
    const badId = computeCanonicalId(misdecoded);
    fs.writeFileSync(canonicalFile, JSON.stringify({
      version: 1,
      publicKey: kp.publicKey.toString('hex'),
      privateKey: kp.privateKey.toString('hex'),
      privateKeyEncryption: 'none',
      canonicalId: badId,
      displayFingerprint: computeDisplayFingerprint(badId),
      createdAt: '2026-10-01T00:00:00.000Z',
    }, null, 2), { mode: 0o644 });
  };

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-keyfile-'));
    legacyFile = path.join(stateDir, 'threadline', 'identity.json');
    canonicalFile = path.join(stateDir, 'identity.json');
    kp = generateIdentityKeyPair();
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/identity/IdentityKeyFile.test.ts:cleanup' });
  });

  describe('decodeKey32', () => {
    it('accepts a 32-byte key in base64 and in hex, and tells them apart', () => {
      const b64 = decodeKey32(kp.publicKey.toString('base64'));
      const hex = decodeKey32(kp.publicKey.toString('hex'));
      expect(b64?.encoding).toBe('base64');
      expect(hex?.encoding).toBe('hex');
      expect(sameBytes(b64!.key, kp.publicKey)).toBe(true);
      expect(sameBytes(hex!.key, kp.publicKey)).toBe(true);
    });

    it('ignores stray whitespace, as the old lenient decoder did', () => {
      expect(decodeKey32(kp.publicKey.toString('base64') + '\n')?.key.equals(kp.publicKey)).toBe(true);
      expect(decodeKey32(' ' + kp.publicKey.toString('hex') + '\n')?.encoding).toBe('hex');
    });

    it('never reads 64 hex characters as base64 (the 48-byte poison)', () => {
      const hexText = kp.publicKey.toString('hex');
      expect(Buffer.from(hexText, 'base64').length).toBe(48); // the defect, pinned
      expect(decodeKey32(hexText)?.key.length).toBe(32);
    });

    it('rejects wrong lengths, non-strings and non-key text', () => {
      expect(decodeKey32(Buffer.alloc(31, 0xff).toString('base64'))).toBeNull();
      expect(decodeKey32(Buffer.alloc(48, 0xff).toString('base64'))).toBeNull();
      expect(decodeKey32(Buffer.alloc(32, 0xff).toString('base64') + '!')).toBeNull();
      expect(decodeKey32('a'.repeat(63))).toBeNull();
      expect(decodeKey32('not a key!')).toBeNull();
      expect(decodeKey32('')).toBeNull();
      expect(decodeKey32(undefined)).toBeNull();
      expect(decodeKey32(42)).toBeNull();
    });
  });

  it('derivePublicKey gives the public key of a private seed', () => {
    expect(sameBytes(derivePublicKey(kp.privateKey), kp.publicKey)).toBe(true);
  });

  it('writeFileAtomicOwnerOnly writes 0600, replaces in place and leaves no temp file', () => {
    const file = path.join(stateDir, 'nested', 'secret.json');
    writeFileAtomicOwnerOnly(file, '{"a":1}');
    fs.chmodSync(file, 0o644);
    writeFileAtomicOwnerOnly(file, '{"a":2}');
    expect(readJson(file)).toEqual({ a: 2 });
    expect(mode(file)).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['secret.json']);
  });

  it('createFileExclusiveOwnerOnly creates once, 0600, and never replaces an existing file', () => {
    const file = path.join(stateDir, 'nested2', 'once.json');
    expect(createFileExclusiveOwnerOnly(file, '{"a":1}')).toBe(true);
    expect(createFileExclusiveOwnerOnly(file, '{"a":2}')).toBe(false);
    expect(readJson(file)).toEqual({ a: 1 });
    expect(mode(file)).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['once.json']);
  });

  describe('readIdentityKeyFile', () => {
    it('returns null for a missing file', () => {
      expect(readIdentityKeyFile(legacyFile)).toBeNull();
    });

    it('leaves a valid base64 file byte-for-byte untouched', () => {
      new IdentityManager(stateDir).getOrCreate();
      const before = fs.readFileSync(legacyFile, 'utf-8');
      const loaded = readIdentityKeyFile(legacyFile, { repair: true });
      expect(loaded?.repaired).toBe(false);
      expect(fs.readFileSync(legacyFile, 'utf-8')).toBe(before);
    });

    it('decodes a hex file without writing when repair is not requested', () => {
      writeHexLegacy();
      const before = fs.readFileSync(legacyFile, 'utf-8');
      const loaded = readIdentityKeyFile(legacyFile);
      expect(sameBytes(loaded!.publicKey, kp.publicKey)).toBe(true);
      expect(loaded!.repaired).toBe(false);
      expect(fs.readFileSync(legacyFile, 'utf-8')).toBe(before);
    });

    it.each([
      ['not JSON', 'not json'],
      ['a JSON array', '[]'],
      ['a missing public key', JSON.stringify({ privateKey: 'x' })],
      ['a 48-byte public key', JSON.stringify({ publicKey: Buffer.alloc(48, 1).toString('base64'), privateKey: Buffer.alloc(32, 2).toString('base64') })],
      ['a short private key', JSON.stringify({ publicKey: Buffer.alloc(32, 1).toString('base64'), privateKey: Buffer.alloc(16, 2).toString('base64') })],
    ])('refuses %s and leaves the file untouched', (_label, content) => {
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      fs.writeFileSync(legacyFile, content);
      expect(() => readIdentityKeyFile(legacyFile, { repair: true })).toThrow(IdentityFileInvalidError);
      expect(fs.readFileSync(legacyFile, 'utf-8')).toBe(content);
    });

    it('refuses a public key that does not belong to the private key', () => {
      const other = generateIdentityKeyPair();
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      fs.writeFileSync(legacyFile, JSON.stringify({
        publicKey: other.publicKey.toString('base64'),
        privateKey: kp.privateKey.toString('base64'),
      }));
      expect(() => readIdentityKeyFile(legacyFile, { repair: true })).toThrow(/does not belong/);
    });

    it('never puts key material in an error message', () => {
      const pubHex = kp.publicKey.toString('hex');
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      fs.writeFileSync(legacyFile, JSON.stringify({ publicKey: pubHex + 'ab', privateKey: kp.privateKey.toString('hex') }));
      let message = '';
      try { readIdentityKeyFile(legacyFile, { repair: true }); } catch (err) { message = (err as Error).message; }
      expect(message).toMatch(/cannot be used/);
      expect(message.includes(pubHex)).toBe(false);
      expect(message.includes(kp.privateKey.toString('hex'))).toBe(false);
      expect(message.includes(kp.privateKey.toString('base64'))).toBe(false);
    });

    it('still returns the decoded key when the repair cannot be written', () => {
      writeHexLegacy();
      const dir = path.dirname(legacyFile);
      fs.chmodSync(dir, 0o500);
      try {
        const loaded = readIdentityKeyFile(legacyFile, { repair: true });
        expect(sameBytes(loaded!.publicKey, kp.publicKey)).toBe(true);
        expect(loaded!.repaired).toBe(false);
        expect(loaded!.repairError).toBeTruthy();
      } finally {
        fs.chmodSync(dir, 0o700);
      }
    });
  });

  describe('IdentityManager (threadline client) — hex legacy fixture', () => {
    it('repairs the file: same key, the fingerprint the hex key implies, base64, 0600', () => {
      writeHexLegacy();
      const id = new IdentityManager(stateDir).get();
      expect(id).not.toBeNull();
      expect(sameBytes(id!.publicKey, kp.publicKey)).toBe(true);
      expect(sameBytes(id!.privateKey, kp.privateKey)).toBe(true);
      expect(id!.publicKey.length).toBe(32);
      expect(id!.fingerprint).toBe(computeFingerprint(kp.publicKey));

      const onDisk = readJson(legacyFile);
      expect(sameBytes(Buffer.from(onDisk.publicKey as string, 'base64'), kp.publicKey)).toBe(true);
      expect(sameBytes(Buffer.from(onDisk.privateKey as string, 'base64'), kp.privateKey)).toBe(true);
      expect(onDisk.fingerprint).toBe(computeFingerprint(kp.publicKey));
      expect(typeof onDisk.x25519PublicKey).toBe('string');
      expect(typeof onDisk.createdAt).toBe('string');
      expect(mode(legacyFile)).toBe(0o600);
    });

    it('is idempotent: a second load changes nothing', () => {
      writeHexLegacy();
      new IdentityManager(stateDir).get();
      const after = fs.readFileSync(legacyFile, 'utf-8');
      const again = new IdentityManager(stateDir).getOrCreate();
      expect(fs.readFileSync(legacyFile, 'utf-8')).toBe(after);
      expect(again.fingerprint).toBe(computeFingerprint(kp.publicKey));
    });

    it('getOrCreate on a hex file returns the existing key, never a new one', () => {
      writeHexLegacy();
      expect(sameBytes(new IdentityManager(stateDir).getOrCreate().publicKey, kp.publicKey)).toBe(true);
    });
  });

  describe('IdentityManager (threadline client) — hex canonical fixture', () => {
    it('repairs BOTH files and loads the same key with the right fingerprint', () => {
      writeHexLegacy();
      writePoisonedCanonical();

      const id = new IdentityManager(stateDir).get();
      expect(sameBytes(id!.publicKey, kp.publicKey)).toBe(true);
      expect(id!.publicKey.length).toBe(32);
      expect(id!.fingerprint).toBe(computeFingerprint(kp.publicKey));

      const canonical = readJson(canonicalFile);
      const goodId = computeCanonicalId(kp.publicKey);
      expect(sameBytes(Buffer.from(canonical.publicKey as string, 'base64'), kp.publicKey)).toBe(true);
      expect(sameBytes(Buffer.from(canonical.privateKey as string, 'base64'), kp.privateKey)).toBe(true);
      expect(canonical.canonicalId).toBe(goodId);
      expect(canonical.displayFingerprint).toBe(computeDisplayFingerprint(goodId));
      expect(canonical.createdAt).toBe('2026-10-01T00:00:00.000Z');
      expect(canonical.privateKeyEncryption).toBe('none');
      expect(mode(canonicalFile)).toBe(0o600);

      const legacy = readJson(legacyFile);
      expect(sameBytes(Buffer.from(legacy.publicKey as string, 'base64'), kp.publicKey)).toBe(true);
      expect(mode(legacyFile)).toBe(0o600);
    });

    it('CanonicalIdentityManager.load repairs a poisoned canonical file too', () => {
      writePoisonedCanonical();
      const loaded = new CanonicalIdentityManager(stateDir).load();
      const goodId = computeCanonicalId(kp.publicKey);
      expect(sameBytes(loaded!.publicKey, kp.publicKey)).toBe(true);
      expect(loaded!.publicKey.length).toBe(32);
      expect(loaded!.privateKey.length).toBe(32);
      expect(loaded!.canonicalId).toBe(goodId);
      expect(readJson(canonicalFile).canonicalId).toBe(goodId);
    });
  });

  it('CanonicalIdentityManager.load keeps refusing a file with no declared encryption (unchanged behaviour)', () => {
    // The pairing installer writes this shape. Loading it here was an error
    // before this change and still is; widening that is a separate decision.
    fs.writeFileSync(canonicalFile, JSON.stringify({
      version: 1,
      publicKey: kp.publicKey.toString('base64'),
      privateKey: kp.privateKey.toString('base64'),
      createdAt: '2026-10-01T00:00:00.000Z',
    }));
    expect(() => new CanonicalIdentityManager(stateDir).load()).toThrow(/Unknown encryption method/);
    // The relay-side manager loads it, as before.
    expect(new IdentityManager(stateDir).get()?.fingerprint).toBe(computeFingerprint(kp.publicKey));
  });

  describe('IdentityManager (threadline client) — unusable files', () => {
    it('an unusable canonical file falls back to a valid legacy file, and says so', () => {
      new IdentityManager(stateDir).getOrCreate();
      const legacyFp = new IdentityManager(stateDir).get()!.fingerprint;
      fs.writeFileSync(canonicalFile, '{"publicKey":"zz"}');
      const mgr = new IdentityManager(stateDir);
      expect(mgr.getOrCreate().fingerprint).toBe(legacyFp);
      // An identity loaded, so this is not fatal — but the bad file is still reported.
      expect(mgr.problem?.filePath).toBe(canonicalFile);
      expect(fs.readFileSync(canonicalFile, 'utf-8')).toBe('{"publicKey":"zz"}');
    });

    it('with no usable file, get() is null, problem is set, getOrCreate throws, nothing is written', () => {
      fs.writeFileSync(canonicalFile, '{"publicKey":"zz"}');
      const mgr = new IdentityManager(stateDir);
      expect(mgr.get()).toBeNull();
      expect(mgr.problem).toBeInstanceOf(IdentityFileInvalidError);
      expect(mgr.problem!.filePath).toBe(canonicalFile);
      expect(() => mgr.getOrCreate()).toThrow(IdentityFileInvalidError);
      expect(fs.existsSync(legacyFile)).toBe(false);
      expect(fs.readFileSync(canonicalFile, 'utf-8')).toBe('{"publicKey":"zz"}');
    });

    it('a passphrase-encrypted canonical file is still "not loadable here", not a problem', () => {
      new CanonicalIdentityManager(stateDir).create({ passphrase: 'pw', skipRecovery: true });
      const mgr = new IdentityManager(stateDir);
      expect(mgr.get()).toBeNull();
      expect(mgr.problem).toBeNull();
    });
  });

  describe('IdentityManager (threadline client) — the two files must hold one identity', () => {
    const writeCanonical = (pair: { publicKey: Buffer; privateKey: Buffer }): void => {
      fs.writeFileSync(canonicalFile, JSON.stringify({
        version: 1,
        publicKey: pair.publicKey.toString('base64'),
        privateKey: pair.privateKey.toString('base64'),
        privateKeyEncryption: 'none',
        createdAt: '2026-10-01T00:00:00.000Z',
      }));
    };

    it('reports a disagreement, keeps the canonical identity, and rewrites nothing', () => {
      const legacyId = new IdentityManager(stateDir).getOrCreate();
      const other = generateIdentityKeyPair();
      writeCanonical(other);
      const before = [fs.readFileSync(canonicalFile, 'utf-8'), fs.readFileSync(legacyFile, 'utf-8')];

      const mgr = new IdentityManager(stateDir);
      const id = mgr.get();
      expect(mgr.identityFilesDisagree).toBe(true);
      expect(id!.fingerprint).toBe(computeFingerprint(other.publicKey));
      expect(id!.fingerprint).not.toBe(legacyId.fingerprint);
      expect([fs.readFileSync(canonicalFile, 'utf-8'), fs.readFileSync(legacyFile, 'utf-8')]).toEqual(before);
    });

    it('is quiet when both files hold the same identity, or only one exists', () => {
      const only = new IdentityManager(stateDir);
      const id = only.getOrCreate();
      expect(only.identityFilesDisagree).toBe(false);

      writeCanonical({ publicKey: id.publicKey, privateKey: id.privateKey });
      const both = new IdentityManager(stateDir);
      both.get();
      expect(both.identityFilesDisagree).toBe(false);
    });
  });

  describe('migrateFromLegacy', () => {
    it('from a hex legacy file: canonical holds the real 32-byte key, and the legacy file is repaired', () => {
      writeHexLegacy();
      const result = migrateFromLegacy(stateDir, { skipRecovery: true });
      const goodId = computeCanonicalId(kp.publicKey);

      expect(sameBytes(result.identity.publicKey, kp.publicKey)).toBe(true);
      expect(result.identity.publicKey.length).toBe(32);
      expect(result.identity.privateKey.length).toBe(32);
      expect(result.identity.canonicalId).toBe(goodId);

      const canonical = readJson(canonicalFile);
      const storedPub = Buffer.from(canonical.publicKey as string, 'base64');
      expect(storedPub.length).toBe(32); // was 48 before the fix
      expect(sameBytes(storedPub, kp.publicKey)).toBe(true);
      expect(sameBytes(Buffer.from(canonical.privateKey as string, 'base64'), kp.privateKey)).toBe(true);
      expect(canonical.canonicalId).toBe(goodId);
      expect(mode(canonicalFile)).toBe(0o600);

      // The relay-side identity after migration is the one the hex key implies.
      expect(new IdentityManager(stateDir).getOrCreate().fingerprint).toBe(computeFingerprint(kp.publicKey));
      expect(sameBytes(Buffer.from(readJson(legacyFile).publicKey as string, 'base64'), kp.publicKey)).toBe(true);
      expect(mode(legacyFile)).toBe(0o600);
    });

    it('with a passphrase: encrypts the real key and loads back', () => {
      writeHexLegacy();
      migrateFromLegacy(stateDir, { passphrase: 'pw' });
      const loaded = new CanonicalIdentityManager(stateDir).load({ passphrase: 'pw' });
      expect(sameBytes(loaded!.publicKey, kp.publicKey)).toBe(true);
      expect(sameBytes(loaded!.privateKey, kp.privateKey)).toBe(true);
    });

    it('refuses an unusable legacy file and writes no canonical file', () => {
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      fs.writeFileSync(legacyFile, JSON.stringify({ publicKey: 'zz', privateKey: 'zz' }));
      expect(() => migrateFromLegacy(stateDir, { skipRecovery: true })).toThrow(IdentityFileInvalidError);
      expect(fs.existsSync(canonicalFile)).toBe(false);
    });
  });
});
