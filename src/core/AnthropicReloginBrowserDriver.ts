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

/** Raw facts about the page's visible controls (spec agent-driven-relogin). The driver filters + redacts. */
export interface ReloginControlObservation {
  title: string;
  path: string;
  controls: { n: number; text: string; identities: string[] }[];
  inputKinds: string[];
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
  /** Agent navigation (optional): the page's visible controls, and a real click on one of them. */
  observeControls?(): Promise<ReloginControlObservation>;
  /**
   * Run the profile's Chrome WITHOUT any debugging connection on `url` for `ms`, then quit it
   * (live 2026-09-24: a profile stuck on Cloudflare's hold under automation passed it once run
   * plainly, and the clearance carried over). The browser must be closed before calling.
   */
  warmUpPlain?(url: string, ms: number): Promise<void>;
  clickControl?(n: number, expectedText: string, expectedIdentities: string[]): Promise<void>;
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
  /**
   * Take ONE unused Google backup code from the named vault entry and remove it there before it
   * is typed (codes are single-use; a spent code must never be tried again). Absent ⇒ repairs
   * never use backup codes.
   */
  takeBackupCode?: (name: string) => Promise<string | null>;
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
  /**
   * `agent` (spec agent-driven-relogin): on every non-terminal page a model chooses the next
   * step from an OPEN, floor-filtered list of the page's visible controls plus the typed fills,
   * instead of the page-class table. Sign-in drives only; enrollment stays `closed`.
   */
  navigation?: 'closed' | 'agent';
  /** The agent's chooser. Returns exactly one token from `offered`. Required when navigation is `agent`. */
  navigate?: (input: AgentNavigationInput) => Promise<string>;
  /** Hard drive deadline (default 8 min, clamped 1–10 min), raced against every model and browser call. */
  driveDeadlineMs?: number;
}

/** Everything the agent's chooser ever sees — a fixed schema with no values, no query strings, no foreign identities. */
export interface AgentNavigationInput {
  provider: 'anthropic' | 'openai';
  loginMethod: AnthropicReloginBrowserRequest['loginMethod'];
  origin: string;
  path: string;
  title: string;
  pageClassHint: ReloginBrowserSnapshot['pageClass'];
  expectedAccountVisible: boolean;
  inputKinds: string[];
  controls: { token: string; label: string }[];
  offered: string[];
  recentSteps: string[];
}

/** Poll cadence while a bot-check interstitial is showing. */
export const INTERSTITIAL_POLL_MS = 3_000;

/** How long the plain, unautomated warm-up browser runs when a hold will not clear under automation. */
/** How many one-second waits a still-blank (about:blank) window gets before its origin is judged. */
const BLANK_PAGE_MAX_WAITS = 15;
export const PLAIN_WARM_UP_MS = 45_000;

/**
 * After a consent/authorize click, how long the page may stay on the authorize step before the
 * drive treats it as a provider human-verification check (live 2026-09-24: Claude's Authorize
 * button spun forever behind an invisible hCaptcha under automation). The drive then stops and
 * hands the sign-in to the operator instead of retrying through a risk control.
 */
export const CONSENT_STUCK_MS = 15_000;

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
    this.driveDeadlineMs = Math.max(60_000, Math.min(600_000, Math.floor(deps.driveDeadlineMs ?? 480_000)));
  }

  private readonly driveDeadlineMs: number;
  /** Set once this drive has taken a backup code (one per drive — see fill-backup-code). */
  private backupCodeSpent = false;

  /** Agent navigation applies to sign-in drives with a chooser and a browser that can observe controls. */
  private agentMode(request: AnthropicReloginBrowserRequest): boolean {
    return this.deps.navigation === 'agent' && request.intent !== 'enroll' && !!this.deps.navigate
      && typeof this.deps.browser.observeControls === 'function' && typeof this.deps.browser.clickControl === 'function';
  }

  async drive(request: AnthropicReloginBrowserRequest, signal: AbortSignal = new AbortController().signal): Promise<BrowserRepairResult> {
    this.backupCodeSpent = false;
    if (!safeAllowedUrl(request.verificationUrl, request.provider)) return { outcome: 'refused', failureClass: 'unexpected-origin' };
    if (Date.parse(request.artifact.expiresAt) <= this.now()) return { outcome: 'transient', failureClass: 'artifact-expired' };
    const holderId = `subscription-relogin:${request.artifact.attemptId}`;
    const lease = this.deps.seatLease.acquire(holderId, 'subscription re-login');
    if (!lease.acquired) return { outcome: 'transient', failureClass: 'seat-busy' };
    const abort = () => { void this.deps.browser.close().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    const agent = this.agentMode(request);
    const deadline = this.now() + this.driveDeadlineMs;
    // A hard deadline raced against every browser and model call: a stalled await can never
    // outlive the drive (spec agent-driven-relogin, "hard time limit").
    const bounded = <T>(work: Promise<T>): Promise<T> => {
      const remaining = deadline - this.now();
      if (remaining <= 0) return Promise.reject(new Error('relogin-drive-deadline'));
      let timer: NodeJS.Timeout | undefined;
      const expiry = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('relogin-drive-deadline')), remaining);
      });
      return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
    };
    const resolvedSecrets = new Set<string>();
    if (request.artifact.userCode) resolvedSecrets.add(request.artifact.userCode);
    const recentSteps: string[] = [];
    let outcomeNote = 'unfinished';
    let warmedUp = false;
    const consent = { clickedAt: 0 };
    try {
      signal.throwIfAborted();
      await bounded(this.deps.browser.open(request.verificationUrl));
      let interstitialWaitedMs = 0;
      let blankWaits = 0;
      for (let step = 0; step < this.maxSteps; step++) {
        signal.throwIfAborted();
        const snapshot = await bounded(this.deps.browser.snapshot(request.expectedIdentity));
        // A window that is still loading (a new window, or a provider popup) shows about:blank,
        // whose origin is "null". Nothing on it can be acted on, so wait a bounded moment rather
        // than refuse; a page that STAYS blank still ends as unexpected-origin below.
        if (snapshot.origin === 'null' && blankWaits < BLANK_PAGE_MAX_WAITS) {
          blankWaits++; step--;
          await bounded(this.deps.browser.wait(1_000));
          continue;
        }
        if (!allowedOrigins(request.provider, request.intent).includes(snapshot.origin))
          return { outcome: 'refused', failureClass: 'unexpected-origin' };
        // A bot-check interstitial ("Just a moment…") clears on its own in roughly 30–90 s.
        // Waiting it out is the only admissible action, so it needs no supervision, and it
        // has its own bounded budget instead of burning the step budget 750 ms at a time
        // (20 × 750 ms = 15 s, which the 2026-09-23 justin-gmail repair ran out three times).
        if (snapshot.pageClass === 'interstitial') {
          if (interstitialWaitedMs >= this.interstitialMaxMs) {
            // Once per drive: let the profile pass the hold as a plain, unautomated browser,
            // then reopen and carry on (bounded by the same drive deadline).
            if (warmedUp || typeof this.deps.browser.warmUpPlain !== 'function') {
              outcomeNote = 'hold never cleared';
              return { outcome: 'transient', failureClass: 'provider-transient' };
            }
            warmedUp = true;
            recentSteps.push('plain-warm-up');
            await bounded(this.deps.browser.close());
            await bounded(this.deps.browser.warmUpPlain(request.verificationUrl, PLAIN_WARM_UP_MS));
            await bounded(this.deps.browser.open(request.verificationUrl));
            interstitialWaitedMs = 0;
            step -= 1;
            continue;
          }
          await bounded(this.deps.browser.wait(INTERSTITIAL_POLL_MS));
          interstitialWaitedMs += INTERSTITIAL_POLL_MS;
          step -= 1; // an interstitial poll is not a drive step
          continue;
        }
        if (!scopesAllowed(snapshot.requestedScopes, request.allowedScopes))
          return { outcome: 'operator-only', failureClass: 'permission-expansion' };
        if (consent.clickedAt > 0 && snapshot.pageClass === 'authorize' && this.now() - consent.clickedAt >= CONSENT_STUCK_MS) {
          outcomeNote = 'consent click did not go through — provider verification; handed to the operator';
          return { outcome: 'operator-only', failureClass: 'captcha' };
        }
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
          const code = await bounded(this.deps.browser.readPasteCode());
          return code ? { outcome: 'approved', pasteCode: code } : { outcome: 'transient', failureClass: 'provider-transient' };
        }
        if (agent) {
          const ended = await this.agentStep(snapshot, request, resolvedSecrets, recentSteps, bounded, consent);
          if (ended) return ended;
          continue;
        }
        const allowed = allowedActions(snapshot, request);
        if (allowed.length === 0) return { outcome: 'transient', failureClass: 'provider-transient' };
        const action = await bounded(this.deps.supervise({ snapshot, allowedActions: allowed }));
        if (!allowed.includes(action)) return { outcome: 'refused', failureClass: 'provider-rejected' };
        const acted = await bounded(this.perform(action, request, resolvedSecrets));
        if (action === 'click-authorize' && consent.clickedAt === 0) consent.clickedAt = this.now();
        if (!acted) return { outcome: 'refused', failureClass: 'vault-reference-missing' };
      }
      return { outcome: 'transient', failureClass: 'provider-transient' };
    } catch (error) {
      // @silent-fallback-ok — the closed transient result is the controller-visible failure signal; no exception is hidden.
      outcomeNote = `error ${error instanceof Error ? error.message.slice(0, 60) : 'unknown'}`;
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      const reason = error instanceof Error ? error.message : 'unknown';
      // macOS refused to let this agent control Chrome (Automation permission). Retrying cannot
      // change that: stop now and ask the operator for the one-time "Allow".
      // A running Chrome that never answers a control request for the whole launch budget is, in
      // practice, macOS's first-use "allow control of Google Chrome?" prompt waiting for a click
      // (live on the Mac Mini, 2026-09-25) — also not something a retry can clear.
      if (reason.startsWith('plain-browser-automation-not-permitted')
        || reason.startsWith('chrome-launch-timeout-apple-event-no-reply'))
        return { outcome: 'operator-only', failureClass: 'automation-permission', reason };
      return { outcome: 'transient', failureClass: 'provider-transient', reason };
    } finally {
      signal.removeEventListener('abort', abort);
      resolvedSecrets.clear();
      if (agent) console.log(`[subscription-relogin] agent drive ${request.artifact.attemptId}: ${outcomeNote}; steps: ${recentSteps.join(' > ') || '(none)'}`);
      await this.deps.browser.close().catch(() => { /* @silent-fallback-ok — lease release below is authoritative cleanup; browser close is idempotent best-effort */ });
      this.deps.seatLease.release(holderId);
    }
  }

  /**
   * One agent-navigation step (spec agent-driven-relogin): observe the page's controls, build
   * the floor-filtered offer, ask the chooser for exactly one token, perform it. Returns a
   * result only when the drive ends; `null` means "keep going".
   */
  private async agentStep(
    snapshot: ReloginBrowserSnapshot,
    request: AnthropicReloginBrowserRequest,
    resolvedSecrets: Set<string>,
    recentSteps: string[],
    bounded: <T>(work: Promise<T>) => Promise<T>,
    consent: { clickedAt: number },
  ): Promise<BrowserRepairResult | null> {
    const observation = await bounded(this.deps.browser.observeControls!());
    const offer = buildAgentOffer(snapshot, observation, request, [...resolvedSecrets]);
    const token = String(await bounded(this.deps.navigate!({
      provider: request.provider, loginMethod: request.loginMethod,
      origin: snapshot.origin, path: redactLabel(observation.path, request.expectedIdentity, [...resolvedSecrets], 120),
      title: redactLabel(observation.title, request.expectedIdentity, [...resolvedSecrets], 120),
      pageClassHint: snapshot.pageClass, expectedAccountVisible: snapshot.expectedAccountVisible,
      inputKinds: observation.inputKinds, controls: offer.controls.map(({ token: t, label }) => ({ token: t, label })),
      offered: offer.offered, recentSteps: recentSteps.slice(-6),
    }))).trim();
    // The model's answer is only ever a token from the offer; anything else ends the drive.
    if (!offer.offered.includes(token) || token === 'give-up') {
      recentSteps.push(token === 'give-up' ? 'give-up' : `invalid-token(${token.slice(0, 20)})`);
      return { outcome: 'transient', failureClass: 'provider-transient' };
    }
    if (token === 'wait') {
      await bounded(this.deps.browser.wait(2_000));
      recentSteps.push('wait');
      return null;
    }
    const control = offer.controls.find((entry) => entry.token === token);
    if (control) {
      // Re-checked at click time: the browser refuses unless control n still has the same text.
      await bounded(this.deps.browser.clickControl!(control.n, control.text, control.identities));
      if (snapshot.pageClass === 'authorize' && consent.clickedAt === 0) consent.clickedAt = this.now();
      recentSteps.push(`${token} "${control.label}"`);
      return null;
    }
    const acted = await bounded(this.perform(token as ReloginBrowserAction, request, resolvedSecrets));
    if (!acted) return { outcome: 'refused', failureClass: 'vault-reference-missing' };
    recentSteps.push(token);
    return null;
  }

  private async perform(action: ReloginBrowserAction, req: AnthropicReloginBrowserRequest, seen?: Set<string>): Promise<boolean> {
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
        seen?.add(secret);
        try { await this.deps.browser.fillSecret('password', secret); }
        finally { secret = ''; }
        return true;
      }
      case 'fill-totp': {
        if (req.loginMethod !== 'password+totp' || !req.secretRefs.totp) return false;
        let seed = await this.deps.resolveSecret(req.secretRefs.totp);
        if (!seed) return false;
        const totpCode = generateTotp(seed, this.now());
        seen?.add(seed); seen?.add(totpCode);
        try { await this.deps.browser.fillSecret('totp', totpCode); }
        finally { seed = ''; }
        return true;
      }
      case 'fill-backup-code': {
        // Enroll: the worker (spec §3.7) marks the code consumed BEFORE handing its ref here.
        // Repair: a password account's second step; the code is taken OUT of the vault first.
        if (!req.secretRefs.backupCode) return false;
        if (req.intent !== 'enroll' && (!usesPassword(req.loginMethod) || !this.deps.takeBackupCode)) return false;
        // At most ONE code per drive: a rejected code leaves the page on the backup-code field, and
        // re-offering the fill would drain the whole list. A second request ends the attempt instead.
        if (req.intent !== 'enroll') {
          if (this.backupCodeSpent) throw new Error('relogin-backup-code-rejected');
          this.backupCodeSpent = true;
        }
        let code = req.intent === 'enroll'
          ? await this.deps.resolveSecret(req.secretRefs.backupCode)
          : await this.deps.takeBackupCode!(req.secretRefs.backupCode);
        if (!code) return false;
        seen?.add(code);
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
    case 'google-backup-code-entry': return request.secretRefs.backupCode
      && (request.intent === 'enroll' || usesPassword(request.loginMethod)) ? ['fill-backup-code'] : [];
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

/**
 * Controls the agent may NEVER be offered, whatever the page (spec agent-driven-relogin):
 * account-changing, destructive, and credential-creating actions. A deterministic block on
 * irreversible actions — the Signal-vs-Authority exemption for safety guards.
 */
export const AGENT_BLOCKED_PHRASES: readonly string[] = [
  'sign out', 'log out', 'logout', 'delete', 'remove', 'forgot password', 'change password',
  'reset password', 'security', 'manage', 'add account', 'add another account', 'use another account',
  'create api key', 'buy', 'upgrade', 'invite', 'cancel plan', 'create a passkey', 'create passkey',
  'add passkey', 'set up', 'turn on', 'add phone', 'add recovery', 'save password',
  'create account', 'create an account', 'sign up', 'create your account',
  // Never a step forward in a sign-in, and 'switch account' changes identity (live 2026-09-24:
  // the model picked Decline on Claude's authorize page, which names no account).
  'decline', 'deny', 'switch account', 'not you',
];

const CONSENT_LABEL = /^(allow|authorize|authorise|approve|accept|grant)\b/i;

function normalizePhrase(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isBlockedControl(text: string): boolean {
  const normalized = normalizePhrase(text);
  return AGENT_BLOCKED_PHRASES.some((phrase) => normalized.includes(phrase));
}

/**
 * What a label may carry to the model: every secret resolved in this drive stripped verbatim,
 * foreign emails masked, long token-like runs and 6+ digit runs masked, and a hard length cap
 * that DISCLOSES a cut (never a silently shortened label).
 */
export function redactLabel(text: string, expectedIdentity: string, secrets: string[], max = 60): string {
  let out = String(text ?? '');
  for (const secret of secrets) if (secret && secret.length >= 3) out = out.split(secret).join('‹secret›');
  const expected = expectedIdentity.trim().toLowerCase();
  out = out.replace(/[a-z0-9.!#$%&'*+/=?^_{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/gi,
    (email) => email.toLowerCase() === expected ? email : '‹other-email›');
  // Partially hidden emails (Google renders j•••@gmail.com) cannot be compared, so they are masked too.
  out = out.replace(/[^\s@]*[•*…][^\s@]*@\S+/g, '‹masked-email›');
  out = out.replace(/[A-Za-z0-9_-]{20,}/g, '‹masked›').replace(/\d{6,}/g, '‹masked›');
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max)}…(truncated)` : out;
}

export interface AgentOffer {
  offered: string[];
  controls: { token: string; n: number; text: string; identities: string[]; label: string }[];
}

/**
 * The floor-filtered action list for one agent step. Pure — every floor is testable here.
 * Typed fills are offered by INPUT PRESENCE (not page class); visible controls are offered
 * unless they name another identity, carry a blocked phrase, or would grant consent without
 * measured, allowed, non-empty scopes.
 */
export function buildAgentOffer(
  snapshot: ReloginBrowserSnapshot,
  observation: ReloginControlObservation,
  request: Pick<AnthropicReloginBrowserRequest, 'artifact' | 'loginMethod' | 'secretRefs' | 'expectedIdentity' | 'allowedScopes'>,
  secrets: string[],
): AgentOffer {
  const offered: string[] = [];
  const kinds = new Set(observation.inputKinds);
  if ((snapshot.expectedAccountMatchCount ?? (snapshot.expectedAccountVisible ? 1 : 0)) === 1) offered.push('choose-expected-account');
  if (kinds.has('email')) offered.push('fill-email');
  if (kinds.has('password') && usesPassword(request.loginMethod) && request.secretRefs.password) offered.push('fill-password');
  if (kinds.has('code') && request.loginMethod === 'password+totp' && request.secretRefs.totp) offered.push('fill-totp');
  // Only Google's own backup-code field (never an SMS or authenticator box: a wrong field wastes a single-use code).
  if (kinds.has('backup-code') && usesPassword(request.loginMethod) && request.secretRefs.backupCode) offered.push('fill-backup-code');
  if (kinds.has('code') && request.artifact?.kind === 'device-code' && request.artifact.userCode) offered.push('fill-device-code');
  const expected = request.expectedIdentity.trim().toLowerCase();
  const consentMeasured = snapshot.requestedScopes.length > 0 && scopesAllowed(snapshot.requestedScopes, request.allowedScopes);
  const controls: AgentOffer['controls'] = [];
  for (const control of observation.controls) {
    if (control.identities.some((identity) => identity.trim().toLowerCase() !== expected)) continue;
    if (isBlockedControl(control.text)) continue;
    const consent = CONSENT_LABEL.test(control.text.trim()) || snapshot.pageClass === 'authorize';
    if (consent && !consentMeasured) continue;
    const label = redactLabel(control.text, request.expectedIdentity, secrets);
    if (!label) continue;
    const token = `click:${control.n}`;
    controls.push({ token, n: control.n, text: control.text, identities: control.identities, label });
    offered.push(token);
  }
  offered.push('wait', 'give-up');
  return { offered, controls };
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
