import { createHmac } from 'node:crypto';
import type { BrowserRepairResult, ReloginArtifact } from './SubscriptionReloginOrchestrator.js';

export type ReloginBrowserAction =
  | 'choose-expected-account'
  | 'click-google-signin'
  | 'fill-email'
  | 'fill-device-code'
  | 'fill-password'
  | 'fill-totp'
  | 'click-next'
  | 'click-authorize'
  | 'read-paste-code'
  | 'wait';

/** Redacted, closed page state. No DOM prose, input values, URL query, or email leaves the browser port. */
export interface ReloginBrowserSnapshot {
  origin: string;
  pageClass:
    | 'provider-choice' | 'account-chooser' | 'email' | 'device-code' | 'device-approval'
    | 'password' | 'totp' | 'authorize'
    | 'paste-code' | 'success' | 'captcha' | 'phone-confirmation'
    | 'permission-expansion' | 'unknown';
  expectedAccountVisible: boolean;
  /** Exact actionable chooser leaves matching the canonical expected identity. */
  expectedAccountMatchCount?: number;
  hasGoogleSignIn: boolean;
  hasNext: boolean;
  hasAuthorize: boolean;
  requestedScopes: string[];
}

export interface ReloginBrowserPort {
  open(url: string): Promise<void>;
  snapshot(expectedIdentity: string): Promise<ReloginBrowserSnapshot>;
  chooseExpectedAccount(expectedIdentity: string): Promise<void>;
  /** Implementations fill and submit the current public form atomically. */
  fillPublic(field: 'email' | 'device-code', value: string): Promise<void>;
  /** Implementations must submit directly; never log, snapshot, or return value. */
  fillSecret(field: 'password' | 'totp', value: string): Promise<void>;
  click(action: 'next' | 'authorize' | 'google'): Promise<void>;
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
  secretRefs: { password?: string; totp?: string };
  allowedScopes: string[];
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
}

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

  constructor(private readonly deps: AnthropicReloginBrowserDriverDeps) {
    this.now = deps.now ?? Date.now;
    this.maxSteps = Math.max(1, Math.min(40, Math.floor(deps.maxSteps ?? 20)));
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
      for (let step = 0; step < this.maxSteps; step++) {
        signal.throwIfAborted();
        const snapshot = await this.deps.browser.snapshot(request.expectedIdentity);
        if (!allowedOrigins(request.provider).includes(snapshot.origin))
          return { outcome: 'refused', failureClass: 'unexpected-origin' };
        if (!scopesAllowed(snapshot.requestedScopes, request.allowedScopes))
          return { outcome: 'operator-only', failureClass: 'permission-expansion' };
        if (snapshot.pageClass === 'captcha') return { outcome: 'operator-only', failureClass: 'captcha' };
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
      case 'click-next': await this.deps.browser.click('next'); return true;
      case 'click-authorize': await this.deps.browser.click('authorize'); return true;
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
  request: Pick<AnthropicReloginBrowserRequest, 'artifact' | 'loginMethod' | 'secretRefs'>,
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

function allowedOrigins(provider: AnthropicReloginBrowserRequest['provider']): string[] {
  return provider === 'openai' ? OPENAI_ORIGINS : ANTHROPIC_ORIGINS;
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
