/**
 * Secret Drop mint policy (docs/specs/secret-drop-self-mint-hardening.md).
 *
 * Who created a Secret Drop request decides what that request may reach. The class is
 * decided ONCE, at creation, from facts the server checks itself, stored with the
 * request, and read by every later step. Only a request from the agent's own key (or the
 * owner's phone) may name a conversation, notify a session or start one.
 *
 * Pure functions only, so each rule is unit-tested on both sides.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { hasForwardingHeaders } from './mobileBrowserDevices.js';

/**
 * - `master`: the caller presented the agent's configured, non-empty key.
 * - `owner-phone`: the owner's own "Ask for a secret" (paired phone or the agent's key).
 * - `dashboard`: a scoped dashboard session credential.
 * - `none`: anything else, including every request created before this change.
 */
export type MintAuth = 'master' | 'owner-phone' | 'dashboard' | 'none';

/** May a request of this class name a conversation, notify a session, or start one? */
export function mintReachesSession(mintAuth: MintAuth | undefined | null): boolean {
  // The dashboard session is the owner after the PIN; its console picks the conversation.
  return mintAuth === 'master' || mintAuth === 'owner-phone' || mintAuth === 'dashboard';
}

/** Is this an unverified (keyless or pre-update) request? */
export function mintIsUnverified(mintAuth: MintAuth | undefined | null): boolean {
  return mintAuth !== 'master' && mintAuth !== 'owner-phone' && mintAuth !== 'dashboard';
}

/** The plain sentence a pre-update session gets when its request cannot notify it. */
export const KEYLESS_RECEIPT_NOTICE =
  'A Secret Drop request naming this conversation was made without the agent key, so no "secret received" message will come for it. ' +
  'If you asked for a secret just now, your session started before the last Instar update: the link still works, so check for the secret ' +
  'with the retrieve helper, and restart this session to get receipt messages again. If you did not ask for one, ignore this.';

/** The plain refusal when a keyless request asks for a browser password. */
export const KEYLESS_BROWSER_REFUSAL =
  'This request was made without the agent key, so it cannot ask for a browser password. ' +
  'A session started before the last Instar update sends requests this way until it restarts: restart this session and ask again.';

/**
 * Class of a request on the key-gated mint route. The middleware has already admitted the
 * caller; this decides what kind of caller it was. Never the "no token configured = open"
 * branch: with no configured key, nothing is master.
 */
export function classifyGatedMint(
  headers: Record<string, unknown>,
  configuredToken: string | undefined | null,
  dashboardScopedSession: boolean,
): MintAuth {
  if (dashboardScopedSession) return 'dashboard';
  if (typeof configuredToken !== 'string' || configuredToken.length === 0) return 'none';
  const header = headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return 'none';
  const presented = header.slice(7);
  if (presented.startsWith('dst_') || presented.startsWith('mps_')) return 'none';
  const ha = createHash('sha256').update(presented).digest();
  const hb = createHash('sha256').update(configuredToken).digest();
  return timingSafeEqual(ha, hb) ? 'master' : 'none';
}

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Admission to the keyless mint route: only this machine's own loopback, at the port the
 * request actually arrived on, and never anything a browser or a proxy would send.
 */
export function keylessMintAdmission(req: {
  headers: Record<string, unknown>;
  socket?: { remoteAddress?: string | null; localPort?: number | null } | null;
}): { ok: true } | { ok: false; error: string } {
  const remote = req.socket?.remoteAddress ?? '';
  if (!LOOPBACK_PEERS.has(remote)) return { ok: false, error: 'Self-mint is localhost-only' };
  if (hasForwardingHeaders(req.headers)) return { ok: false, error: 'Self-mint refuses forwarded requests' };
  const port = req.socket?.localPort;
  const rawHost = req.headers.host;
  if (typeof rawHost !== 'string' || typeof port !== 'number') return { ok: false, error: 'Self-mint needs this machine\'s own address' };
  const host = rawHost.toLowerCase();
  const allowed = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  if (port === 80) { allowed.add('localhost'); allowed.add('127.0.0.1'); allowed.add('[::1]'); }
  if (!allowed.has(host)) return { ok: false, error: 'Self-mint needs this machine\'s own address' };
  if (req.headers.origin !== undefined) return { ok: false, error: 'Self-mint refuses browser requests' };
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'none') return { ok: false, error: 'Self-mint refuses browser requests' };
  const ct = req.headers['content-type'];
  if (typeof ct !== 'string' || !/^application\/json(\s*;.*)?$/i.test(ct.trim())) {
    return { ok: false, error: 'Self-mint accepts application/json only' };
  }
  return { ok: true };
}

// Characters that make a field name unsafe to place in a shell command the agent is told to run.
const SHELL_UNSAFE = /[\s`$'"\\;|&<>()*?!#~\[\]{}^]/u;
// Control characters, line/paragraph separators.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
// Removed from free text: controls, separators, bidi controls, zero-width characters.
const STRIP_FROM_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff]/gu;
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/** Is this stored field name safe to show as a lookup key in a shell command? */
export function isShellSafeFieldName(name: string): boolean {
  return name.length > 0 && !name.startsWith('-') && !SHELL_UNSAFE.test(name) && !CONTROL.test(name) && !/[&<>]/.test(name);
}

/** Validate declared field names. `strict` applies the shell-safe rule (every non-master mint). */
export function validateFieldNames(names: string[], strict: boolean): string | null {
  const seen = new Set<string>();
  for (const name of names) {
    if (name.length === 0) return 'Field names must not be empty';
    if (name.length > 256) return 'Field names must be at most 256 characters';
    if (CONTROL.test(name)) return 'Field names must not contain control characters or line breaks';
    if (RESERVED_NAMES.has(name)) return `"${name}" cannot be used as a field name`;
    // A bare number would be reordered as an object key, so positions (#N) could disagree.
    if (/^\d+$/.test(name)) return 'Field names must not be a bare number';
    if (/[&<>]/.test(name)) return 'Field names must not contain &, < or >';
    if (strict && SHELL_UNSAFE.test(name)) {
      return 'Field names for this request must not contain spaces or shell characters (letters in any language, digits, "-", "_" and "." are fine)';
    }
    if (seen.has(name)) return `Field name "${name}" is used twice`;
    seen.add(name);
  }
  return null;
}

/** Clean caller free text: remove controls, separators, bidi and zero-width characters. */
export function cleanFreeText(text: string): string {
  return text.replace(STRIP_FROM_TEXT, '');
}

/** How a stored field is named to the agent: the name when shell-safe, else its 1-based position `#N`. */
export function fieldRef(name: string, index: number): string {
  return isShellSafeFieldName(name) ? name : `#${index + 1}`;
}

/** Resolve a field selector (a name, or `#N`) against the stored field order. */
export function resolveFieldSelector(selector: string, names: string[]): string | null {
  const m = /^#(\d{1,3})$/.exec(selector);
  if (m) {
    const i = Number(m[1]) - 1;
    return i >= 0 && i < names.length ? names[i] : null;
  }
  return names.includes(selector) ? selector : null;
}

/**
 * Wrap caller-written text for an agent-facing message as quoted, untrusted data. `&`, `<`
 * and `>` are entity-encoded so the text cannot close or forge the wrapper. Never used on
 * secret values, which are returned exactly.
 */
export function untrustedForAgent(text: string, token: string, unverified: boolean): string {
  const enc = cleanFreeText(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const tok = token.replace(/[^A-Za-z0-9_-]/g, '');
  return `<untrusted-data source="secret-drop" token="${tok}"${unverified ? ' origin="unverified"' : ''}>${enc}</untrusted-data>`;
}
