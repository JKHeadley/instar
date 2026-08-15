/**
 * Who is signed in at a Codex credential slot?
 *
 * The subscription pool refuses to enrol an account whose slot identity cannot be
 * verified — that guard is what stops two pool entries silently pointing at the
 * same login. The existing oracle answers this by calling Anthropic's OAuth
 * profile endpoint, so it can only ever speak for a claude-code slot; handed a
 * Codex home it fails `email-unresolved`, which is why Codex accounts could not
 * be enrolled at all.
 *
 * A Codex slot answers the same question WITHOUT a network call: `auth.json`
 * carries an OIDC id_token whose payload holds the account's email, a stable
 * per-account id, and the plan tier.
 *
 * ## Why the token is decoded and not verified
 *
 * This is deliberate and is NOT authentication. We are reading the identity of a
 * credential this machine already holds, to label a pool row — the token is not a
 * bearer presented by some caller whose claims must be doubted. Anyone able to
 * edit `auth.json` can already use the credential itself, so signature
 * verification would add no protection against them. Verification would, though,
 * require the issuer's public keys over the network, which is exactly the
 * dependency that makes the Anthropic oracle unable to answer offline.
 *
 * The identity it yields is therefore an ASSERTION about a local file, and is
 * used only to name and de-duplicate pool rows. It is never a permission.
 *
 * ## What never leaves this module
 *
 * No token material — id_token, access_token, refresh_token, API key — is
 * returned, logged, or included in an error. The result carries an email, an
 * account id, and a plan string. A test asserts a token planted in the file
 * appears in no field of the result and in no thrown message.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface CodexSlotIdentity {
  /** The signed-in account's email, or null when the slot cannot say. */
  email: string | null;
  /** Stable per-account id — distinct logins have distinct ids. */
  accountId: string | null;
  /** Plan tier as the token reports it (e.g. 'pro'). Advisory only. */
  planType: string | null;
  /** True when this slot cannot be identified at all. `reason` says why. */
  unavailable: boolean;
  /**
   * Machine-readable cause when `unavailable`. Never contains file contents —
   * a malformed credential must not leak through an error string.
   */
  reason?:
    | 'auth-file-missing'
    | 'auth-file-unreadable'
    | 'no-id-token'
    | 'id-token-malformed'
    | 'no-email-claim';
}

const UNAVAILABLE = (reason: NonNullable<CodexSlotIdentity['reason']>): CodexSlotIdentity => ({
  email: null,
  accountId: null,
  planType: null,
  unavailable: true,
  reason,
});

/** OpenAI namespaces its non-standard claims under this key in the id_token. */
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';

/**
 * Decode a JWT payload segment. Returns null on anything unexpected rather than
 * throwing — a corrupt credential is an "unavailable slot", never a crash in the
 * enrolment path.
 */
function decodePayload(idToken: string): Record<string, unknown> | null {
  const parts = idToken.split('.');
  if (parts.length < 2) return null;
  const seg = parts[1];
  if (!seg) return null;
  try {
    const padded = seg + '='.repeat((4 - (seg.length % 4)) % 4);
    const json = Buffer.from(padded, 'base64url').toString('utf-8');
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    /* @silent-fallback-ok: a credential we cannot parse is an unidentifiable slot,
       which the caller already handles. Rethrowing would put token bytes into a
       stack/message, which this module exists to prevent. */
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Read the identity signed in at a Codex home (the directory `CODEX_HOME`
 * points at — e.g. `~/.codex`). Pure read; never writes, never spawns, never
 * touches the network.
 */
export function readCodexSlotIdentity(codexHome: string): CodexSlotIdentity {
  const authPath = path.join(codexHome, 'auth.json');
  if (!fs.existsSync(authPath)) return UNAVAILABLE('auth-file-missing');

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
  } catch {
    /* @silent-fallback-ok: unreadable/!JSON credential → unidentifiable slot. The
       original error is deliberately dropped: it can quote file bytes. */
    return UNAVAILABLE('auth-file-unreadable');
  }
  if (!raw || typeof raw !== 'object') return UNAVAILABLE('auth-file-unreadable');

  const tokens = (raw as { tokens?: unknown }).tokens;
  const tokenBag = tokens && typeof tokens === 'object' ? (tokens as Record<string, unknown>) : {};
  const idToken = str(tokenBag['id_token']);
  if (!idToken) return UNAVAILABLE('no-id-token');

  const payload = decodePayload(idToken);
  if (!payload) return UNAVAILABLE('id-token-malformed');

  const email = str(payload['email']);
  if (!email) return UNAVAILABLE('no-email-claim');

  const openai = payload[OPENAI_AUTH_CLAIM];
  const openaiBag = openai && typeof openai === 'object' ? (openai as Record<string, unknown>) : {};

  // Prefer the id the credential file itself records; fall back to the token's
  // claim. Both name the same account — the file is simply the more direct source.
  const accountId = str(tokenBag['account_id']) ?? str(openaiBag['chatgpt_account_id']);
  const planType = str(openaiBag['chatgpt_plan_type']);

  return { email, accountId, planType, unavailable: false };
}
