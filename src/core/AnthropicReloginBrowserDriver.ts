import { createHmac } from 'node:crypto';
import type { BrowserRepairResult, ReloginArtifact } from './SubscriptionReloginOrchestrator.js';
import { TERMINAL_GOOGLE_PAGE_CLASSES, type GooglePasskeyPageClass } from './GooglePasskeyPageClasses.js';
import { MYACCOUNT_GOOGLE_ORIGIN } from './PasskeyBrowserPolicy.js';

export type ReloginBrowserAction =
  | 'choose-expected-account'
  | 'click-google-signin'
  | 'fill-email'
  | 'fill-device-code'
  | 'fill-password'
  | 'fill-totp'
  | 'fill-backup-code'
  | 'click-next'
  | 'click-authorize'
  | 'click-passkey-continue'
  | 'click-try-another-way'
  | 'click-create-passkey'
  | 'click-create-passkey-confirm'
  | 'click-not-now'
  | 'read-paste-code'
  | 'wait';

/** Redacted, closed page state. No DOM prose, input values, URL query, or email leaves the browser port. */
export interface ReloginBrowserSnapshot {
  origin: string;
  pageClass:
    | 'provider-choice' | 'account-chooser' | 'email' | 'device-code' | 'device-approval'
    | 'password' | 'totp' | 'authorize'
    | 'paste-code' | 'success' | 'captcha' | 'phone-confirmation'
    | 'permission-expansion' | 'unknown'
    /** A bot-check hold page (Cloudflare "Just a moment…") that clears by itself; waited out, never solved. */
    | 'interstitial'
    | GooglePasskeyPageClass;
  expectedAccountVisible: boolean;
  /** Exact actionable chooser leaves matching the canonical expected identity. */
  expectedAccountMatchCount?: number;
  hasGoogleSignIn: boolean;
  hasNext: boolean;
  hasAuthorize: boolean;
  /** A "Not now" control (the passkey speedbump's decline). */
  hasNotNow?: boolean;
  requestedScopes: string[];
}

export type ReloginBrowserClick =
  | 'next' | 'authorize' | 'google'
  | 'passkey-continue' | 'try-another-way' | 'create-passkey' | 'create-passkey-confirm' | 'not-now';

export interface ReloginBrowserPort {
  open(url: string): Promise<void>;
  snapshot(expectedIdentity: string): Promise<ReloginBrowserSnapshot>;
  chooseExpectedAccount(expectedIdentity: string): Promise<void>;
  /** Implementations fill and submit the current public form atomically. */
  fillPublic(field: 'email' | 'device-code', value: string): Promise<void>;
  /** Implementations must submit directly; never log, snapshot, or return value. */
  fillSecret(field: 'password' | 'totp' | 'backup-code', value: string): Promise<void>;
  click(action: ReloginBrowserClick): Promise<void>;
  readPasteCode(): Promise<string | null>;
  wait(ms: number): Promise<void>;
  close(): Promise<void>;
}

export interface AnthropicReloginBrowserRequest {
  artifact: ReloginArtifact;
  verificationUrl: string;
  provider: 'anthropic' | 'openai';
  expectedIdentity: string;
  /**
   * The ONE method this repair was admitted under. `google-passkey` (spec
   * agent-held-google-passkey §3.4) never falls through to a password fill even when a
   * password binding is also present — a named refusal instead.
   */
  loginMethod: 'session-cookie' | 'password' | 'password+totp' | 'google-passkey';
  secretRefs: { password?: string; totp?: string; backupCode?: string };
  allowedScopes: string[];
  /**
   * What this drive is FOR (spec agent-held-google-passkey §3.6/§3.7). The
   * credential-CREATING controls ("Create a passkey", its confirm, a backup-code
   * submission) enter the allowed list only under `enroll`; a sign-in drive can
   * never mint. Absent ⇒ `sign-in`.
   */
  intent?: 'sign-in' | 'enroll';
}

export interface AnthropicReloginBrowserDriverDeps {
  browser: ReloginBrowserPort;
  resolveSecret: (name: string) => Promise<string | null>;
  /** Required Tier-1 supervisor; it sees closed state and a bounded action list only. */
  supervise: (input: {
    snapshot: ReloginBrowserSnapshot;
    allowedActions: ReloginBrowserAction[];
  }) => Promise<ReloginBrowserAction>;
  seatLease: {
    acquire: (holderId: string, holderLabel: string) => { acquired: boolean };
    release: (holderId: string) => unknown;
  };
  now?: () => number;
  maxSteps?: number;
  /** Total time to wait out a bot-check interstitial per drive (default 90 s, capped at 5 min). */
  interstitialMaxMs?: number;
}

/** Poll cadence while a bot-check interstitial is showing. */
export const INTERSTITIAL_POLL_MS = 3_000;

const ANTHROPIC_ORIGINS = [
  'https://claude.ai',
  'https://claude.com',
  'https://platform.claude.com',
  'https://console.anthropic.com',
  'https://auth.anthropic.com',
  'https://accounts.google.com',
];
const OPENAI_ORIGINS = [
  'https://auth.openai.com',
  'https://chatgpt.com',
  'https://platform.openai.com',
  'https://accounts.google.com',
];

/** Provider adapter: deterministic authority + redacted Tier-1 supervision. */
export class AnthropicReloginBrowserDriver {
  private readonly now: () => number;
  private readonly maxSteps: number;
  private readonly interstitialMaxMs: number;

  constructor(private readonly deps: AnthropicReloginBrowserDriverDeps) {
    this.now = deps.now ?? Date.now;
    this.maxSteps = Math.max(1, Math.min(40, Math.floor(deps.maxSteps ?? 20)));
    this.interstitialMaxMs = Math.max(0, Math.min(300_000, Math.floor(deps.interstitialMaxMs ?? 90_000)));
  }

  async drive(request: AnthropicReloginBrowserRequest, signal: AbortSignal = new AbortController().signal): Promise<BrowserRepairResult> {
    if (!safeAllowedUrl(request.verificationUrl, request.provider)) return { outcome: 'refused', failureClass: 'unexpected-origin' };
    if (Date.parse(request.artifact.expiresAt) <= this.now()) return { outcome: 'transient', failureClass: 'artifact-expired' };
    const holderId = `subscription-relogin:${request.artifact.attemptId}`;
    const lease = this.deps.seatLease.acquire(holderId, 'subscription re-login');
    if (!lease.acquired) return { outcome: 'transient', failureClass: 'seat-busy' };
    const abort = () => { void this.deps.browser.close().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      await this.deps.browser.open(request.verificationUrl);
      let interstitialWaitedMs = 0;
      for (let step = 0; step < this.maxSteps; step++) {
        signal.throwIfAborted();
        const snapshot = await this.deps.browser.snapshot(request.expectedIdentity);
        if (!allowedOrigins(request.provider, request.intent).includes(snapshot.origin))
          return { outcome: 'refused', failureClass: 'unexpected-origin' };
        // A bot-check interstitial ("Just a moment…") clears on its own in roughly 30–90 s.
        // Waiting it out is the only admissible action, so it needs no supervision, and it
        // has its own bounded budget instead of burning the step budget 750 ms at a time
        // (20 × 750 ms = 15 s, which the 2026-09-23 justin-gmail repair ran out three times).
        if (snapshot.pageClass === 'interstitial') {
          if (interstitialWaitedMs >= this.interstitialMaxMs)
            return { outcome: 'transient', failureClass: 'provider-transient' };
          await this.deps.browser.wait(INTERSTITIAL_POLL_MS);
          interstitialWaitedMs += INTERSTITIAL_POLL_MS;
          step -= 1; // an interstitial poll is not a drive step
          continue;
        }
        if (!scopesAllowed(snapshot.requestedScopes, request.allowedScopes))
          return { outcome: 'operator-only', failureClass: 'permission-expansion' };
        if (snapshot.pageClass === 'captcha' || snapshot.pageClass === 'google-risk-challenge')
          return { outcome: 'operator-only', failureClass: 'captcha' };
        // A terminal passkey page (Workspace refusal, already enrolled, throttled, not
        // recognized, the read-only list) ends a drive with the passkey-specific refusal:
        // nothing on it may be acted on (spec §3.6) and the outcome mapping owns the rest.
        if (TERMINAL_GOOGLE_PAGE_CLASSES.has(snapshot.pageClass as GooglePasskeyPageClass))
          return { outcome: 'refused', failureClass: 'passkey-refused' };
        if (snapshot.pageClass === 'phone-confirmation')
          return { outcome: 'operator-only', failureClass: 'phone-confirmation' };
        if (snapshot.pageClass === 'permission-expansion')
          return { outcome: 'operator-only', failureClass: 'permission-expansion' };
        if (snapshot.pageClass === 'account-chooser'
          && (snapshot.expectedAccountMatchCount ?? (snapshot.expectedAccountVisible ? 1 : 0)) !== 1)
          return { outcome: 'refused', failureClass: 'wrong-identity' };
        if (snapshot.pageClass === 'authorize' && snapshot.requestedScopes.length === 0)
          return { outcome: 'operator-only', failureClass: 'permission-expansion' };
        if (snapshot.pageClass === 'device-approval'
          && (request.provider !== 'openai' || request.artifact.kind !== 'device-code'))
          return { outcome: 'refused', failureClass: 'provider-rejected' };
        if (snapshot.pageClass === 'success') return { outcome: 'approved' };
        if (snapshot.pageClass === 'paste-code') {
          const code = await this.deps.browser.readPasteCode();
          return code ? { outcome: 'approved', pasteCode: code } : { outcome: 'transient', failureClass: 'provider-transient' };
        }
        const allowed = allowedActions(snapshot, request);
        if (allowed.length === 0) return { outcome: 'transient', failureClass: 'provider-transient' };
        const action = await this.deps.supervise({ snapshot, allowedActions: allowed });
        if (!allowed.includes(action)) return { outcome: 'refused', failureClass: 'provider-rejected' };
        const acted = await this.perform(action, request);
        if (!acted) return { outcome: 'refused', failureClass: 'vault-reference-missing' };
      }
      return { outcome: 'transient', failureClass: 'provider-transient' };
    } catch (error) {
      // @silent-fallback-ok — the closed transient result is the controller-visible failure signal; no exception is hidden.
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      return { outcome: 'transient', failureClass: 'provider-transient' };
    } finally {
      signal.removeEventListener('abort', abort);
      await this.deps.browser.close().catch(() => { /* @silent-fallback-ok — lease release below is authoritative cleanup; browser close is idempotent best-effort */ });
      this.deps.seatLease.release(holderId);
    }
  }

  private async perform(action: ReloginBrowserAction, req: AnthropicReloginBrowserRequest): Promise<boolean> {
    switch (action) {
      case 'choose-expected-account': await this.deps.browser.chooseExpectedAccount(req.expectedIdentity); return true;
      case 'click-google-signin': await this.deps.browser.click('google'); return true;
      case 'fill-email': await this.deps.browser.fillPublic('email', req.expectedIdentity); return true;
      case 'fill-device-code': {
        if (req.artifact.kind !== 'device-code' || !req.artifact.userCode) return false;
        await this.deps.browser.fillPublic('device-code', req.artifact.userCode); return true;
      }
      case 'fill-password': {
        if (!usesPassword(req.loginMethod) || !req.secretRefs.password) return false;
        let secret = await this.deps.resolveSecret(req.secretRefs.password);
        if (!secret) return false;
        try { await this.deps.browser.fillSecret('password', secret); }
        finally { secret = ''; }
        return true;
      }
      case 'fill-totp': {
        if (req.loginMethod !== 'password+totp' || !req.secretRefs.totp) return false;
        let seed = await this.deps.resolveSecret(req.secretRefs.totp);
        if (!seed) return false;
        try { await this.deps.browser.fillSecret('totp', generateTotp(seed, this.now())); }
        finally { seed = ''; }
        return true;
      }
      case 'fill-backup-code': {
        // The enrollment worker (spec §3.7) marks the code consumed BEFORE handing its
        // ref here; this floor only refuses the fill outside an enroll drive.
        if (req.intent !== 'enroll' || !req.secretRefs.backupCode) return false;
        let code = await this.deps.resolveSecret(req.secretRefs.backupCode);
        if (!code) return false;
        try { await this.deps.browser.fillSecret('backup-code', code); }
        finally { code = ''; }
        return true;
      }
      case 'click-next': await this.deps.browser.click('next'); return true;
      case 'click-authorize': await this.deps.browser.click('authorize'); return true;
      case 'click-passkey-continue': {
        if (req.loginMethod !== 'google-passkey') return false;
        await this.deps.browser.click('passkey-continue'); return true;
      }
      case 'click-try-another-way': await this.deps.browser.click('try-another-way'); return true;
      case 'click-create-passkey': {
        if (req.intent !== 'enroll') return false;
        await this.deps.browser.click('create-passkey'); return true;
      }
      case 'click-create-passkey-confirm': {
        if (req.intent !== 'enroll') return false;
        await this.deps.browser.click('create-passkey-confirm'); return true;
      }
      case 'click-not-now': await this.deps.browser.click('not-now'); return true;
      case 'wait': await this.deps.browser.wait(750); return true;
      case 'read-paste-code': return true;
    }
  }
}

/** Only the password-family methods may ever fill a password (no fall-through from other methods). */
function usesPassword(loginMethod: AnthropicReloginBrowserRequest['loginMethod']): boolean {
  return loginMethod === 'password' || loginMethod === 'password+totp';
}

export function allowedActions(
  snapshot: ReloginBrowserSnapshot,
  request: Pick<AnthropicReloginBrowserRequest, 'artifact' | 'loginMethod' | 'secretRefs' | 'intent'>,
): ReloginBrowserAction[] {
  switch (snapshot.pageClass) {
    case 'provider-choice': return snapshot.hasGoogleSignIn ? ['click-google-signin'] : [];
    case 'account-chooser': return (snapshot.expectedAccountMatchCount ?? (snapshot.expectedAccountVisible ? 1 : 0)) === 1
      ? ['choose-expected-account'] : [];
    case 'email': return ['fill-email'];
    case 'device-code': return request.artifact?.kind === 'device-code' && request.artifact.userCode
      ? ['fill-device-code'] : [];
    case 'password': return usesPassword(request.loginMethod) && request.secretRefs.password
      ? ['fill-password'] : [];
    case 'totp': return request.loginMethod === 'password+totp' && request.secretRefs.totp
      ? ['fill-totp'] : [];
    case 'device-approval': return request.artifact?.kind === 'device-code' && snapshot.hasAuthorize
      ? ['click-authorize'] : [];
    case 'authorize': return snapshot.hasAuthorize ? ['click-authorize'] : [];
    case 'unknown': return ['wait'];
    case 'interstitial': return ['wait'];
    // ── Closed Google passkey pages (spec agent-held-google-passkey §3.6). The list
    // is computed from STRUCTURE + the admitted method + the drive's intent; the
    // supervisor may only choose from it or decline. A credential-affecting control
    // ("Create a passkey", its confirm, a backup-code submission) appears ONLY on the
    // exact class AND only under `intent: 'enroll'`.
    case 'google-account-identity': return ['fill-email'];
    case 'google-passkey-challenge':
      if (request.loginMethod === 'google-passkey') return ['click-passkey-continue'];
      return usesPassword(request.loginMethod) ? ['click-try-another-way'] : [];
    case 'google-totp-entry': return request.loginMethod === 'password+totp' && request.secretRefs.totp
      ? ['fill-totp'] : [];
    case 'google-backup-code-entry': return request.intent === 'enroll' && request.secretRefs.backupCode
      ? ['fill-backup-code'] : [];
    case 'google-passkey-create': {
      const out: ReloginBrowserAction[] = [];
      if (request.intent === 'enroll') out.push('click-create-passkey');
      if (snapshot.hasNotNow) out.push('click-not-now');
      return out;
    }
    case 'google-passkey-create-confirm': return request.intent === 'enroll' ? ['click-create-passkey-confirm'] : [];
    default: return [];
  }
}

export function safeAllowedUrl(
  value: string,
  provider?: AnthropicReloginBrowserRequest['provider'],
): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    return provider ? allowedOrigins(provider).includes(url.origin)
      : [...ANTHROPIC_ORIGINS, ...OPENAI_ORIGINS].includes(url.origin);
  } catch { /* @silent-fallback-ok — false is the explicit fail-closed URL-validation verdict */ return false; }
}

/**
 * The origins a drive may find itself on. The Google ACCOUNT origin (the passkey
 * settings page, spec §3.6/§3.7) is admitted ONLY to an `enroll` drive — a sign-in
 * repair that lands there is off its path and is refused as before.
 */
function allowedOrigins(
  provider: AnthropicReloginBrowserRequest['provider'],
  intent?: AnthropicReloginBrowserRequest['intent'],
): string[] {
  const base = provider === 'openai' ? OPENAI_ORIGINS : ANTHROPIC_ORIGINS;
  return intent === 'enroll' ? [...base, MYACCOUNT_GOOGLE_ORIGIN] : base;
}

function scopesAllowed(requested: string[], allowed: string[]): boolean {
  const allow = new Set(allowed);
  return requested.every((scope) => /^[a-zA-Z0-9._:-]{1,100}$/.test(scope) && allow.has(scope));
}

export function generateTotp(base32: string, at: number, digits = 6, periodSeconds = 30): string {
  const key = decodeBase32(base32);
  const counter = Math.floor(at / 1000 / periodSeconds);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

function decodeBase32(value: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = value.toUpperCase().replace(/[\s=-]/g, '');
  if (!clean || [...clean].some((char) => !alphabet.includes(char))) throw new Error('invalid-totp-seed');
  let bits = '';
  for (const char of clean) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
