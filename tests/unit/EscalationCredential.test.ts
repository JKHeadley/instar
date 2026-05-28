/**
 * Unit tests for EscalationCredential — minimal per-agent {ownerTopicId,
 * botToken} stored outside any TCC folder + any project tree, with structural
 * 0700/0600/atomic-write protections.
 *
 * Spec: docs/specs/macos26-launchd-tcc-runtime-relocation.md (Scope C).
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeCredential,
  readCredential,
  removeCredential,
  registryDir,
  credentialPath,
  isValidBotToken,
} from '../../src/core/EscalationCredential.js';

const homes: string[] = [];
function fakeHome(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-cred-'));
  homes.push(h);
  return h;
}
afterEach(() => {
  for (const h of homes.splice(0)) {
    try { fs.rmSync(h, { recursive: true, force: true }); } catch { /* */ }
  }
});

const VALID_TOKEN = '1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789';
const BUNDLE = 'ai.instar.b2lead';

describe('EscalationCredential', () => {
  it('writes the credential file with mode 0600 in a 0700 dir', () => {
    const home = fakeHome();
    expect(writeCredential(BUNDLE, { ownerTopicId: 5447, botToken: VALID_TOKEN }, home)).toBe('written');
    const file = credentialPath(BUNDLE, home);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(registryDir(home)).mode & 0o777).toBe(0o700);
  });

  it('stores ONLY ownerTopicId + botToken (the minimal scoping)', () => {
    const home = fakeHome();
    writeCredential(BUNDLE, { ownerTopicId: 5447, botToken: VALID_TOKEN }, home);
    const parsed = JSON.parse(fs.readFileSync(credentialPath(BUNDLE, home), 'utf-8'));
    expect(Object.keys(parsed).sort()).toEqual(['botToken', 'ownerTopicId']);
  });

  it('reads back what it wrote', () => {
    const home = fakeHome();
    writeCredential(BUNDLE, { ownerTopicId: 5447, botToken: VALID_TOKEN }, home);
    const got = readCredential(BUNDLE, home);
    expect(got).toEqual({ ownerTopicId: 5447, botToken: VALID_TOKEN });
  });

  it('returns "unchanged" on an idempotent re-write (no fsync churn per boot)', () => {
    const home = fakeHome();
    writeCredential(BUNDLE, { ownerTopicId: 5447, botToken: VALID_TOKEN }, home);
    expect(writeCredential(BUNDLE, { ownerTopicId: 5447, botToken: VALID_TOKEN }, home)).toBe('unchanged');
  });

  it('refuses to write an invalid token (silent failure would be worse — watchdog would 401 forever)', () => {
    const home = fakeHome();
    expect(writeCredential(BUNDLE, { ownerTopicId: 5447, botToken: 'not-a-token' }, home)).toBe('invalid-token');
    expect(fs.existsSync(credentialPath(BUNDLE, home))).toBe(false);
  });

  it('refuses to write when ownerTopicId is empty/missing', () => {
    const home = fakeHome();
    expect(writeCredential(BUNDLE, { ownerTopicId: '', botToken: VALID_TOKEN }, home)).toBe('invalid-token');
    expect(fs.existsSync(credentialPath(BUNDLE, home))).toBe(false);
  });

  it('readCredential returns null on missing / malformed / token-shape-fail', () => {
    const home = fakeHome();
    // missing
    expect(readCredential(BUNDLE, home)).toBeNull();
    // malformed JSON
    fs.mkdirSync(registryDir(home), { recursive: true, mode: 0o700 });
    fs.writeFileSync(credentialPath(BUNDLE, home), '{ not json');
    expect(readCredential(BUNDLE, home)).toBeNull();
    // token-shape-fail
    fs.writeFileSync(credentialPath(BUNDLE, home), JSON.stringify({ ownerTopicId: 1, botToken: 'short' }));
    expect(readCredential(BUNDLE, home)).toBeNull();
  });

  it('atomic write — no readable temp file is left behind on success', () => {
    const home = fakeHome();
    writeCredential(BUNDLE, { ownerTopicId: 5447, botToken: VALID_TOKEN }, home);
    const dir = registryDir(home);
    const files = fs.readdirSync(dir);
    expect(files.some((f) => f.includes('.tmp-'))).toBe(false);
  });

  it('rejects path-traversal / invalid bundle ids at the filename layer', () => {
    const home = fakeHome();
    expect(() => writeCredential('../evil', { ownerTopicId: 1, botToken: VALID_TOKEN }, home)).toThrow();
    expect(() => writeCredential('a b', { ownerTopicId: 1, botToken: VALID_TOKEN }, home)).toThrow();
    expect(() => writeCredential('a/b', { ownerTopicId: 1, botToken: VALID_TOKEN }, home)).toThrow();
  });

  it('removeCredential is idempotent', () => {
    const home = fakeHome();
    writeCredential(BUNDLE, { ownerTopicId: 5447, botToken: VALID_TOKEN }, home);
    removeCredential(BUNDLE, home);
    expect(fs.existsSync(credentialPath(BUNDLE, home))).toBe(false);
    // second call doesn't throw
    expect(() => removeCredential(BUNDLE, home)).not.toThrow();
  });

  it('lives outside any project tree (machine-level ~/.instar/registry/)', () => {
    expect(registryDir('/Users/x')).toBe('/Users/x/.instar/registry');
  });

  it('isValidBotToken accepts the canonical shape and rejects junk', () => {
    expect(isValidBotToken(VALID_TOKEN)).toBe(true);
    expect(isValidBotToken('')).toBe(false);
    expect(isValidBotToken(null)).toBe(false);
    expect(isValidBotToken('1:short')).toBe(false);
    expect(isValidBotToken('abc:notnumeric_prefix_too_short_xx')).toBe(false);
  });
});
