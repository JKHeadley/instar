/**
 * Skill-driven sign-in repair (spec docs/specs/skill-driven-signin-repair.md).
 *
 * On macOS the browser step of a repair episode is done by ONE short-lived agent session that
 * follows `/subscription-signin` section 3 — exactly what the hand-run repairs did. The session
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
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { BrowserRepairResult, ReloginArtifact, ReloginPreAttemptVerdict } from './SubscriptionReloginOrchestrator.js';
import type { SubscriptionReloginEpisode } from './SubscriptionReloginStore.js';
import type { PlaywrightSeatLeaseResult, PlaywrightSeatReleaseResult } from './PlaywrightSeatLease.js';

/** The pool account a helper session runs on: never the account under repair. */
export interface ReloginHelperSeat {
  accountId: string;
  framework: 'claude-code' | 'codex-cli';
  configHome: string;
}

export interface ReloginHelperDriveInput {
  episode: SubscriptionReloginEpisode;
  artifact: ReloginArtifact;
  verificationUrl: string;
  expectedEmail: string;
  provider: 'anthropic' | 'openai';
  /** The account's own Chrome profile directory (opened the ordinary way by the helper). */
  profileDir: string;
  /** Names (never values) of the account's vault bindings. */
  vaultBindingNames: string[];
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
  /** The existing paste-back code-shape validator. */
  validateCode: (code: string) => boolean;
  /** The local server port the helper posts to (loopback). */
  serverPort: number;
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
const MAX_BODY_KEYS = 2;
const PERMISSIONS = new Set(['screen-recording', 'accessibility', 'automation']);

interface LiveDrive {
  tokenHash: Buffer;
  tmuxSession: string | null;
  codeTaken: boolean;
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

      const outcome = new Promise<BrowserRepairResult>((resolve) => {
        this.live.set(episode.id, {
          tokenHash: hashToken(token), tmuxSession: null, codeTaken: false,
          settle: (result) => resolve(result),
        });
      });
      const settle = (result: BrowserRepairResult): void => { this.live.get(episode.id)?.settle(result); };

      try {
        tmuxSession = await this.deps.spawn({
          name: SubscriptionReloginHelper.sessionName(episode.id),
          prompt: renderHelperPrompt({ ...input, token, port: this.deps.serverPort, seat }),
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
      this.live.delete(episode.id);
      this.seats.delete(episode.id);
      if (tmuxSession) {
        try { this.deps.kill(tmuxSession); } catch { /* @silent-fallback-ok — boot cleanup reaps a survivor */ }
      }
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
    if (parsed.kind === 'code') {
      if (entry.codeTaken) return { status: 409, body: { error: 'code-already-accepted' } };
      if (!this.deps.validateCode(parsed.code)) return { status: 400, body: { error: 'invalid-code-shape' } };
      entry.codeTaken = true;
      entry.settle({ outcome: 'approved', pasteCode: parsed.code });
      return { status: 202, body: { accepted: true } };
    }
    if (parsed.kind === 'phone-tap') {
      this.deps.queuePhoneTap(episodeId);
      return { status: 202, body: { accepted: true, notice: 'phone-tap' } };
    }
    entry.settle({ outcome: 'operator-only', failureClass: 'automation-permission',
      reason: `agent-permission-${parsed.permission}` });
    return { status: 202, body: { accepted: true, notice: 'macos-permission' } };
  }

  /** True while this episode's helper drive is in flight in this process. */
  isDriving(episodeId: string): boolean { return this.live.has(episodeId); }

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
  | { kind: 'macos-permission'; permission: string };

/** Strict tagged union: exactly one of the three shapes, nothing else. Exported for tests. */
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
  if (keys.length === 2 && record.notify === 'macos-permission' && 'permission' in record
    && typeof record.permission === 'string' && PERMISSIONS.has(record.permission)) {
    return { kind: 'macos-permission', permission: record.permission };
  }
  return null;
}

/** The fixed, server-rendered helper prompt. Exported for tests. */
export function renderHelperPrompt(input: ReloginHelperDriveInput & { token: string; port: number; seat: ReloginHelperSeat }): string {
  const { episode, artifact } = input;
  const route = `http://127.0.0.1:${input.port}/subscription-relogin/${episode.id}/code`;
  const post = (json: string) =>
    `printf '%s' '${json}' | curl -s -X POST '${route}' -H 'Content-Type: application/json' -H 'X-Relogin-Helper-Token: ${input.token}' --data-binary @-`;
  const lines = [
    `You are a sign-in helper for Instar's automatic subscription repair, episode ${episode.id}.`,
    'Follow the /subscription-signin skill, section 3 ("Signing in by hand"), and its "Agent-run repair" subsection, then stop.',
    '',
    `Account to sign in: ${input.expectedEmail} (${input.provider === 'openai' ? 'Codex / OpenAI' : 'Claude / Anthropic'}). Sign in ONLY this account.`,
    `Its Chrome profile directory: ${input.profileDir} — open it the ordinary way, as section 3 says.`,
    `Verification URL: ${input.verificationUrl}`,
    ...(artifact.kind === 'device-code' && artifact.userCode
      ? [`Device code: ${artifact.userCode}. The CLI finishes on its own once the page says you are signed in; do not post a code.`]
      : ['When the page shows the authorization code, send it to Instar without printing it:',
        `  read the code into a variable from the page, then: ${post('{"code":"<the code>"}')}`]),
    `Vault entries for this account (fetch by NAME, pipe over stdin, never print): ${input.vaultBindingNames.length > 0 ? input.vaultBindingNames.join(', ') : '(none bound)'}`,
    '',
    'The CLI login is ALREADY started. Do not start, cancel, reissue or complete any login, and do not call the pool enroll routes.',
    `If a phone tap or "Is it you?" prompt appears, ask the operator once: ${post('{"notify":"phone-tap"}')}`,
    'If macOS asks for Screen Recording, Accessibility or Automation permission, report it and stop:',
    `  ${post('{"notify":"macos-permission","permission":"screen-recording"}')}  (or "accessibility" / "automation")`,
    '',
    'Hard lines (these four, and only these four):',
    `1. Sign in the expected account (${input.expectedEmail}) only.`,
    '2. Never solve or work around a CAPTCHA or a phone / "verify it\'s you" check; only ask for the phone tap above.',
    '3. Type passwords only on Google, Claude or OpenAI pages.',
    '4. Never touch a Chrome window you did not open.',
    '',
    'Before EVERY keystroke burst, check that the frontmost process is the Chrome you opened and that',
    'document.activeElement is the password or code field you mean. Re-check after anything that can move focus.',
    'You cannot message anyone. If you reach a hard line or cannot finish, write the reason in your final output and exit.',
    'Instar verifies the signed-in account itself; your word never counts as success. When done, close only the Chrome you opened and exit.',
  ];
  return lines.join('\n');
}

function hashToken(token: string): Buffer { return createHash('sha256').update(token).digest(); }
function safeEqual(a: Buffer, b: Buffer): boolean { return a.length === b.length && timingSafeEqual(a, b); }
function abortError(): Error { const error = new Error('aborted'); error.name = 'AbortError'; return error; }
