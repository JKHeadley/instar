/**
 * Unit tests for PairingSessionStore — persists the active pairing session so
 * the running server's /api/pair handler can validate a join code (the fix for
 * the unused-`_pairingSession` gap that left pairing interactive-SAS-only).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PairingSessionStore } from '../../src/core/PairingSessionStore.js';
import { createPairingSession } from '../../src/core/PairingProtocol.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('PairingSessionStore', () => {
  let dir: string;
  let store: PairingSessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-store-'));
    store = new PairingSessionStore(dir);
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/pairing-session-store.test.ts:afterEach' });
  });

  it('returns null when no session is stored', () => {
    expect(store.load()).toBeNull();
  });

  it('persists and reloads the validation-relevant fields', () => {
    const session = createPairingSession({ code: 'VIPER-PLAIN-3738', expiryMs: 600000 });
    store.save(session);
    const loaded = store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.code).toBe('VIPER-PLAIN-3738');
    expect(loaded!.consumed).toBe(false);
    expect(loaded!.maxAttempts).toBe(session.maxAttempts);
    expect(loaded!.expiryMs).toBe(600000);
  });

  it('does NOT persist the ephemeral private key (not JSON-serializable / not needed for code auth)', () => {
    const session = createPairingSession({ code: 'ABLE-NOVA-1111' });
    store.save(session);
    const raw = fs.readFileSync(path.join(dir, 'machine', 'pairing-session.json'), 'utf-8');
    expect(raw).not.toContain('ephemeralKeys');
    expect(raw).not.toContain('privateKey');
  });

  it('writes the session file with 0600 permissions (the code is a shared secret)', () => {
    store.save(createPairingSession({ code: 'ZULU-IRON-2222' }));
    const mode = fs.statSync(path.join(dir, 'machine', 'pairing-session.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('overwrites a prior session (a new `instar pair` invalidates the old code)', () => {
    store.save(createPairingSession({ code: 'OLD-CODE-0001' }));
    store.save(createPairingSession({ code: 'NEW-CODE-0002' }));
    expect(store.load()!.code).toBe('NEW-CODE-0002');
  });

  it('survives a malformed file (returns null rather than throwing)', () => {
    fs.mkdirSync(path.join(dir, 'machine'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'machine', 'pairing-session.json'), 'not json{');
    expect(store.load()).toBeNull();
  });
});
