/**
 * OAuthRefresher — mint a fresh Claude Code OAuth access token from its stored
 * refresh token, so the QuotaPoller never falsely flags a still-valid login as
 * `needs-reauth` (P1.2 hardening of the Subscription & Auth Standard).
 *
 * ── Why this exists (the bug it fixes) ──
 * A Claude Code login holds TWO tokens in its config home's credential store:
 *   - a short-lived ACCESS token (`sk-ant-oat…`, ~8–12h), and
 *   - a long-lived REFRESH token (`sk-ant-ort…`, weeks→months).
 * The `claude` client silently exchanges the refresh token for a new access
 * token on every real use. The QuotaPoller reads the access token out-of-band
 * and calls the usage endpoint directly — so when the access token has expired
 * (which is routine, daily) but the refresh token is still perfectly valid, the
 * usage read returns 401 and the poller wrongly marks the account `needs-reauth`.
 * That cried wolf: the login is intact, only the access token lapsed. This module
 * performs the same refresh-token exchange the client does, so a routine expiry
 * recovers silently and `needs-reauth` is reserved for a genuinely dead login
 * (refresh token revoked / password change) — exactly what SubscriptionPool's
 * status comment already promises.
 *
 * ── Corruption safety (the load-bearing invariant) ──
 * The ONLY way this module could harm a working login is by writing a bad
 * credential back. So the write is gated three ways:
 *   1. it happens ONLY on a fully-validated 200 response (new access token shaped
 *      `sk-ant-oat…`, a positive numeric `expires_in`);
 *   2. it is a READ-MERGE-WRITE — the existing credential JSON is re-read and only
 *      the access token / refresh token / expiry are overwritten, so scopes,
 *      subscriptionType, rateLimitTier and any unknown fields are preserved; and
 *   3. if the server rotates the refresh token, the NEW one is persisted; if the
 *      response omits a refresh token (non-rotating server), the existing one is
 *      kept — never dropped.
 * A wrong endpoint / client id / network failure can therefore only ever make the
 * exchange FAIL (→ the caller's existing `needs-reauth` path), never corrupt.
 *
 * Token values are NEVER logged or returned to any persisted surface. The OAuth
 * token endpoint + client id are the public Claude Code values, extracted from
 * the official client binary (verified 2026-06-08).
 *
 * Testability: the credential store, the fetch surface, and the clock are all
 * injectable, so the whole refresh runs hermetically with zero keychain, zero
 * network, and a deterministic clock in tests.
 */

import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { CredentialWriteFunnel, credentialWriteFunnel } from './CredentialWriteFunnel.js';

/** Promisified async exec for the non-blocking keychain read (mirrors the sync `security` spawn). */
const execFileAsync = promisify(execFile);

/**
 * Bounds any `security` keychain spawn so a slow/contended `securityd` can never freeze the event
 * loop indefinitely. The macOS keychain read/write is an out-of-process spawn; under multi-agent
 * `securityd` contention an un-timeout'd SYNC spawn blocked the event loop 4–13s every cycle
 * (the dashboard-flap / false-sleep incident). 3s is generous for a healthy keychain and a hard
 * ceiling for a wedged one. The sibling CredentialProvider keychain spawns already set a timeout.
 */
const KEYCHAIN_TIMEOUT_MS = 3000;

/** Public Claude Code OAuth token endpoint (from the official client binary). */
export const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
/** Public Claude Code OAuth client id (from the official client binary). */
export const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

const ACCESS_PREFIX = 'sk-ant-oat';
const REFRESH_PREFIX = 'sk-ant-ort';

export type RefreshFailReason =
  | 'unsupported-account' // not an anthropic/claude-code account
  | 'read-failed' // credential store unreadable / unparseable
  | 'no-refresh-token' // no refresh token present → genuine re-auth needed
  | 'exchange-failed' // the OAuth token endpoint rejected / was unreachable
  | 'malformed-response' // 200 but the response wasn't a usable credential
  | 'write-failed' // exchange ok but the new credential couldn't be persisted
  | 'write-skipped'; // exchange ok but the per-slot funnel lock was busy — transient, RETRY (never needs-reauth)

export type RefreshResult =
  | { ok: true; accessToken: string; expiresAt: number; rotated: boolean }
  | { ok: false; reason: RefreshFailReason; status?: number };

/** The OAuth access + refresh tokens parsed out of a credential store entry. */
export interface ClaudeOauth {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  [k: string]: unknown;
}

/**
 * A credential store for one config home. `read` returns the RAW JSON string of
 * the stored entry (so the refresher can merge-preserve every field); `write`
 * persists a replacement raw JSON string. Injectable so tests use a fake.
 */
export interface CredentialStore {
  read(configHome: string): string | null;
  write(configHome: string, rawJson: string): boolean;
  /**
   * Optional NON-BLOCKING read. When present, callers on the event-loop hot path (e.g. the
   * sequential credential-audit loop) should prefer this so a slow/contended `securityd` keychain
   * read yields the event loop instead of freezing it. Optional so existing mocks that only
   * implement the sync `read` keep compiling; `readClaudeOauthAsync` falls back to `read` when a
   * store omits it.
   */
  readAsync?(configHome: string): Promise<string | null>;
  /**
   * Optional NON-BLOCKING write. Mirror of `readAsync` for the write half of the refresh
   * read-merge-write: a slow/contended `securityd` keychain WRITE (`add-generic-password`) is an
   * out-of-process spawn that, run synchronously, blocked the event loop just like the read — and
   * the refresh path issues a read AND a write per cycle. When present, `refreshClaudeToken` prefers
   * this so the write yields the loop instead of freezing it. Optional so existing mocks that only
   * implement the sync `write` keep compiling; the refresher falls back to `write` when omitted.
   */
  writeAsync?(configHome: string, rawJson: string): Promise<boolean>;
}

/** POST-capable fetch surface (distinct from QuotaPoller's GET-only FetchImpl). */
export type RefreshFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface RefreshDeps {
  store?: CredentialStore;
  fetchImpl?: RefreshFetch;
  now?: () => number;
  tokenUrl?: string;
  clientId?: string;
  /**
   * The credential-write funnel (Step 4b). The token write is serialized through
   * `withSlotLock(configHome, …)` so a refresh write can never interleave with a
   * swap (Step 5) or another refresh on the SAME slot. Defaults to the process-wide
   * `credentialWriteFunnel` singleton; tests inject their own to assert serialization.
   */
  funnel?: CredentialWriteFunnel;
}

export function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return path.join(process.env.HOME ?? '', p.slice(1));
  }
  return p;
}

/**
 * Canonical per-slot lock key for a config home (Step 4b). The funnel keys its per-slot lock on
 * THIS string, so two writers to the SAME keychain entry must derive the SAME key regardless of
 * how the home was spelled. `path.resolve` over the home-expanded path strips a trailing slash and
 * collapses `.`/`..` so `~/.claude` and `~/.claude/` (or `/h/.claude` and `/h/./.claude`) map to one
 * lock — closing the string-identity race a refresh and a switch could otherwise have on the same
 * account (second-pass review, 2026-06-13).
 */
export function credentialSlotKey(configHome: string): string {
  return path.resolve(expandHome(configHome));
}

/**
 * macOS keychain service name for a config home's Claude Code credentials.
 * The default home (`~/.claude`) has no hash suffix; every other config home is
 * suffixed with the first 8 hex of sha256(configHome) — verified empirically and
 * matched by the official client.
 */
export function claudeCredentialService(configHome: string): string {
  const home = expandHome(configHome);
  const defaultHome = expandHome('~/.claude');
  return home === defaultHome
    ? 'Claude Code-credentials'
    : `Claude Code-credentials-${crypto.createHash('sha256').update(home).digest('hex').slice(0, 8)}`;
}

/** Non-darwin credential file for a config home. */
export function claudeCredentialFilePath(configHome: string): string {
  return path.join(expandHome(configHome), '.credentials.json');
}

/** Default store: macOS keychain, else a per-config-home credentials file. */
export const defaultCredentialStore: CredentialStore = {
  read(configHome: string): string | null {
    if (process.platform === 'darwin') {
      try {
        const raw = execFileSync(
          'security',
          ['find-generic-password', '-s', claudeCredentialService(configHome), '-w'],
          { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: KEYCHAIN_TIMEOUT_MS },
        ).trim();
        return raw || null;
      } catch {
        return null; // @silent-fallback-ok: no keychain entry / timeout → unreadable (caller retries → needs-reauth)
      }
    }
    try {
      const p = claudeCredentialFilePath(configHome);
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
    } catch {
      return null; // @silent-fallback-ok: missing/unreadable creds file
    }
  },
  /**
   * NON-BLOCKING read: the same lookup as `read` but off the event loop. On darwin it uses the
   * PROMISIFIED async `execFile` (so a slow `securityd` yields instead of freezing the loop); on
   * non-darwin it uses `fs.promises.readFile`. Same `find-generic-password` args + same 3s timeout
   * + same null-on-error semantics as the sync read.
   */
  async readAsync(configHome: string): Promise<string | null> {
    if (process.platform === 'darwin') {
      try {
        // Promisified `execFile` captures stdout/stderr into buffers (no `stdio` option — stderr is
        // captured then ignored, matching the sync read's stderr suppression). encoding:'utf-8'
        // gives a string stdout.
        const { stdout } = await execFileAsync(
          'security',
          ['find-generic-password', '-s', claudeCredentialService(configHome), '-w'],
          { encoding: 'utf-8', timeout: KEYCHAIN_TIMEOUT_MS },
        );
        const raw = stdout.trim();
        return raw || null;
      } catch {
        return null; // @silent-fallback-ok: no keychain entry / timeout → unreadable (caller retries → needs-reauth)
      }
    }
    try {
      const p = claudeCredentialFilePath(configHome);
      return await fs.promises.readFile(p, 'utf-8');
    } catch {
      return null; // @silent-fallback-ok: missing/unreadable creds file
    }
  },
  write(configHome: string, rawJson: string): boolean {
    if (process.platform === 'darwin') {
      try {
        execFileSync(
          'security',
          [
            'add-generic-password',
            '-U', // update the existing entry in place
            '-a',
            os.userInfo().username,
            '-s',
            claudeCredentialService(configHome),
            '-w',
            rawJson,
          ],
          { stdio: ['ignore', 'ignore', 'ignore'], timeout: KEYCHAIN_TIMEOUT_MS },
        );
        return true;
      } catch {
        return false; // @silent-fallback-ok: keychain write failed / timeout → caller falls to needs-reauth
      }
    }
    try {
      const p = claudeCredentialFilePath(configHome);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, rawJson, { mode: 0o600 });
      return true;
    } catch {
      return false; // @silent-fallback-ok: file write failed
    }
  },
  /**
   * NON-BLOCKING write: the same `add-generic-password` keychain write as `write` but off the event
   * loop (PROMISIFIED `execFile` on darwin, `fs.promises` on non-darwin). Same args, same 3s timeout,
   * same false-on-error semantics. Lets the refresh write yield a slow `securityd` instead of freezing
   * the loop — the write half of the read-merge-write the QuotaPoller's refresher runs per cycle.
   */
  async writeAsync(configHome: string, rawJson: string): Promise<boolean> {
    if (process.platform === 'darwin') {
      try {
        await execFileAsync(
          'security',
          [
            'add-generic-password',
            '-U', // update the existing entry in place
            '-a',
            os.userInfo().username,
            '-s',
            claudeCredentialService(configHome),
            '-w',
            rawJson,
          ],
          { timeout: KEYCHAIN_TIMEOUT_MS },
        );
        return true;
      } catch {
        return false; // @silent-fallback-ok: keychain write failed / timeout → caller falls to needs-reauth
      }
    }
    try {
      const p = claudeCredentialFilePath(configHome);
      await fs.promises.mkdir(path.dirname(p), { recursive: true });
      await fs.promises.writeFile(p, rawJson, { mode: 0o600 });
      return true;
    } catch {
      return false; // @silent-fallback-ok: file write failed
    }
  },
};

/** Parse the `claudeAiOauth` block out of a config home's credential store. */
export function readClaudeOauth(
  configHome: string,
  store: CredentialStore = defaultCredentialStore,
): ClaudeOauth | null {
  const raw = store.read(configHome);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const oauth = parsed?.claudeAiOauth;
    return oauth && typeof oauth === 'object' ? (oauth as ClaudeOauth) : null;
  } catch {
    return null; // @silent-fallback-ok: unparseable entry
  }
}

/**
 * NON-BLOCKING mirror of `readClaudeOauth`: identical parse logic, but reads the raw blob via the
 * store's optional `readAsync` (off the event loop) when available, falling back to the sync `read`
 * for any store that doesn't implement it (backward-compatible). This is the read callers on the
 * event-loop hot path (e.g. the sequential credential-audit loop) should use so a slow/contended
 * `securityd` keychain read yields the loop instead of freezing it.
 */
export async function readClaudeOauthAsync(
  configHome: string,
  store: CredentialStore = defaultCredentialStore,
): Promise<ClaudeOauth | null> {
  const raw = store.readAsync ? await store.readAsync(configHome) : store.read(configHome);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const oauth = parsed?.claudeAiOauth;
    return oauth && typeof oauth === 'object' ? (oauth as ClaudeOauth) : null;
  } catch {
    return null; // @silent-fallback-ok: unparseable entry
  }
}

/**
 * Refresh a config home's Claude Code access token from its stored refresh token.
 * Returns the new access token + expiry on success; otherwise a typed failure
 * reason the caller maps to its `needs-reauth` decision. Writes NOTHING on any
 * failure — a working login is never put at risk by an unsuccessful refresh.
 */
export async function refreshClaudeToken(
  configHome: string,
  deps: RefreshDeps = {},
): Promise<RefreshResult> {
  const store = deps.store ?? defaultCredentialStore;
  const fetchImpl: RefreshFetch =
    deps.fetchImpl ??
    ((url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<RefreshFetch>);
  const now = deps.now ?? (() => Date.now());
  const tokenUrl = deps.tokenUrl ?? CLAUDE_TOKEN_URL;
  const clientId = deps.clientId ?? CLAUDE_CODE_CLIENT_ID;
  const funnel = deps.funnel ?? credentialWriteFunnel;

  // NON-BLOCKING read: prefer the store's async keychain read so a slow/contended `securityd`
  // yields the event loop instead of freezing it (this runs per-account on the QuotaPoller timer).
  // Falls back to the sync `read` for any store that doesn't implement `readAsync` (test mocks).
  const raw = store.readAsync ? await store.readAsync(configHome) : store.read(configHome);
  if (!raw) return { ok: false, reason: 'read-failed' };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'read-failed' };
  }
  const oauth = (parsed?.claudeAiOauth ?? null) as ClaudeOauth | null;
  const refreshToken = oauth?.refreshToken;
  if (typeof refreshToken !== 'string' || !refreshToken) {
    return { ok: false, reason: 'no-refresh-token' };
  }

  let res: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    res = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    });
  } catch {
    return { ok: false, reason: 'exchange-failed' };
  }
  if (!res.ok) return { ok: false, reason: 'exchange-failed', status: res.status };

  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'malformed-response' };
  }

  const newAccess = data?.access_token;
  const expiresIn = data?.expires_in;
  if (typeof newAccess !== 'string' || !newAccess.startsWith(ACCESS_PREFIX)) {
    return { ok: false, reason: 'malformed-response' };
  }
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return { ok: false, reason: 'malformed-response' };
  }

  const newRefresh = data?.refresh_token;
  const rotated =
    typeof newRefresh === 'string' &&
    newRefresh.startsWith(REFRESH_PREFIX) &&
    newRefresh !== refreshToken;

  const expiresAt = now() + expiresIn * 1000;
  // READ-MERGE-WRITE: preserve every existing field, overwrite only the tokens
  // + expiry. Keep the old refresh token if the server didn't rotate.
  const updatedOauth: ClaudeOauth = {
    ...oauth,
    accessToken: newAccess,
    refreshToken:
      typeof newRefresh === 'string' && newRefresh.startsWith(REFRESH_PREFIX)
        ? newRefresh
        : refreshToken,
    expiresAt,
  };
  const updatedRaw = { ...parsed, claudeAiOauth: updatedOauth };

  // Serialize the write through the per-slot funnel (Step 4b): a refresh write can never
  // interleave with a swap or another refresh on the SAME configHome slot. A lock-timeout is
  // NOT a corruption — it is "busy, retry": surface 'write-skipped' so the QuotaPoller treats it
  // as no-snapshot-this-cycle, NEVER needs-reauth. The exchange already succeeded; the existing
  // (still-valid) credential is untouched.
  // NON-BLOCKING write: prefer the store's async keychain write (off the event loop) so the write
  // half of this read-merge-write yields a slow `securityd` instead of freezing the loop. Falls back
  // to the sync `write` for any store that doesn't implement `writeAsync` (test mocks). The funnel's
  // per-slot lock already serializes against a concurrent swap/refresh on the SAME slot regardless.
  const writeOutcome = await funnel.withSlotLock(credentialSlotKey(configHome), () =>
    store.writeAsync
      ? store.writeAsync(configHome, JSON.stringify(updatedRaw))
      : store.write(configHome, JSON.stringify(updatedRaw)),
  );
  if (!writeOutcome.ran) {
    return { ok: false, reason: 'write-skipped' };
  }
  if (!writeOutcome.value) {
    return { ok: false, reason: 'write-failed' };
  }
  return { ok: true, accessToken: newAccess, expiresAt, rotated };
}
