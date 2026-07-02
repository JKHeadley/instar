/**
 * silent-loss-refusal-conservation §2.D — TEST_IDENTITY_MARKERS matcher + the
 * signed allow-marker. Match rule: exact platform ids + anchored reserved-token
 * prefixes — DISPLAY NAME IS NEVER A CRITERION. The signed allow-marker is minted
 * with the server key and load-verified with no PIN; a data-only forge is rejected.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import os from 'node:os';
import path from 'node:path';
import {
  matchTestIdentity,
  matchesTestIdentityToken,
  TEST_IDENTITY_MARKERS,
  testIdentitiesAllowed,
  signAllowTestIdentity,
  verifyAllowTestIdentity,
  TEST_HOME_MARKER_FILENAME,
} from '../../src/users/testIdentityMarkers.js';

describe('§2.D fixture-identity matcher', () => {
  it('matches the known Slack fixture ids exactly (on slackUserId + slack channels)', () => {
    for (const id of TEST_IDENTITY_MARKERS.slackIds) {
      expect(matchTestIdentity({ id: 'real-id', slackUserId: id, channels: [] })).toBe(id);
      expect(matchTestIdentity({ id: 'real-id', channels: [{ type: 'slack', identifier: id }] })).toBe(id);
    }
  });

  it('matches the harness u-* / U_* ids exactly on the profile id', () => {
    for (const id of TEST_IDENTITY_MARKERS.harnessIds) {
      expect(matchTestIdentity({ id, channels: [] })).toBe(id);
    }
  });

  it('matches anchored reserved-token prefixes (livetest / g3test), case-insensitively', () => {
    expect(matchesTestIdentityToken('livetest-123')).toBe('livetest-123');
    expect(matchesTestIdentityToken('g3test_abc')).toBe('g3test_abc');
    expect(matchesTestIdentityToken('LiveTest-X')).toBe('LiveTest-X');
    // NOT anchored → no match (the token must START with the reserved prefix).
    expect(matchesTestIdentityToken('my-livetest')).toBeNull();
  });

  it('legitimate-user-named-Olivia-registers: DISPLAY NAME is never a criterion', () => {
    // A real user whose display name is "Olivia" / "u-olivia"-looking name but a real id.
    expect(matchTestIdentity({ id: 'tg-88812345', channels: [] })).toBeNull();
    // The harness fixture is `u-olivia` (the ID) — a real id that merely contains "olivia" does not match.
    expect(matchTestIdentity({ id: 'olivia-realsmith', channels: [] })).toBeNull();
  });

  it('a plain real id/slackId does not match', () => {
    expect(matchTestIdentity({ id: 'tg-12345', slackUserId: 'U07REALUSER', channels: [] })).toBeNull();
  });
});

describe('§2.D double-keyed test escape', () => {
  it('env alone (no on-disk marker) → NOT allowed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slrc-esc-'));
    try {
      expect(testIdentitiesAllowed(dir, { INSTAR_ALLOW_TEST_IDENTITIES: '1' } as NodeJS.ProcessEnv)).toBe(false);
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test-cleanup' }); }
  });

  it('env + on-disk test-home marker → allowed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slrc-esc-'));
    try {
      fs.writeFileSync(path.join(dir, TEST_HOME_MARKER_FILENAME), '');
      expect(testIdentitiesAllowed(dir, { INSTAR_ALLOW_TEST_IDENTITIES: '1' } as NodeJS.ProcessEnv)).toBe(true);
      // marker present but env absent → NOT allowed
      expect(testIdentitiesAllowed(dir, {} as NodeJS.ProcessEnv)).toBe(false);
    } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test-cleanup' }); }
  });
});

describe('§2.D signed allow-marker', () => {
  const KEY = 'server-held-key-abc';
  it('a minted marker verifies under the same key with NO PIN', () => {
    const sig = signAllowTestIdentity(KEY, 'u-olivia', 'u-olivia');
    expect(verifyAllowTestIdentity(KEY, 'u-olivia', 'u-olivia', { marker: 'u-olivia', sig })).toBe(true);
  });

  it('forged-allow-marker-rejected: a bogus/absent sig does not verify (a data-only users.json write cannot forge it)', () => {
    expect(verifyAllowTestIdentity(KEY, 'u-olivia', 'u-olivia', { marker: 'u-olivia', sig: 'deadbeef' })).toBe(false);
    expect(verifyAllowTestIdentity(KEY, 'u-olivia', 'u-olivia', { marker: 'u-olivia', sig: '' })).toBe(false);
    // @ts-expect-error — a missing sig field
    expect(verifyAllowTestIdentity(KEY, 'u-olivia', 'u-olivia', { marker: 'u-olivia' })).toBe(false);
    expect(verifyAllowTestIdentity(KEY, 'u-olivia', 'u-olivia', undefined)).toBe(false);
  });

  it('a marker minted for a DIFFERENT userId does not verify (sig binds userId+marker)', () => {
    const sig = signAllowTestIdentity(KEY, 'u-olivia', 'u-olivia');
    expect(verifyAllowTestIdentity(KEY, 'u-adam', 'u-olivia', { marker: 'u-olivia', sig })).toBe(false);
  });

  it('the marker field must equal the matched marker', () => {
    const sig = signAllowTestIdentity(KEY, 'u-olivia', 'u-olivia');
    expect(verifyAllowTestIdentity(KEY, 'u-olivia', 'u-mia', { marker: 'u-olivia', sig })).toBe(false);
  });

  it('no server key → verification always fails (safe direction)', () => {
    const sig = signAllowTestIdentity(KEY, 'u-olivia', 'u-olivia');
    expect(verifyAllowTestIdentity(undefined, 'u-olivia', 'u-olivia', { marker: 'u-olivia', sig })).toBe(false);
  });
});
