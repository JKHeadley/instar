/**
 * Skill-driven sign-in repair (spec docs/specs/skill-driven-signin-repair.md).
 *
 * On macOS and on WSL (spec windows-signin-repair) the browser step of a repair episode is done by
 * ONE short-lived agent session that follows `/subscription-signin` section 3 — exactly what the hand-run repairs did. The session
 * is a trusted local operator (same trust as any agent session on the machine). This module is
 * the SERVER side, and it only arbitrates:
 *
 *  - admission to the machine's single helper seat (the host Playwright seat lease, renewed
 *    every 2 minutes because its 10-minute TTL is shorter than the helper cap), session
 *    capacity, and a healthy helper account that is never the one under repair;
 *  - the per-episode token and the one code route the helper may call;
 *  - the helper's lifetime (cap `min(15 min, login expiry − 60 s)`) and its kill on every exit.
 *
 * It NEVER decides success. The orchestrator's arbiter (pending-login completion, then
 * `verifyIdentity === 'match'`, then an authenticated call) does that; nothing the helper says
 * counts. A helper that exits or reaches its cap without delivering is `agent-sign-in-unfinished`.
 *
 * Nothing here persists: the token, the wait and the posted code live only in memory, so after
 * a server restart the route answers 409 and the orchestrator's existing `browser-driving`
 * recovery takes over.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { CLAUDE_CODE_FRAMEWORK } from './frameworkFacts.js';
import type { BrowserRepairResult, ReloginArtifact, ReloginPreAttemptVerdict } from './SubscriptionReloginOrchestrator.js';
import type { SubscriptionReloginEpisode } from './SubscriptionReloginStore.js';
import type { PlaywrightSeatLeaseResult, PlaywrightSeatReleaseResult } from './PlaywrightSeatLease.js';

/** The pool account a helper session runs on: never the account under repair. */
export interface ReloginHelperSeat {
  accountId: string;
  framework: 'claude-code' | 'codex-cli';
  configHome: string;
}

/** `windows`: an agent in WSL, driving Windows Chrome through ndrive.sh. */
export type ReloginHelperBrowserDriver = 'macos' | 'windows';

export interface ReloginHelperDriveInput {
  episode: SubscriptionReloginEpisode;
  artifact: ReloginArtifact;
  verificationUrl: string;
  expectedEmail: string;
  provider: 'anthropic' | 'openai';
  /** The account's own Chrome profile directory (opened the ordinary way by the helper). */
  profileDir: string;
  /** Which normal-Chrome tools the helper has; absent means macOS. */
  browserDriver?: ReloginHelperBrowserDriver;
  /** Names (never values) of the account's vault bindings. */
  vaultBindingNames: string[];
  /**
   * Authenticator over a phone prompt (spec relogin-authenticator-over-phone-prompt), for an
   * account that signs in with password + authenticator and has its authenticator entry bound:
   * `on` = on a page headed "2-Step Verification" the helper chooses "Try another way" and the
   * authenticator code; `shadow` = it only reads and reports the heading, then asks for the tap as
   * before; `off`/absent = the previous prompt, byte for byte.
   */
  authenticatorMode?: 'on' | 'shadow' | 'off';
}

export interface SubscriptionReloginHelperDeps {
  lease: {
    acquire(holderId: string, holderLabel: string): PlaywrightSeatLeaseResult;
    release(holderId: string): PlaywrightSeatReleaseResult;
  };
  /** True when the session manager has room for one more session. */
  hasCapacity: () => boolean;
  /** A just-in-time healthy helper account on this machine, never `excludeAccountId`. */
  pickSeat: (excludeAccountId: string, signal: AbortSignal) => Promise<ReloginHelperSeat | null>;
  /** Spawn the pinned helper session; resolves with its tmux session name. */
  spawn: (input: { name: string; prompt: string; seat: ReloginHelperSeat; maxDurationMinutes: number }) => Promise<string>;
  isAlive: (tmuxSession: string) => boolean;
  kill: (tmuxSession: string) => void;
  /** Running helper sessions (`relogin-<episodeId>`), for boot cleanup. */
  listHelpers: () => Array<{ name: string; tmuxSession: string }>;
  /** Device-code (Codex) flows need no code: the wait resolves when the credential appears. */
  credentialReady: (episode: SubscriptionReloginEpisode) => Promise<boolean>;
  /** Queue (and try to deliver now) the fixed phone-tap notice. Idempotent. */
  queuePhoneTap: (episodeId: string) => void;
  /** Audit what the helper saw at Google's 2-Step Verification step (once per result per attempt). */
  noteAuthenticator?: (episodeId: string, label: string) => void;
  /** The machine's supervision latch for the authenticator step; absent ⇒ open. */
  authenticatorLatch?: (driveId: string) => 'open' | 'awaiting-review' | 'review-failed';
  /** Record a granted use (one per drive) in the store's never-pruned table. */
  noteAuthenticatorUse?: (episodeId: string, driveId: string) => void;
  /** Codes already granted in this episode's current attempt, from the store (restart-safe). */
  authenticatorCodesGranted?: (episodeId: string) => number;
  /** codex-device-limit-tripwire §4: a helper reported a device-limit page (the repair is already settled). */
  onDeviceLimitReported?: (episodeId: string) => void;
  /** The existing paste-back code-shape validator. */
  validateCode: (code: string) => boolean;
  /** The local server port the helper posts to (loopback). */
  serverPort: number;
  browserDriver?: ReloginHelperBrowserDriver;
  now?: () => number;
  pollMs?: number;
  leaseRenewMs?: number;
  capMs?: number;
  /** How long a device-code credential may take to land after the helper exits. */
  exitSettleMs?: number;
  /** Startup grace before a not-yet-visible helper counts as exited. */
  startGraceMs?: number;
}

export type ReloginHelperSubmitResult = { status: number; body: Record<string, unknown> };

const HELPER_NAME_PREFIX = 'relogin-';
const MAX_BODY_KEYS = 4;
/** The only origin the authenticator step may act on. */
export const GOOGLE_SIGNIN_ORIGIN = 'https://accounts.google.com';
/** What the helper saw at Google's 2-Step Verification step (spec relogin-authenticator-over-phone-prompt). */
/**
 * Helper → server notices at Google's 2-Step Verification step. `intent` and `code` are REQUESTS
 * the server answers with `proceed` (it is the authority on the heading and the code count); the
 * rest are reports of what happened.
 */
export type AuthenticatorResult = 'intent' | 'code' | 'accepted' | 'rejected' | 'no-option' | 'shadow-would-use' | 'shadow-would-stop';
const AUTHENTICATOR_RESULTS = new Set<AuthenticatorResult>(['intent', 'code', 'accepted', 'rejected', 'no-option', 'shadow-would-use', 'shadow-would-stop']);
/** At most two codes per attempt: one retry covers a code typed at a 30-second window boundary. */
export const MAX_AUTHENTICATOR_CODES = 2;
/** Bound on audit rows per attempt, so a looping helper cannot grow the store. */
const MAX_AUTHENTICATOR_EVENTS = 12;
/** How the heading the helper read from the page compares with Google's 2-Step Verification heading. */
export type AuthenticatorHeading = '2sv' | 'other' | 'unknown';
const MAX_HEADING_CHARS = 200;
/**
 * Server-side check of the page heading the helper read from the page's own h1 (spec
 * relogin-authenticator-over-phone-prompt): exact match after folding case, whitespace, hyphen
 * variants and invisible characters (soft hyphen, zero-width). Anything else is `other`; an empty
 * heading is `unknown`. It checks the text the helper reported, so it is the server's authority on
 * whether to answer `proceed`, not an independent view of the page. Exported for tests.
 */
export function classifyAuthenticatorHeading(heading: string): AuthenticatorHeading {
  const folded = heading.replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, '').replace(/[\u2010-\u2013\u2212]/g, '-')
    .replace(/\s+/g, ' ').trim().toLowerCase();
  if (folded === '') return 'unknown';
  return folded === '2-step verification' ? '2sv' : 'other';
}
const PERMISSIONS = new Set(['screen-recording', 'accessibility', 'automation']);
/**
 * Hard-line stops the helper reports (spec relogin-unattended-agent-session-and-slow-retry). Each
 * hands the repair to the operator (`waiting-operator-only`), which a slow retry never touches — so
 * a CAPTCHA or a wrong-account screen is never driven again automatically. A report can only REDUCE
 * autonomy; it never counts toward success.
 */
const HARD_LINES = new Set(['captcha', 'phone-confirmation', 'wrong-account', 'unexpected-site', 'device-limit']);

interface LiveDrive {
  tokenHash: Buffer;
  tmuxSession: string | null;
  codeTaken: boolean;
  /** This drive's authenticator mode (spec relogin-authenticator-over-phone-prompt). */
  authenticatorMode?: 'on' | 'shadow' | 'off';
  /** Audit labels already recorded for this attempt (dedupe), and codes the server has granted. */
  authenticatorNoted?: Set<string>;
  codesGranted?: number;
  /** This drive was already granted the step (re-asking within it is not a new use). */
  intentGranted?: boolean;
  /** This drive's id: one granted drive is one supervised use. */
  driveId?: string;
  /** True once the drive's outcome is decided; later reports are refused, never falsely "accepted". */
  settled: boolean;
  settle: (result: BrowserRepairResult) => void;
}

/**
 * Bounded by the repair service's registered controller (subscription-relogin-redrive, in
 * SubscriptionReloginService.ts): at most ONE helper spawn per counted attempt, the attempt budget
 * is durable (maxAttempts 3), and a waiting episode spawns nothing.
 */
export class SubscriptionReloginHelper {
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly leaseRenewMs: number;
  private readonly capMs: number;
  private readonly exitSettleMs: number;
  private readonly startGraceMs: number;
  private readonly seats = new Map<string, ReloginHelperSeat>();
  private readonly live = new Map<string, LiveDrive>();
  /** Helper tmux sessions whose kill failed; counted as driving until they are gone. */
  private readonly unreaped = new Set<string>();

  constructor(private readonly deps: SubscriptionReloginHelperDeps) {
    this.now = deps.now ?? Date.now;
    this.pollMs = Math.max(50, deps.pollMs ?? 1_000);
    this.leaseRenewMs = Math.max(1_000, deps.leaseRenewMs ?? 2 * 60_000);
    this.capMs = Math.max(1_000, Math.min(15 * 60_000, deps.capMs ?? 15 * 60_000));
    this.exitSettleMs = Math.max(0, deps.exitSettleMs ?? 30_000);
    this.startGraceMs = Math.max(0, deps.startGraceMs ?? 20_000);
  }

  static sessionName(episodeId: string): string { return `${HELPER_NAME_PREFIX}${episodeId}`; }
  static holderId(episodeId: string): string { return `subscription-relogin:${episodeId}`; }

  /** Pre-attempt check (spec §2): lease, then capacity, then a healthy helper account. */
  async preAttempt(episode: SubscriptionReloginEpisode, signal: AbortSignal): Promise<ReloginPreAttemptVerdict> {
    const holder = SubscriptionReloginHelper.holderId(episode.id);
    const lease = this.deps.lease.acquire(holder, 'subscription sign-in repair helper');
    if (!lease.acquired) return { kind: 'wait', reason: 'helper-seat-lease-held' };
    if (!this.deps.hasCapacity()) {
      this.deps.lease.release(holder);
      return { kind: 'wait', reason: 'session-capacity-full' };
    }
    let seat: ReloginHelperSeat | null;
    try { seat = await this.deps.pickSeat(episode.accountId, signal); }
    catch (error) {
      this.deps.lease.release(holder);
      throw error;
    }
    if (!seat || seat.accountId === episode.accountId) {
      this.deps.lease.release(holder);
      return { kind: 'no-healthy-seat' };
    }
    this.seats.set(episode.id, seat);
    return { kind: 'ok' };
  }

  /** Releases what `preAttempt` acquired, unless a drive for this episode is still live. */
  releaseAttempt(episode: SubscriptionReloginEpisode): void {
    if (this.live.has(episode.id)) return;
    this.seats.delete(episode.id);
    this.deps.lease.release(SubscriptionReloginHelper.holderId(episode.id));
  }

  /** The `driveBrowser` port on the agent-session path. Always kills the helper and releases the lease. */
  async drive(input: ReloginHelperDriveInput, signal: AbortSignal): Promise<BrowserRepairResult> {
    const { episode } = input;
    const holder = SubscriptionReloginHelper.holderId(episode.id);
    if (this.live.has(episode.id)) return { outcome: 'transient', failureClass: 'seat-busy', reason: 'agent-helper-already-live' };
    const lease = this.deps.lease.acquire(holder, 'subscription sign-in repair helper');
    if (!lease.acquired) return { outcome: 'transient', failureClass: 'seat-busy', reason: 'agent-helper-seat-lease-held' };

    let seat = this.seats.get(episode.id) ?? null;
    const token = randomBytes(32).toString('base64url');
    let tmuxSession: string | null = null;
    let renew: ReturnType<typeof setInterval> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let onAbort: (() => void) | null = null;
    try {
      if (!seat) {
        seat = await this.deps.pickSeat(episode.accountId, signal);
        if (!seat || seat.accountId === episode.accountId) {
          return { outcome: 'operator-only', failureClass: 'no-healthy-seat', reason: 'agent-no-healthy-seat' };
        }
      }
      const expiresAt = Date.parse(input.artifact.expiresAt);
      const capMs = Math.min(this.capMs, Number.isFinite(expiresAt) ? expiresAt - 60_000 - this.now() : this.capMs);
      if (capMs <= 0) return { outcome: 'transient', failureClass: 'artifact-expired', reason: 'agent-login-expiring' };

      renew = setInterval(() => { try { this.deps.lease.acquire(holder, 'subscription sign-in repair helper'); } catch { /* renewal retried next interval */ } },
        this.leaseRenewMs);
      renew.unref?.();

      // The authenticator step needs an auditable transcript: only a Claude Code helper seat gets it.
      const authenticatorMode = seat.framework === CLAUDE_CODE_FRAMEWORK ? (input.authenticatorMode ?? 'off') : 'off';
      const outcome = new Promise<BrowserRepairResult>((resolve) => {
        this.live.set(episode.id, {
          tokenHash: hashToken(token), tmuxSession: null, codeTaken: false, settled: false,
          authenticatorMode,
          codesGranted: this.deps.authenticatorCodesGranted?.(episode.id) ?? 0,
          driveId: randomUUID(),
          settle: (result) => { const e = this.live.get(episode.id); if (e) e.settled = true; resolve(result); },
        });
      });
      const settle = (result: BrowserRepairResult): void => { this.live.get(episode.id)?.settle(result); };

      try {
        tmuxSession = await this.deps.spawn({
          name: SubscriptionReloginHelper.sessionName(episode.id),
          prompt: renderHelperPrompt({ ...input, authenticatorMode, browserDriver: this.deps.browserDriver, token, port: this.deps.serverPort, seat }),
          seat, maxDurationMinutes: Math.max(1, Math.ceil(capMs / 60_000)),
        });
      } catch {
        // A spawn refused after the pre-attempt capacity check (a race): transient, retried in budget.
        return { outcome: 'transient', failureClass: 'seat-busy', reason: 'agent-helper-spawn-refused' };
      }
      const entry = this.live.get(episode.id);
      if (entry) entry.tmuxSession = tmuxSession;

      if (signal.aborted) throw abortError();
      onAbort = () => settle({ outcome: 'transient', failureClass: 'provider-transient', reason: 'agent-helper-aborted' });
      signal.addEventListener('abort', onAbort, { once: true });

      const startedAt = this.now();
      let exitedAt: number | null = null;
      let checking = false;
      poll = setInterval(() => {
        if (checking) return;
        checking = true;
        void (async () => {
          try {
            const elapsed = this.now() - startedAt;
            if (input.artifact.kind === 'device-code' && await this.deps.credentialReady(episode)) {
              settle({ outcome: 'approved' });
              return;
            }
            if (elapsed >= capMs) {
              settle({ outcome: 'refused', failureClass: 'agent-sign-in-unfinished', reason: 'agent-helper-cap-reached' });
              return;
            }
            const alive = tmuxSession !== null && this.deps.isAlive(tmuxSession);
            if (alive) { exitedAt = null; return; }
            if (elapsed < this.startGraceMs) return;
            exitedAt ??= this.now();
            // A device-code CLI can finish a few seconds after the helper exits; give it a moment.
            const settleWindow = input.artifact.kind === 'device-code' ? this.exitSettleMs : 0;
            if (this.now() - exitedAt >= settleWindow) {
              settle({ outcome: 'refused', failureClass: 'agent-sign-in-unfinished', reason: 'agent-helper-exited' });
            }
          } catch {
            // @silent-fallback-ok — a failed probe is retried on the next poll; the cap still bounds the wait.
          } finally {
            checking = false;
          }
        })();
      }, this.pollMs);
      poll.unref?.();

      const result = await outcome;
      if (signal.aborted) throw abortError();
      return result;
    } finally {
      if (poll) clearInterval(poll);
      if (renew) clearInterval(renew);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      // Kill before dropping the live entry: a helper that outlived a failed kill still holds the
      // agent's token, so it stays counted as driving until it is really gone.
      if (tmuxSession) {
        try { this.deps.kill(tmuxSession); } catch {
          // @silent-fallback-ok — boot cleanup reaps a survivor; until then it counts as driving
          this.unreaped.add(tmuxSession);
        }
      }
      this.live.delete(episode.id);
      this.seats.delete(episode.id);
      this.deps.lease.release(holder);
    }
  }

  /**
   * The one route the helper may call (spec §5). Auth is the per-episode token; the body is a
   * strict tagged union. Never logs the body or the code.
   */
  submit(episodeId: string, token: string, body: unknown): ReloginHelperSubmitResult {
    const entry = this.live.get(episodeId);
    if (!entry) return { status: 409, body: { error: 'no-live-helper' } };
    if (!token || !safeEqual(hashToken(token), entry.tokenHash)) return { status: 403, body: { error: 'invalid-helper-token' } };
    if (!entry.tmuxSession || !this.deps.isAlive(entry.tmuxSession)) return { status: 409, body: { error: 'helper-not-live' } };
    const parsed = parseHelperBody(body);
    if (!parsed) return { status: 400, body: { error: 'invalid-helper-body' } };
    if (entry.settled) return { status: 409, body: { error: 'already-settled' } };
    if (parsed.kind === 'code') {
      if (entry.codeTaken) return { status: 409, body: { error: 'code-already-accepted' } }; // defensive: an accepted code also settles the drive
      if (!this.deps.validateCode(parsed.code)) return { status: 400, body: { error: 'invalid-code-shape' } };
      entry.codeTaken = true;
      entry.settle({ outcome: 'approved', pasteCode: parsed.code });
      return { status: 202, body: { accepted: true } };
    }
    if (parsed.kind === 'authenticator') {
      const heading = classifyAuthenticatorHeading(parsed.heading);
      const noted = (entry.authenticatorNoted ??= new Set());
      const note = (label: string): void => {
        // Labels that block a slow retry, and the grant record the latch counts, are never dropped.
        const challenge = /^(intent-heading-2sv|rejected-|code-refused-|code-1-|code-2-|no-option-)/.test(label);
        if (noted.has(label) || (!challenge && noted.size >= MAX_AUTHENTICATOR_EVENTS)) return;
        noted.add(label);
        this.deps.noteAuthenticator?.(episodeId, label);
      };
      if (parsed.result === 'intent' || parsed.result === 'code') {
        // The server, not the helper, decides whether the step may go ahead: only in `on` mode,
        // only for an exact "2-Step Verification" heading, and at most two codes per attempt.
        let reason: string | null = entry.authenticatorMode !== 'on' ? 'not-enabled'
          : parsed.origin !== GOOGLE_SIGNIN_ORIGIN ? 'origin-not-google'
            : heading !== '2sv' ? 'heading-not-2sv' : null;
        if (!reason && parsed.result === 'intent' && !entry.intentGranted) {
          // Supervised first uses: a new use starts only when every earlier one has been reviewed.
          const latch = this.deps.authenticatorLatch?.(entry.driveId ?? '') ?? 'open';
          if (latch !== 'open') reason = latch;
        }
        if (!reason && parsed.result === 'code' && !entry.intentGranted) reason = 'no-intent';
        // A fail recorded mid-drive stops further codes in a drive that was already granted.
        if (!reason && parsed.result === 'code' && this.deps.authenticatorLatch?.(entry.driveId ?? '') === 'review-failed') reason = 'review-failed';
        if (!reason && parsed.result === 'code') {
          if ((entry.codesGranted ?? 0) >= MAX_AUTHENTICATOR_CODES) reason = 'code-limit';
          else entry.codesGranted = (entry.codesGranted ?? 0) + 1;
        }
        const proceed = reason === null;
        if (proceed && parsed.result === 'intent' && !entry.intentGranted) {
          entry.intentGranted = true;
          this.deps.noteAuthenticatorUse?.(episodeId, entry.driveId ?? '');
        }
        note(parsed.result === 'code'
          ? (proceed ? `code-${entry.codesGranted}-heading-${heading}` : `code-refused-${reason}`)
          : (proceed ? `intent-heading-${heading}` : `intent-refused-${reason}`));
        return { status: 202, body: { accepted: true, notice: 'authenticator', proceed, ...(reason ? { reason } : {}) } };
      }
      // Reports: audit only; never settle the drive, never a notice.
      note(`${parsed.result}-heading-${heading}`);
      return { status: 202, body: { accepted: true, notice: 'authenticator' } };
    }
    if (parsed.kind === 'phone-tap') {
      this.deps.queuePhoneTap(episodeId);
      return { status: 202, body: { accepted: true, notice: 'phone-tap' } };
    }
    if (parsed.kind === 'hard-line' && parsed.line === 'device-limit') {
      // codex-device-limit-tripwire §4: a device-limit page ends THIS repair terminally and is
      // never retried. It is deliberately not an `agent-hard-line` (that would hold the cell at
      // approval and count toward unattended graduation); a fresh read decides any bench.
      entry.settle({ outcome: 'refused', failureClass: 'device-limit', reason: 'agent-reported-device-limit' });
      this.deps.onDeviceLimitReported?.(episodeId);
      return { status: 202, body: { accepted: true, notice: 'device-limit' } };
    }
    if (parsed.kind === 'hard-line') {
      // Every report is the same unverified class: never breaker or re-admission evidence, but it
      // holds the account × machine at approval until the next verified success.
      entry.settle({ outcome: 'operator-only', failureClass: 'agent-hard-line', reason: `agent-hard-line-${parsed.line}` });
      return { status: 202, body: { accepted: true, notice: 'hard-line' } };
    }
    entry.settle({ outcome: 'operator-only', failureClass: 'automation-permission',
      reason: `agent-permission-${parsed.permission}` });
    return { status: 202, body: { accepted: true, notice: 'macos-permission' } };
  }

  /** True while this episode's helper drive is in flight in this process. */
  isDriving(episodeId: string): boolean { return this.live.has(episodeId); }

  /**
   * True while any helper drive is in flight in this process, or a helper session outlived a failed
   * kill and is still alive (no pass or inconclusive review may be recorded then).
   */
  isAnyDriving(): boolean {
    for (const tmux of [...this.unreaped]) {
      let alive = true;
      try { alive = this.deps.isAlive(tmux); } catch { /* @silent-fallback-ok — unknown counts as alive */ }
      if (!alive) this.unreaped.delete(tmux);
    }
    return this.live.size > 0 || this.unreaped.size > 0;
  }

  /** Kill the helper session for an episode this process is not driving (restart recovery). */
  killOrphan(episodeId: string): void {
    if (this.live.has(episodeId)) return;
    const name = SubscriptionReloginHelper.sessionName(episodeId);
    for (const helper of this.deps.listHelpers()) {
      if (helper.name === name) {
        try { this.deps.kill(helper.tmuxSession); } catch { /* @silent-fallback-ok — best effort */ }
      }
    }
  }

  /** Boot cleanup: kill every `relogin-*` session whose episode this process is not driving. */
  killOrphans(): number {
    let killed = 0;
    for (const helper of this.deps.listHelpers()) {
      if (!helper.name.startsWith(HELPER_NAME_PREFIX)) continue;
      if (this.live.has(helper.name.slice(HELPER_NAME_PREFIX.length))) continue;
      try { this.deps.kill(helper.tmuxSession); killed++; } catch { /* @silent-fallback-ok — best effort */ }
    }
    return killed;
  }
}

type HelperBody =
  | { kind: 'code'; code: string }
  | { kind: 'phone-tap' }
  | { kind: 'authenticator'; result: AuthenticatorResult; heading: string; origin: string }
  | { kind: 'macos-permission'; permission: string }
  | { kind: 'hard-line'; line: string };

/** Strict tagged union: exactly one of the four shapes, nothing else. Exported for tests. */
export function parseHelperBody(body: unknown): HelperBody | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0 || keys.length > MAX_BODY_KEYS) return null;
  if (keys.length === 1 && keys[0] === 'code') {
    return typeof record.code === 'string' && record.code.length > 0 && record.code.length <= 512
      ? { kind: 'code', code: record.code } : null;
  }
  if (keys.length === 1 && keys[0] === 'notify' && record.notify === 'phone-tap') return { kind: 'phone-tap' };
  if (keys.length === 4 && record.notify === 'authenticator' && 'result' in record && 'heading' in record && 'origin' in record
    && typeof record.result === 'string' && AUTHENTICATOR_RESULTS.has(record.result as AuthenticatorResult)
    && typeof record.heading === 'string' && record.heading.length <= MAX_HEADING_CHARS
    && typeof record.origin === 'string' && record.origin.length <= MAX_HEADING_CHARS) {
    return { kind: 'authenticator', result: record.result as AuthenticatorResult, heading: record.heading, origin: record.origin };
  }
  if (keys.length === 2 && record.notify === 'macos-permission' && 'permission' in record
    && typeof record.permission === 'string' && PERMISSIONS.has(record.permission)) {
    return { kind: 'macos-permission', permission: record.permission };
  }
  if (keys.length === 2 && record.notify === 'hard-line' && 'line' in record
    && typeof record.line === 'string' && HARD_LINES.has(record.line)) {
    return { kind: 'hard-line', line: record.line };
  }
  return null;
}

/** The fixed, server-rendered helper prompt. Exported for tests. */
export function renderHelperPrompt(input: ReloginHelperDriveInput & { token: string; port: number; seat: ReloginHelperSeat }): string {
  const { episode, artifact } = input;
  const route = `http://127.0.0.1:${input.port}/subscription-relogin/${episode.id}/code`;
  const post = (json: string) =>
    `printf '%s' '${json}' | curl -s -X POST '${route}' -H 'Content-Type: application/json' -H 'X-Relogin-Helper-Token: ${input.token}' --data-binary @-`;
  const windows = input.browserDriver === 'windows';
  const lines = [
    `You are a sign-in helper for Instar's automatic subscription repair, episode ${episode.id}.`,
    'Follow the /subscription-signin skill, section 3 ("Signing in by hand"), and its "Agent-run repair" subsection, then stop.',
    ...(windows ? ['This is Windows: section 3\'s "On Windows (WSL)" subsection replaces its macOS steps. Drive Chrome only through .instar/scripts/browser/ndrive.sh.'] : []),
    '',
    `Account to sign in: ${input.expectedEmail} (${input.provider === 'openai' ? 'Codex / OpenAI' : 'Claude / Anthropic'}). Sign in ONLY this account.`,
    windows
      ? `Its Chrome profile directory (a Windows path): ${input.profileDir} — launch it with ndrive.sh, or attach if Chrome already runs on it.`
      : `Its Chrome profile directory: ${input.profileDir} — open it the ordinary way, as section 3 says.`,
    `Verification URL: ${input.verificationUrl}`,
    ...(artifact.kind === 'device-code' && artifact.userCode
      ? [`Device code: ${artifact.userCode}. The CLI finishes on its own once the page says you are signed in; do not post a code.`]
      : ['When the page shows the authorization code, send it to Instar without printing it:',
        `  read the code into a variable from the page, then: ${post('{"code":"<the code>"}')}`]),
    `Vault entries for this account (fetch by NAME, pipe over stdin, never print): ${input.vaultBindingNames.length > 0 ? input.vaultBindingNames.join(', ') : '(none bound)'}`,
    '',
    'The CLI login is ALREADY started. Do not start, cancel, reissue or complete any login, and do not call the pool enroll routes.',
    'If Google opens on a passkey screen, choose "Try another way", then "Enter your password".',
    'Once Google accepts the second step, finish in that SAME Chrome window. Do not close and relaunch Chrome mid-sign-in: that loses the session.',
    ...(input.authenticatorMode === 'shadow'
      ? ['Observation only, for this account: if Google shows a phone prompt ("Check your phone", "Open the Gmail app", a number to tap), first read the page',
        `heading from the page itself ${windows ? '(on Windows: the element with the Heading role at the top of the page in `ndrive.sh tree`, confirmed with `ndrive.sh shot`)' : '(the text of its h1 element, read with the same in-page script you use to check the focused field)'}. Then decide, by the rules a later version will`,
        'act on, whether you WOULD use the authenticator code here: yes only for a page on https://accounts.google.com headed exactly "2-Step Verification"',
        'that shows no CAPTCHA and no',
        'unusual- or suspicious-activity warning. Record it once, with the heading and the page origin you read:',
        `  ${post('{"notify":"authenticator","result":"shadow-would-use","heading":"<the heading text>","origin":"<the page origin>"}')}  (or "shadow-would-stop")`,
        'Do not click "Try another way" and do not enter any code.',
        `If a phone tap or "Is it you?" prompt appears, ask the operator once: ${post('{"notify":"phone-tap"}')}`]
      : input.authenticatorMode === 'on'
      ? ['This account has an authenticator code saved. One extra step is allowed, on ONE kind of page only: a Google page whose heading reads',
        `"2-Step Verification", shown after the password. Read that heading from the page itself ${windows ? '(on Windows: the element with the Heading role at the top of the page in `ndrive.sh tree`, confirmed with `ndrive.sh shot`)' : '(the text of its h1 element, read with the same in-page script you use to check the focused field)'},`,
        'not from your memory of the page. Read the page origin the same way (it must be https://accounts.google.com). If the page shows more than one',
        'heading and you cannot tell which is the page title, send an empty heading.',
        'Risk always wins: if the page shows a CAPTCHA, or warns of unusual or suspicious activity, it is Google\'s risk check and a hard line below, even',
        'under a "2-Step Verification" heading. Ordinary wording on that page such as "Google wants to make sure it\'s really you" is normal and is not a warning.',
        'If Google asks for the authenticator code directly, enter it as you always have; nothing below applies.',
        'If instead the allowed page opens on something else ("Check your phone", "Open the Gmail app", a number to tap, a code sent by text):',
        `  1. Ask Instar first, with the heading and origin you read: ${post('{"notify":"authenticator","result":"intent","heading":"<the heading text>","origin":"<the page origin>"}')}`,
        '     Go on only if the answer contains "proceed":true.',
        '  2. Choose "Try another way", then the option to get a verification code from the Google Authenticator app.',
        `  3. Before typing EACH code, ask again: ${post('{"notify":"authenticator","result":"code","heading":"<the heading text>","origin":"<the page origin>"}')}`,
        '     Type it only if the answer contains "proceed":true; Instar allows at most two codes. If Google rejects the first, report it (step 4),',
        '     wait for the next 30-second window, and ask again for the second. Make each code from the authenticator vault entry, over stdin, never printed.',
        `  4. After the page settles, record what happened, with the heading and origin you read BEFORE entering the code: ${post('{"notify":"authenticator","result":"accepted","heading":"<the heading text>","origin":"<the page origin>"}')}`,
        '     (result "rejected", or "no-option" when the list has no authenticator option).',
        'If Instar answers "proceed":false at step 1 (for example "awaiting-review", a use waiting for its review), stay on the phone prompt and ask the',
        `  operator once for the tap: ${post('{"notify":"phone-tap"}')}. If it answers "proceed":false at step 3, if a second code is rejected, or if the list`,
        '  has no authenticator option, report the "phone-confirmation" hard line and stop.',
        'Any other page is NOT this step, even if it lists the authenticator code. A page whose point is to check that it is really you or to flag',
        'something unusual (for example "Verify it\'s you", "Confirm it\'s you", unusual or suspicious activity), or a CAPTCHA, is Google\'s risk check',
        'and a hard line below. Judge that by what the page is asking, not by matching those words. If you cannot read the heading, or cannot tell',
        `which page it is, treat it as a risk check and ask the operator once for the phone tap: ${post('{"notify":"phone-tap"}')}`]
      : [`If a phone tap or "Is it you?" prompt appears, ask the operator once: ${post('{"notify":"phone-tap"}')}`]),
    ...(windows ? [] : ['If macOS asks for Screen Recording, Accessibility or Automation permission, report it and stop:',
      `  ${post('{"notify":"macos-permission","permission":"screen-recording"}')}  (or "accessibility" / "automation")`]),
    '',
    'Hard lines (these five, and only these five):',
    `1. Sign in the expected account (${input.expectedEmail}) only.`,
    input.authenticatorMode === 'on'
      ? '2. Never solve or work around a CAPTCHA or a phone / "verify it\'s you" check. After choosing "Try another way" on a page headed "2-Step Verification", the authenticator code is allowed only while Instar answers "proceed":true; a code Google asks for directly is entered as always; otherwise ask for the phone tap or report the "phone-confirmation" hard line, as the steps above say.'
      : '2. Never solve or work around a CAPTCHA or a phone / "verify it\'s you" check; only ask for the phone tap above.',
    '3. Type passwords only on Google, Claude or OpenAI pages.',
    windows ? '4. Never touch a Chrome window that is not on this account\'s profile directory.' : '4. Never touch a Chrome window you did not open.',
    '5. If a page says this device has reached its limit of paid accounts ("Device limit reached" or similar), stop: another sign-in here cannot help.',
    '',
    ...(windows ? ['Set ND_EXPECT_HOST to the host you mean on every command that clicks or types, so nothing lands on another page. Read the page text before typing.',
        'Enter the sign-in link the way the skill says (over stdin, into the address bar). Fill every other field only by its `editfields` index, and pipe each secret to typesecretedit on stdin.']
      : ['Before EVERY keystroke burst, check that the frontmost process is the Chrome you opened and that',
        'document.activeElement is the password or code field you mean. Re-check after anything that can move focus.']),
    'If you reach a hard line, report which one and stop (the repair then waits for the operator and is never retried on its own):',
    `  ${post('{"notify":"hard-line","line":"captcha"}')}  (or "phone-confirmation" / "wrong-account" / "unexpected-site" / "device-limit")`,
    'You cannot message anyone. If you cannot finish for any other reason, write the reason in your final output and exit.',
    `Instar verifies the signed-in account itself; your word never counts as success. When done, ${windows ? 'close the tab you used (ctrl w)' : 'close only the Chrome you opened'} and exit.`,
  ];
  return lines.join('\n');
}

function hashToken(token: string): Buffer { return createHash('sha256').update(token).digest(); }
function safeEqual(a: Buffer, b: Buffer): boolean { return a.length === b.length && timingSafeEqual(a, b); }
function abortError(): Error { const error = new Error('aborted'); error.name = 'AbortError'; return error; }
