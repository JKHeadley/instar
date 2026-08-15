/**
 * Codex slot identity — the missing half of subscription-pool enrolment.
 *
 * The pool refuses to enrol an account whose slot identity cannot be verified.
 * The existing oracle answers that by calling Anthropic's OAuth profile endpoint,
 * so handed a Codex home it fails `email-unresolved` — which is exactly why the
 * pool held 6 anthropic accounts and 0 codex ones while both Codex logins sat
 * authenticated on disk.
 *
 * These pin the reader that closes it, and — because it parses a credential file —
 * pin hard that no token material can escape through a result or an error.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCodexSlotIdentity } from '../../src/providers/adapters/openai-codex/codexSlotIdentity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/** A recognisable, obviously-fake secret. If it ever appears in output, that is a leak. */
const CANARY = 'SECRET-TOKEN-MATERIAL-DO-NOT-LEAK-2f9a1c';

function b64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o), 'utf-8').toString('base64url');
}

/** Build an id_token shaped like the real one: header.payload.signature. */
function idToken(payload: Record<string, unknown>): string {
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.${CANARY}`;
}

function makeHome(
  dir: string,
  opts: { email?: string; accountId?: string; plan?: string; authJson?: unknown; idTokenRaw?: string } = {},
): string {
  const home = fs.mkdtempSync(path.join(dir, 'codex-home-'));
  const payload: Record<string, unknown> = {
    email: opts.email ?? 'someone@example.com',
    email_verified: true,
    'https://api.openai.com/auth': {
      chatgpt_plan_type: opts.plan ?? 'pro',
      chatgpt_account_id: opts.accountId ?? 'acct-from-claim',
    },
  };
  const body =
    opts.authJson !== undefined
      ? opts.authJson
      : {
          auth_mode: 'chatgpt',
          OPENAI_API_KEY: null,
          tokens: {
            id_token: opts.idTokenRaw ?? idToken(payload),
            access_token: CANARY,
            refresh_token: CANARY,
            ...(opts.accountId ? { account_id: opts.accountId } : {}),
          },
          last_refresh: '2026-08-15T00:00:00.000Z',
        };
  fs.writeFileSync(
    path.join(home, 'auth.json'),
    typeof body === 'string' ? body : JSON.stringify(body),
  );
  return home;
}

describe('readCodexSlotIdentity', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-identity-'));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmp, {
      recursive: true,
      force: true,
      operation: 'tests/unit/codex-slot-identity.test.ts:cleanup',
    });
  });

  it('reads email, account id and plan from a real-shaped credential', () => {
    const home = makeHome(tmp, { email: 'a@example.com', accountId: 'acct-a', plan: 'pro' });
    const id = readCodexSlotIdentity(home);
    expect(id.unavailable).toBe(false);
    expect(id.email).toBe('a@example.com');
    expect(id.accountId).toBe('acct-a');
    expect(id.planType).toBe('pro');
  });

  it('THE ENROLMENT PROPERTY: two different logins resolve to different identities', () => {
    // This is what the pool's duplicate guard needs. If both homes reported the
    // same identity, two pool rows could silently point at one login and a "swap
    // to the other account" would be a swap to itself.
    const a = makeHome(tmp, { email: 'a@example.com', accountId: 'acct-a' });
    const b = makeHome(tmp, { email: 'b@example.com', accountId: 'acct-b' });
    const ia = readCodexSlotIdentity(a);
    const ib = readCodexSlotIdentity(b);
    expect(ia.email).not.toBe(ib.email);
    expect(ia.accountId).not.toBe(ib.accountId);
  });

  it('prefers the credential file account_id over the token claim', () => {
    // Both name the same account; the file is the more direct source.
    const home = makeHome(tmp, { accountId: 'acct-from-file' });
    expect(readCodexSlotIdentity(home).accountId).toBe('acct-from-file');
  });

  it('SECURITY: no token material reaches the result', () => {
    const home = makeHome(tmp, { email: 'a@example.com' });
    const id = readCodexSlotIdentity(home);
    expect(JSON.stringify(id)).not.toContain(CANARY);
    // Control: the canary really IS in the file being read, so a clean result is
    // a measurement rather than a test that could never have failed.
    expect(fs.readFileSync(path.join(home, 'auth.json'), 'utf-8')).toContain(CANARY);
  });

  it('SECURITY: a corrupt credential yields a reason, never file bytes', () => {
    const home = makeHome(tmp, { authJson: `{ not json ${CANARY}` });
    const id = readCodexSlotIdentity(home);
    expect(id.unavailable).toBe(true);
    expect(id.reason).toBe('auth-file-unreadable');
    expect(JSON.stringify(id)).not.toContain(CANARY);
  });

  it('names each way a slot can fail to identify itself', () => {
    const missing = path.join(tmp, 'no-such-home');
    expect(readCodexSlotIdentity(missing)).toMatchObject({ unavailable: true, reason: 'auth-file-missing' });

    const noToken = makeHome(tmp, { authJson: { auth_mode: 'chatgpt', tokens: {} } });
    expect(readCodexSlotIdentity(noToken)).toMatchObject({ unavailable: true, reason: 'no-id-token' });

    const badJwt = makeHome(tmp, { idTokenRaw: 'not-a-jwt' });
    expect(readCodexSlotIdentity(badJwt)).toMatchObject({ unavailable: true, reason: 'id-token-malformed' });

    const noEmail = makeHome(tmp, { idTokenRaw: idToken({ sub: 'x' }) });
    expect(readCodexSlotIdentity(noEmail)).toMatchObject({ unavailable: true, reason: 'no-email-claim' });
  });

  it('never throws, whatever the file contains', () => {
    // The enrolment path must get an answer, not an exception.
    for (const authJson of [null, 42, [], 'plain string', { tokens: 'not-an-object' }, { tokens: { id_token: 5 } }]) {
      const home = makeHome(tmp, { authJson });
      expect(() => readCodexSlotIdentity(home)).not.toThrow();
      expect(readCodexSlotIdentity(home).unavailable).toBe(true);
    }
  });
});
