/**
 * Unit — a LAPSED grok session that can renew itself must not be refused
 * (grok-build spec §3.1; round-22).
 *
 * THE DEFECT THIS PINS, measured live on 2026-08-15 rather than reasoned:
 * the stored session expired at 17:20Z; at 17:51Z `grok models` reported "You are
 * not authenticated"; a single one-shot completion then succeeded and the stored
 * expiry moved forward six hours with no human involvement. The CLI holds a
 * refresh token and renews LAZILY — only when a command that needs auth runs.
 *
 * Our preflight refused every call on a past expiry and has no renewal path of its
 * own, so the two composed into a deadlock: session lapses → gate refuses →
 * nothing invokes the CLI → the CLI never renews → the gate refuses forever. The
 * reviewer lane went dark after any ~6h idle gap until a human ran grok by hand.
 * Neither half is wrong alone, which is why neither half's tests could see it.
 *
 * The tests below therefore assert a NARROWING, and the last two are the ones
 * that make it a narrowing rather than a hole: the terminal case still refuses,
 * and the independent billing gates still fire on a session this change admits.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  assertGrokAuthAllowed,
  readSessionAuthState,
} from '../../src/providers/adapters/grok-build/policy.js';
import { detectGrokReviewer } from '../../src/core/crossModelReviewer.js';
import {
  GrokSessionExpiredError,
  GrokConfigCredentialForbiddenError,
  GrokApiKeyForbiddenError,
} from '../../src/providers/adapters/grok-build/errors.js';

let home: string;

/** A grok home with the login policy verified, so expiry is the variable under test. */
function makeGrokHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-refresh-'));
  fs.writeFileSync(path.join(dir, 'config.toml'), '[auth]\ndisable_api_key_auth = true\n');
  return dir;
}

function writeAuth(entry: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(home, 'auth.json'),
    JSON.stringify({ 'https://auth.x.ai::test-session': entry }),
  );
}

const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const FUTURE = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

/** An env with no billing variables — the other gates are covered separately. */
const CLEAN_ENV: NodeJS.ProcessEnv = { GROK_DISABLE_API_KEY_AUTH: '1' };

beforeEach(() => { home = makeGrokHome(); });
afterEach(() => {
  SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, sourceTreeOverride: true });
});

describe('readSessionAuthState — expiry and renewability from ONE parse', () => {
  it('reports refreshable when the winning entry carries a renewal credential', () => {
    writeAuth({ expires_at: PAST, auth_mode: 'oidc', refresh_token: 'rt-value' });
    const state = readSessionAuthState(path.join(home, 'auth.json'));
    expect(state.expiry?.toISOString()).toBe(PAST);
    expect(state.refreshable).toBe(true);
  });

  it('reports NOT refreshable when the credential is absent or blank', () => {
    writeAuth({ expires_at: PAST, auth_mode: 'oidc' });
    expect(readSessionAuthState(path.join(home, 'auth.json')).refreshable).toBe(false);
    // The vendor writes the field either way, so an empty string is absence.
    writeAuth({ expires_at: PAST, auth_mode: 'oidc', refresh_token: '   ' });
    expect(readSessionAuthState(path.join(home, 'auth.json')).refreshable).toBe(false);
  });

  it('ties renewability to the WINNING entry, not to any entry in the file', () => {
    // An older session's refresh token says nothing about whether the newest one
    // can be renewed. Getting this wrong would admit a genuinely dead session on
    // the strength of an unrelated credential.
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({
      old: { expires_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), auth_mode: 'oidc', refresh_token: 'rt-old' },
      current: { expires_at: PAST, auth_mode: 'oidc' },
    }));
    const state = readSessionAuthState(path.join(home, 'auth.json'));
    expect(state.expiry?.toISOString()).toBe(PAST); // the newer one wins
    expect(state.refreshable).toBe(false);          // and it has nothing to renew from
  });

  it('an unreadable file reports neither an expiry nor renewability', () => {
    expect(readSessionAuthState(path.join(home, 'does-not-exist.json')))
      .toEqual({ expiry: null, refreshable: false });
  });
});

describe('assertGrokAuthAllowed — lapsed-but-renewable is ADMITTED', () => {
  it('admits a lapsed session that carries a renewal credential', () => {
    writeAuth({ expires_at: PAST, auth_mode: 'oidc', refresh_token: 'rt-value' });
    // The deadlock: before round-22 this threw, and the throw is what prevented
    // the only call that would have renewed the session.
    expect(() => assertGrokAuthAllowed({ grokHome: home } as never, CLEAN_ENV)).not.toThrow();
  });

  it('CONTROL: still refuses a lapsed session with nothing to renew from', () => {
    writeAuth({ expires_at: PAST, auth_mode: 'oidc' });
    expect(() => assertGrokAuthAllowed({ grokHome: home } as never, CLEAN_ENV))
      .toThrow(GrokSessionExpiredError);
  });

  it('CONTROL: still refuses when the auth file has no parseable expiry', () => {
    fs.writeFileSync(path.join(home, 'auth.json'), 'not json at all');
    expect(() => assertGrokAuthAllowed({ grokHome: home } as never, CLEAN_ENV))
      .toThrow(GrokSessionExpiredError);
  });

  it('admits an unexpired session (no regression from the narrowing)', () => {
    writeAuth({ expires_at: FUTURE, auth_mode: 'oidc' });
    expect(() => assertGrokAuthAllowed({ grokHome: home } as never, CLEAN_ENV)).not.toThrow();
  });
});

describe('the SECOND boundary — reviewer detection (the gate that runs first)', () => {
  /**
   * The transport preflight is not the only expiry gate. `detectGrokReviewer`
   * has its own, and it runs EARLIER — so fixing only the preflight would have
   * left the reviewer door shut on a lapsed session, the transport never
   * reached, the CLI never invoked, and the deadlock exactly where it was.
   *
   * This is the round-20 shape verbatim: a fact carried correctly across one
   * boundary and dropped at the next. I found it by checking the SEVERITY claim
   * I had already reported ("the grok reviewer goes dark") against the code,
   * after reporting the fix as done. The lesson is about a fix's REACH, not its
   * correctness — the preflight change was right and insufficient.
   */
  const ENABLED = ['grok-build'];

  it('admits a lapsed-but-renewable session at the detection gate', () => {
    writeAuth({ expires_at: PAST, auth_mode: 'oidc', refresh_token: 'rt-value' });
    const r = detectGrokReviewer({
      grokPathDetected: '/bin/echo',
      grokAuthPath: path.join(home, 'auth.json'),
      enabledFrameworks: ENABLED,
      env: CLEAN_ENV,
    });
    expect(r).toMatchObject({ available: true, framework: 'grok-build' });
  });

  it('CONTROL: a lapsed session with nothing to renew from is still not-authed', () => {
    writeAuth({ expires_at: PAST, auth_mode: 'oidc' });
    const r = detectGrokReviewer({
      grokPathDetected: '/bin/echo',
      grokAuthPath: path.join(home, 'auth.json'),
      enabledFrameworks: ENABLED,
      env: CLEAN_ENV,
    });
    expect(r).toMatchObject({ available: false, reason: 'grok-not-authed' });
  });

  it('CONTROL: the opt-in gate still closes the door regardless of renewability', () => {
    // The narrowing must not have made the reviewer reachable without opt-in —
    // that would be a dark-ship break bought with an availability fix.
    writeAuth({ expires_at: PAST, auth_mode: 'oidc', refresh_token: 'rt-value' });
    const r = detectGrokReviewer({
      grokPathDetected: '/bin/echo',
      grokAuthPath: path.join(home, 'auth.json'),
      env: CLEAN_ENV,
    });
    expect(r).toMatchObject({ available: false, reason: 'grok-not-enabled' });
  });
});

describe('the narrowing is not a bypass — independent gates still fire', () => {
  /**
   * These are the assertions that make the change defensible. The argument for
   * admitting a lapsed session is that the expiry check never carried the billing
   * guarantee — four other mechanisms do. If admitting also softened THEM, that
   * argument would be false. So each is exercised against the exact session state
   * this change now admits: lapsed, with a renewal credential.
   */
  it('a metered key in the environment is still refused on an admitted session', () => {
    writeAuth({ expires_at: PAST, auth_mode: 'oidc', refresh_token: 'rt-value' });
    expect(() => assertGrokAuthAllowed(
      { grokHome: home } as never,
      { ...CLEAN_ENV, XAI_API_KEY: 'sk-test-not-a-real-key' },
    )).toThrow(GrokApiKeyForbiddenError);
  });

  it('a credential in config.toml is still refused on an admitted session', () => {
    writeAuth({ expires_at: PAST, auth_mode: 'oidc', refresh_token: 'rt-value' });
    fs.writeFileSync(
      path.join(home, 'config.toml'),
      '[auth]\ndisable_api_key_auth = true\napi_key = "sk-test-not-a-real-key"\n',
    );
    expect(() => assertGrokAuthAllowed({ grokHome: home } as never, CLEAN_ENV))
      .toThrow(GrokConfigCredentialForbiddenError);
  });

  it('an api-key-mode entry is still ignored, so it cannot green the gate', () => {
    // auth_mode-aware skipping predates round-22 and must survive it: a key-mode
    // entry must not satisfy a subscription-session gate even holding a refresh
    // token. With it skipped there is no usable entry, so the refusal stands.
    writeAuth({ expires_at: FUTURE, auth_mode: 'api_key', refresh_token: 'rt-value' });
    expect(() => assertGrokAuthAllowed({ grokHome: home } as never, CLEAN_ENV))
      .toThrow(GrokSessionExpiredError);
  });
});
