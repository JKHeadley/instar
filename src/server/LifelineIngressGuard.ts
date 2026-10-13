/**
 * LifelineIngressGuard — decides whether a request on the internal Telegram
 * routes (`/internal/telegram-forward`, `/internal/telegram-callback`,
 * `/internal/lifeline-proof`) proved it came from the lifeline.
 *
 * Spec: docs/specs/telegram-internal-route-lifeline-secret.md
 *
 * Signal vs. authority: this is an exact, deterministic credential check
 * (constant-time compare of a random secret), not a judgment about meaning, so
 * it may hold blocking authority. Uncertainty about OUR side (secret file
 * unreadable, state file unwritable) fails toward DELIVERY of messages and is
 * counted — the agent must stay reachable — but never toward trusting a sender.
 *
 * Two modes:
 *   observe — accept a message without the secret, and count a `would-refuse`.
 *   enforce — refuse it (typed 401).
 *
 * The rules:
 *   1. ARM ON PROOF. Nothing is refused until this guard has seen a request
 *      from the lifeline carrying the valid secret (persisted). A lifeline
 *      that predates this feature has never proven itself, so it is never
 *      refused — its requests are accepted and counted, and the restart signal
 *      moves it onto the new version. A current lifeline proves itself at
 *      startup (`/internal/lifeline-proof`), so arming does not wait for a
 *      Telegram message. Where the lifeline is not the Telegram ingress at all
 *      (the server polls Telegram itself, or Telegram is not configured),
 *      there is no lifeline to wait for and the guard arms at once.
 *   2. NO SENDER TRUST WITHOUT PROOF, ONCE PROOF IS POSSIBLE. After arming, a
 *      message accepted without the secret (observe) is still delivered, but
 *      its body-supplied sender id is not an authenticated sender; and a
 *      button tap — which is nothing but a privileged act — is refused in
 *      either mode. In ENFORCE the same holds once the guard has been
 *      unarmed for `PRE_ARM_TRUST_MS`: there, the pre-change behaviour (trust
 *      the body) is a bounded migration allowance. In OBSERVE an unarmed
 *      guard changes nothing for as long as it stays unarmed — a fleet agent
 *      whose lifeline has not updated is reported loudly, but its operator's
 *      real messages and taps are never degraded without a soak (the
 *      maturation path: development agents take the strict behaviour first).
 *      Messages are never REFUSED before arming, in any mode.
 *   3. OBSERVE HAS AN EXIT. With no explicit setting on a fleet agent, observe
 *      graduates to enforce by itself after `EXIT_QUIET_MS` with zero
 *      would-refuse and at least `EXIT_MIN_VERIFIED` verified Telegram
 *      requests in that window — and, whatever the counts say, no later than
 *      `EXIT_DEADLINE_MS` after arming. The deadline exists because a caller
 *      holding only the Bearer token can keep the quiet window from closing by
 *      sending secretless requests. The evidence is persisted, so a server
 *      restart does not reset it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveDevAgentGate } from '../core/devAgentGate.js';
import {
  LifelineIngressSecretHolder,
  lifelineSecretMatches,
  LIFELINE_SECRET_HEADER,
  LIFELINE_INGRESS_CALLER_HEADER,
  LIFELINE_INGRESS_CALLER_SERVER_SELF,
} from '../core/LifelineIngressSecret.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

export type LifelineIngressMode = 'observe' | 'enforce';
export type LifelineIngressRoute = 'telegram-forward' | 'telegram-callback' | 'lifeline-proof';
export type LifelineIngressRefusalReason = 'missing' | 'mismatch';

/** Observe exits after this long with zero would-refuse … */
export const EXIT_QUIET_MS = 24 * 60 * 60 * 1000;
/** … and at least this many verified Telegram requests inside that window. */
export const EXIT_MIN_VERIFIED = 10;
/** Hard ceiling: observe ends this long after arming, whatever the counts say. */
export const EXIT_DEADLINE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Minimum gap between restart-signal writes BEFORE the lifeline has proven
 * itself (the rollout nudge for a lifeline still on older code). Two a day at
 * most: lifeline restarts on this signal share a daily cap of three with
 * genuine version-skew restarts, and must not be able to use it up.
 */
export const SIGNAL_GAP_UNARMED_MS = 12 * 60 * 60 * 1000;
/**
 * Minimum gap AFTER arming. A secretless request is then almost never a
 * version problem (the lifeline has shown it sends the secret and re-reads a
 * stale one by itself), so one write a day is the whole budget — a caller with
 * only the Bearer token cannot drive lifeline restarts faster than that.
 */
export const SIGNAL_GAP_ARMED_MS = 24 * 60 * 60 * 1000;
/** A lifeline that has not proven itself for this long is reported. */
export const UNARMED_REPORT_AFTER_MS = 60 * 60 * 1000;
/**
 * In ENFORCE, how long an UNARMED guard keeps the pre-change behaviour
 * (body-supplied sender trusted, taps accepted) for a lifeline still on older
 * code. After it, an unproven message is delivered without sender trust and an
 * unproven tap is refused, armed or not. In OBSERVE the allowance does not
 * expire; passing this age only raises the operator attention item. Messages
 * are never refused before arming.
 */
export const PRE_ARM_TRUST_MS = 24 * 60 * 60 * 1000;
/**
 * A current lifeline proves itself within one 15-second tick of the server
 * being up. This long after construction, a guard that is still unarmed asks
 * the lifeline to restart (one budgeted signal write) instead of waiting for
 * the first Telegram message to do it.
 */
export const BOOT_NUDGE_DELAY_MS = 60 * 1000;
/** The security attention item is raised at most this often (persisted). */
export const ATTENTION_GAP_MS = 24 * 60 * 60 * 1000;
/** A wrong secret BEFORE arming is reported once seen this many times in a row. */
export const MISMATCH_REPORT_AFTER = 3;
/** Unverified requests write through up to this many times per window … */
export const PERSIST_BURST = 5;
/** … then their counter writes are coalesced to one per this. */
export const PERSIST_COALESCE_MS = 1000;

/**
 * The state file sits under the secret's own name prefix on purpose: that
 * prefix is in KEY_MATERIAL_PATHS, so the file routes never serve or edit it,
 * backups skip it and git ignores it — without those, the Bearer token alone
 * could rewrite `armedAt` through the file editor.
 */
export const LIFELINE_INGRESS_STATE_RELPATH = path.join('state', 'lifeline-ingress-secret.guard.json');

export interface LifelineIngressState {
  version: 1;
  /** When this guard first recorded anything on this machine. */
  observingSince: string;
  /** Requests that carried the valid secret (lifeline + server-self). */
  verified: number;
  /** Valid-secret requests from the server's own re-injection call. */
  verifiedServerSelf: number;
  /** Accepted requests that enforce would have refused. */
  wouldRefuse: number;
  /** Requests actually refused. */
  refused: number;
  /** Requests handled while OUR secret could not be read. */
  secretUnavailable: number;
  byReason: Record<LifelineIngressRefusalReason, number>;
  byRoute: Record<LifelineIngressRoute, { verified: number; wouldRefuse: number; refused: number }>;
  lastVerifiedAt: string | null;
  lastWouldRefuseAt: string | null;
  lastRefusedAt: string | null;
  lastReason: LifelineIngressRefusalReason | null;
  /** Verified Telegram requests from the lifeline since the last would-refuse / refusal. */
  verifiedSinceLastWouldRefuse: number;
  /** When the guard armed. Null = never. */
  armedAt: string | null;
  /** What armed it. */
  armedBy: 'lifeline-proof' | 'no-lifeline-ingress' | null;
  /** `armedAt` + EXIT_DEADLINE_MS, recorded when the guard arms. */
  enforceDeadlineAt: string | null;
  /** When the observe exit rule was met. Null = not graduated. */
  graduatedAt: string | null;
  /** Which arm of the exit rule graduated it. */
  graduatedBy: 'quiet-window' | 'deadline' | null;
  /** Last restart-signal write (persisted so a server restart keeps the budget). */
  lastSignalAt: string | null;
  /**
   * Last operator attention item PER KIND (persisted throttle). Per kind, so a
   * recoverable notice ("the lifeline has not updated") can never use up the
   * slot a later security notice needs.
   */
  attentionAt: Record<string, string>;
}

export interface LifelineIngressDecision {
  action: 'accept' | 'refuse';
  verified: boolean;
  mode: LifelineIngressMode;
  /** Set when the request did not prove itself. */
  reason?: LifelineIngressRefusalReason | 'secret-unavailable';
  /**
   * May this request's body-supplied sender id be treated as the
   * AUTHENTICATED sender (operator auto-bind)? True for a verified request,
   * and for an unverified one only while the guard has never armed (the
   * pre-change lifeline, handled as before). False once proof is possible and
   * absent, and false when our own secret is unreadable.
   */
  senderTrusted: boolean;
  /**
   * The caller sent a secret that is not ours and was accepted anyway
   * (observe). The route tells it so, and a current lifeline re-reads the
   * file — otherwise it would never learn its copy is stale, because it only
   * re-reads on a refusal.
   */
  staleSecretHint: boolean;
}

export interface LifelineIngressGuardOptions {
  stateDir: string;
  /** Explicit `telegramIngress.lifelineSecret.enforce` (read live), or undefined. */
  explicitEnforce: () => boolean | undefined;
  /**
   * `telegramIngress.lifelineSecret.bypass` (read live): the full rollback.
   * Every request is handled exactly as before this change (accepted, sender
   * trusted, taps accepted); the check still runs and counts, and each
   * unverified request is reported.
   */
  bypass?: () => boolean;
  /** Share a secret holder (production passes the process-wide one). */
  holder?: LifelineIngressSecretHolder;
  /**
   * Raises ONE operator attention item. May answer (or resolve to) `false`
   * when nothing reached the operator, in which case the daily throttle is
   * released so the next occurrence tries again.
   */
  raiseAttention?: (item: { id: string; title: string; summary: string }) => boolean | void | Promise<boolean | void>;
  /**
   * Delay before the unarmed boot nudge (see BOOT_NUDGE_DELAY_MS). `null`
   * disables the timer (tests call `bootNudge()` directly).
   */
  bootNudgeDelayMs?: number | null;
  /** Agent config (only `developmentAgent` is read). */
  config: { developmentAgent?: boolean } | undefined;
  /**
   * Is the lifeline the Telegram ingress on this machine? False when the
   * server polls Telegram itself or Telegram is not configured — then nothing
   * legitimate but the server's own call reaches these routes, and the guard
   * need not wait for a lifeline to prove itself. Defaults to true.
   */
  lifelineIsIngress?: () => boolean;
  /**
   * Writes the lifeline-restart signal. Returns false when it declined (for
   * example the server's own version is unknown), so the budget is not spent.
   */
  writeRestartSignal: (info: { previousVersion: string }) => boolean | void;
  /** Reports a degradation. `kind` lets the caller set severity per class. */
  reportDegradation?: (info: { kind: string; reason: string; impact: string }) => void;
  now?: () => number;
  log?: (line: string) => void;
}

function freshState(nowIso: string): LifelineIngressState {
  return {
    version: 1,
    observingSince: nowIso,
    verified: 0,
    verifiedServerSelf: 0,
    wouldRefuse: 0,
    refused: 0,
    secretUnavailable: 0,
    byReason: { missing: 0, mismatch: 0 },
    byRoute: {
      'telegram-forward': { verified: 0, wouldRefuse: 0, refused: 0 },
      'telegram-callback': { verified: 0, wouldRefuse: 0, refused: 0 },
      'lifeline-proof': { verified: 0, wouldRefuse: 0, refused: 0 },
    },
    lastVerifiedAt: null,
    lastWouldRefuseAt: null,
    lastRefusedAt: null,
    lastReason: null,
    verifiedSinceLastWouldRefuse: 0,
    armedAt: null,
    armedBy: null,
    enforceDeadlineAt: null,
    graduatedAt: null,
    graduatedBy: null,
    lastSignalAt: null,
    attentionAt: {},
  };
}

/* @self-action-controller: lifeline-ingress-restart-signal */
export class LifelineIngressGuard {
  private readonly holder: LifelineIngressSecretHolder;
  private readonly statePath: string;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private state: LifelineIngressState;
  private stateCorruptAtLoad = false;
  private lastReloadAt = 0;
  private lastDegradationAt = new Map<string, number>();
  private consecutiveMismatch = 0;
  private stateWriteFailures = 0;
  private lastPersistAt = 0;
  private burstWindowStart = 0;
  private burstCount = 0;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastLogAt = 0;
  private suppressedLogLines = 0;
  private bootNudgeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: LifelineIngressGuardOptions) {
    this.now = opts.now ?? Date.now;
    this.holder = opts.holder ?? new LifelineIngressSecretHolder(opts.stateDir, this.now);
    this.statePath = path.join(opts.stateDir, LIFELINE_INGRESS_STATE_RELPATH);
    this.log = opts.log ?? ((line) => console.warn(line));
    this.state = this.loadState();
    if (this.state.armedAt && !this.state.enforceDeadlineAt) {
      this.state.enforceDeadlineAt = new Date(Date.parse(this.state.armedAt) + EXIT_DEADLINE_MS).toISOString();
    }
    if (this.stateCorruptAtLoad) {
      // Absent evidence is the normal first boot and stays quiet. CORRUPT
      // evidence may have un-armed or un-graduated this guard: say so.
      this.degrade(this.now(), 'state-corrupt',
        'the lifeline ingress guard state file was unreadable and has been reset',
        'The guard starts unarmed and in its default mode until the lifeline proves itself again (seconds on a current lifeline).');
    }
    const delay = opts.bootNudgeDelayMs === undefined ? BOOT_NUDGE_DELAY_MS : opts.bootNudgeDelayMs;
    if (delay !== null) {
      this.bootNudgeTimer = setTimeout(() => { this.bootNudgeTimer = null; this.bootNudge(); }, delay);
      this.bootNudgeTimer.unref?.();
    }
  }

  /**
   * Run once shortly after boot. Pins the clocks this guard relies on (the
   * secret file and the persisted `observingSince`) so they do not slide
   * across restarts, arms at once where there is no lifeline to wait for, and
   * — if a lifeline is expected and still has not proven itself — asks it to
   * restart, through the same persisted budget as every other signal write.
   * Without this, a quiet machine would only be nudged by its first message.
   */
  bootNudge(): void {
    try {
      if (!fs.existsSync(this.opts.stateDir)) return; // torn-down fixture / removed agent
      if (this.bypassed()) return;
      const nowMs = this.now();
      const nowIso = new Date(nowMs).toISOString();
      this.holder.get(); // creates the secret if absent — dates the feature on this disk
      this.armIfNoLifeline(nowMs, nowIso);
      if (!this.state.armedAt && this.spendSignalBudget()) {
        let wrote: boolean | void = false;
        try { wrote = this.opts.writeRestartSignal({ previousVersion: 'unknown' }); } catch { wrote = false; }
        if (wrote === false) this.state.lastSignalAt = null; // declined: budget unspent
      }
      this.persist(nowMs);
    } catch { /* the nudge is an optimisation; requests do the same work */ }
  }

  /** No lifeline to wait for on this machine: arm now. */
  private armIfNoLifeline(nowMs: number, nowIso: string): void {
    if (this.state.armedAt) return;
    if (this.opts.lifelineIsIngress && !this.opts.lifelineIsIngress()) this.arm(nowMs, nowIso, 'no-lifeline-ingress');
  }

  /**
   * When the 24-hour pre-arm allowance started: the EARLIER of this guard's
   * first recorded run and the secret file's own timestamp. The second clock
   * survives a lost or corrupt state file, so resetting the state cannot buy a
   * fresh allowance on a machine that has had this feature for longer.
   */
  private allowanceStartMs(): number {
    const observing = Date.parse(this.state.observingSince);
    const secretAt = this.holder.fileMtimeMs();
    return secretAt !== null && secretAt < observing ? secretAt : observing;
  }

  /** The configured intent, before the arm-on-proof rule. */
  mode(): LifelineIngressMode {
    const explicit = this.opts.explicitEnforce();
    if (explicit !== undefined) return explicit ? 'enforce' : 'observe';
    if (resolveDevAgentGate(undefined, this.opts.config)) return 'enforce';
    // Observe exists to watch a real lifeline's traffic before refusing it.
    // Where there is no lifeline ingress there is nothing to watch.
    if (this.state.armedBy === 'no-lifeline-ingress') return 'enforce';
    return this.state.graduatedAt ? 'enforce' : 'observe';
  }

  /** Is the full rollback (`bypass: true`) set? */
  bypassed(): boolean {
    try { return this.opts.bypass?.() === true; } catch { return false; }
  }

  /**
   * Guard-posture row (GUARD_MANIFEST key `telegramIngress.lifelineSecret`).
   * `enabled` = the guard is actually protecting: armed (or there is no
   * lifeline to wait for) and not bypassed. `dryRun` = observe.
   */
  guardStatus(): { enabled: boolean; dryRun: boolean } {
    const nowMs = this.now();
    this.armIfNoLifeline(nowMs, new Date(nowMs).toISOString());
    return {
      enabled: !this.bypassed() && this.state.armedAt !== null,
      // "Dry run" here means observe HELD by config. Default observe is not a
      // dry run: once armed it already drops unproven sender identity and
      // refuses unproven taps, and it ends by itself (the exit rule), so it
      // cannot become watch-only-forever. A held observe can, and shows as one.
      dryRun: this.opts.explicitEnforce() === false,
    };
  }

  /** Why the mode is what it is — for /health. */
  modeSource(): 'config' | 'development-agent' | 'no-lifeline-ingress' | 'observe-exit-rule' | 'default-observe' {
    if (this.opts.explicitEnforce() !== undefined) return 'config';
    if (resolveDevAgentGate(undefined, this.opts.config)) return 'development-agent';
    if (this.state.armedBy === 'no-lifeline-ingress') return 'no-lifeline-ingress';
    return this.state.graduatedAt ? 'observe-exit-rule' : 'default-observe';
  }

  evaluate(
    headers: Record<string, unknown>,
    route: LifelineIngressRoute,
    info: { lifelineVersion?: unknown } = {},
  ): LifelineIngressDecision {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const presented = headers[LIFELINE_SECRET_HEADER];
    const serverSelf = headers[LIFELINE_INGRESS_CALLER_HEADER] === LIFELINE_INGRESS_CALLER_SERVER_SELF;

    let expected = this.holder.get();
    if (!expected) {
      // OUR side is broken and this process has never held a secret. A message
      // is still delivered (reachability) but with no sender trust; a tap is
      // nothing but a privileged act, so it is refused until we can verify.
      this.state.secretUnavailable++;
      this.persistSoon(nowMs);
      if (this.bypassed()) {
        // The full rollback is total: prior behaviour, whatever our own state.
        return {
          action: 'accept', verified: false, mode: this.mode(), reason: 'secret-unavailable',
          senderTrusted: true, staleSecretHint: false,
        };
      }
      // Self-heal first: the holder retries the load every 30 s. Report only
      // once a retry has failed too.
      if (this.holder.failedLoads >= 2) {
        this.degrade(nowMs, 'secret-unavailable', 'lifeline ingress secret file could not be read or created',
          'Messages on the internal Telegram routes are delivered without proof of the sender, button taps are refused, and no operator is bound, until the file is readable.');
      }
      return {
        action: route === 'telegram-callback' ? 'refuse' : 'accept',
        verified: false, mode: this.mode(), reason: 'secret-unavailable',
        senderTrusted: false, staleSecretHint: false,
      };
    }

    let ok = lifelineSecretMatches(presented, expected);
    if (!ok && typeof presented === 'string' && presented.length > 0 && nowMs - this.lastReloadAt > 5_000) {
      // The other process may have replaced the file since we cached it. A
      // failed re-read keeps our last good value (never fails open).
      this.lastReloadAt = nowMs;
      expected = this.holder.reload();
      ok = lifelineSecretMatches(presented, expected);
    }

    if (ok) {
      this.consecutiveMismatch = 0;
      this.state.verified++;
      this.state.byRoute[route].verified++;
      this.state.lastVerifiedAt = nowIso;
      if (serverSelf) {
        // The label is read only AFTER the secret verified, and it can only
        // REMOVE evidence (this request does not arm or count as traffic).
        this.state.verifiedServerSelf++;
      } else {
        // A startup proof arms the guard but is not Telegram traffic, so it
        // does not count toward the quiet-window arm of the exit rule.
        if (route !== 'lifeline-proof') this.state.verifiedSinceLastWouldRefuse++;
        this.arm(nowMs, nowIso, 'lifeline-proof');
        this.maybeGraduate(nowMs, nowIso);
      }
      this.persist(nowMs); // verified traffic is lifeline-rate; write through
      return { action: 'accept', verified: true, mode: this.mode(), senderTrusted: true, staleSecretHint: false };
    }

    const reason: LifelineIngressRefusalReason =
      typeof presented === 'string' && presented.length > 0 ? 'mismatch' : 'missing';
    this.consecutiveMismatch = reason === 'mismatch' ? this.consecutiveMismatch + 1 : 0;

    if (this.bypassed()) {
      // Full rollback: handled exactly as before this change. Still counted,
      // and reported — a bypassed guard is itself an incident.
      this.state.byReason[reason]++;
      this.state.lastReason = reason;
      this.state.wouldRefuse++;
      this.state.byRoute[route].wouldRefuse++;
      this.state.lastWouldRefuseAt = nowIso;
      this.state.verifiedSinceLastWouldRefuse = 0;
      this.degrade(nowMs, 'bypassed',
        `request without a valid lifeline secret on ${route} accepted because the guard is bypassed by config`,
        'telegramIngress.lifelineSecret.bypass is true: the internal Telegram routes are unprotected.');
      this.attention(nowMs, nowIso, 'bypassed',
        'My Telegram intake check is switched off',
        `A request without the lifeline secret reached the internal Telegram ${route === 'telegram-callback' ? 'button' : 'message'} route and was accepted, because the bypass setting is on. While it is on, a session can send a message or a button tap as you.`);
      this.persistSoon(nowMs);
      return { action: 'accept', verified: false, mode: this.mode(), reason, senderTrusted: true, staleSecretHint: false };
    }

    this.armIfNoLifeline(nowMs, nowIso);
    this.maybeGraduate(nowMs, nowIso); // the deadline arm needs no verified request
    const mode = this.mode();
    const armed = this.state.armedAt !== null;
    // Rule 2: once armed — or, in enforce, once the bounded pre-arm allowance
    // has run out — an unproven request carries no sender trust and an
    // unproven tap is refused. A MESSAGE is refused only when armed + enforce.
    const allowanceOver = nowMs - this.allowanceStartMs() >= PRE_ARM_TRUST_MS;
    const trustAllowed = !armed && (mode === 'observe' || !allowanceOver);
    const refuse = route === 'telegram-callback' ? !trustAllowed : armed && mode === 'enforce';

    this.state.byReason[reason]++;
    this.state.lastReason = reason;
    this.state.verifiedSinceLastWouldRefuse = 0;
    if (refuse) {
      this.state.refused++;
      this.state.byRoute[route].refused++;
      this.state.lastRefusedAt = nowIso;
    } else {
      this.state.wouldRefuse++;
      this.state.byRoute[route].wouldRefuse++;
      this.state.lastWouldRefuseAt = nowIso;
    }

    this.logLimited(nowMs,
      `[lifeline-ingress] ${refuse ? 'refused' : 'would-refuse'} ${route}: ${reason} (mode=${mode}, armed=${armed})`);

    if (armed) {
      // SECURITY class — reported on the same request, no heal-first delay,
      // whether the header was missing or wrong (the server's own re-read
      // above already ruled out a stale copy on OUR side): after arming, a
      // request without the valid secret is not a healthy lifeline.
      const what = reason === 'missing' ? 'without the lifeline secret' : 'with a wrong lifeline secret';
      const impact = refuse
        ? 'The request was refused. Something other than the lifeline called the route with the ordinary token, or the lifeline cannot read the secret file (its messages stay queued).'
        : 'The message was delivered (observe) with no sender identity. Something other than the lifeline called the route with the ordinary token.';
      this.degrade(nowMs, 'unproven-after-arming', `request ${what} on ${route} after the guard armed`, impact);
      // …and it reaches the operator.
      this.attention(nowMs, nowIso, 'unproven-after-arming',
        'Something other than the lifeline called my Telegram intake',
        `A request ${what} reached the internal Telegram ${route === 'telegram-callback' ? 'button' : 'message'} route. `
          + (refuse ? 'It was refused. ' : 'It was delivered without a sender identity. ')
          + 'If Telegram messages are also not getting through, the lifeline may be unable to read its secret file.');
    } else {
      this.reportUnarmed(nowMs, nowIso, reason, allowanceOver, trustAllowed);
    }

    // Move a lifeline that is still running old code onto the current version.
    // A lifeline already on the server's version clears the signal without
    // restarting. The budget is persisted and deliberately small — see the
    // SIGNAL_GAP_* constants.
    const gap = armed ? SIGNAL_GAP_ARMED_MS : SIGNAL_GAP_UNARMED_MS;
    const lastSignalMs = this.state.lastSignalAt ? Date.parse(this.state.lastSignalAt) : NaN;
    if (!Number.isFinite(lastSignalMs) || nowMs - lastSignalMs >= gap) {
      try {
        const wrote = this.opts.writeRestartSignal({
          previousVersion: typeof info.lifelineVersion === 'string' ? info.lifelineVersion.slice(0, 64) : 'unknown',
        });
        if (wrote !== false) this.state.lastSignalAt = nowIso;
      } catch (err) {
        this.log(`[lifeline-ingress] failed to write lifeline-restart signal: ${err instanceof Error ? err.message : err}`);
      }
    }

    this.persistSoon(nowMs);
    return {
      action: refuse ? 'refuse' : 'accept',
      verified: false,
      mode,
      reason,
      senderTrusted: trustAllowed,
      staleSecretHint: !refuse && reason === 'mismatch',
    };
  }

  /**
   * Spend one unit of the persisted restart-signal budget on behalf of
   * another signal writer acting on an UNVERIFIED request (the route's 426
   * path). True = the caller may write.
   */
  spendSignalBudget(): boolean {
    const nowMs = this.now();
    const gap = this.state.armedAt !== null ? SIGNAL_GAP_ARMED_MS : SIGNAL_GAP_UNARMED_MS;
    const last = this.state.lastSignalAt ? Date.parse(this.state.lastSignalAt) : NaN;
    if (Number.isFinite(last) && nowMs - last < gap) return false;
    this.state.lastSignalAt = new Date(nowMs).toISOString();
    this.persistSoon(nowMs);
    return true;
  }

  /** The block published on the authed /health. No secret material. */
  health(): Record<string, unknown> {
    const nowMs = this.now();
    this.armIfNoLifeline(nowMs, new Date(nowMs).toISOString());
    this.maybeGraduate(nowMs, new Date(nowMs).toISOString(), true);
    const mode = this.mode();
    const explicit = this.opts.explicitEnforce();
    const quietSince = this.quietSinceMs();
    const s = this.state;
    const secretAvailable = this.holder.fileReadable(); // a read of the FILE, never a create
    return {
      mode,
      modeSource: this.modeSource(),
      armed: s.armedAt !== null,
      armedBy: s.armedBy,
      bypassedByConfig: this.bypassed(),
      // Refusal needs a secret HELD in memory; `secretAvailable` is the file.
      refusing: !this.bypassed() && mode === 'enforce' && s.armedAt !== null && this.holder.held,
      // Taps are refused once armed (either mode), in enforce once the
      // pre-arm allowance has run out, and whenever no secret is held.
      refusingTaps: !this.bypassed() && (s.armedAt !== null || !this.holder.held
        || (mode === 'enforce' && nowMs - this.allowanceStartMs() >= PRE_ARM_TRUST_MS)),
      // Only enforce has an expiring pre-arm allowance; observe never degrades
      // an unarmed machine's traffic.
      preArmTrustEndsAt: s.armedAt === null && mode === 'enforce'
        ? new Date(this.allowanceStartMs() + PRE_ARM_TRUST_MS).toISOString()
        : null,
      secretAvailable,
      observeExit: {
        rule: `zero would-refuse for ${EXIT_QUIET_MS / 3_600_000}h and at least ${EXIT_MIN_VERIFIED} verified Telegram requests from the lifeline in that time, or ${EXIT_DEADLINE_MS / 86_400_000} days after arming, whichever comes first`,
        pinnedObserveByConfig: explicit === false,
        deadlineAt: s.enforceDeadlineAt,
        graduatedAt: s.graduatedAt,
        graduatedBy: s.graduatedBy,
        quietSince: new Date(quietSince).toISOString(),
        quietHours: Math.max(0, Math.round(((nowMs - quietSince) / 3_600_000) * 10) / 10),
        verifiedSinceLastWouldRefuse: s.verifiedSinceLastWouldRefuse,
      },
      observingSince: s.observingSince,
      armedAt: s.armedAt,
      verified: s.verified,
      verifiedServerSelf: s.verifiedServerSelf,
      wouldRefuse: s.wouldRefuse,
      refused: s.refused,
      secretUnavailable: s.secretUnavailable,
      byReason: { ...s.byReason },
      byRoute: {
        'telegram-forward': { ...s.byRoute['telegram-forward'] },
        'telegram-callback': { ...s.byRoute['telegram-callback'] },
        'lifeline-proof': { ...s.byRoute['lifeline-proof'] },
      },
      lastVerifiedAt: s.lastVerifiedAt,
      lastWouldRefuseAt: s.lastWouldRefuseAt,
      lastRefusedAt: s.lastRefusedAt,
      lastReason: s.lastReason,
      lastSignalAt: s.lastSignalAt,
      stateCorruptAtLoad: this.stateCorruptAtLoad,
      stateWriteFailures: this.stateWriteFailures,
    };
  }

  /** Write any coalesced counters now and stop the timers (shutdown, tests). */
  flush(): void {
    if (this.bootNudgeTimer) { clearTimeout(this.bootNudgeTimer); this.bootNudgeTimer = null; }
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.dirty) this.persist(this.now());
  }

  private arm(nowMs: number, nowIso: string, by: 'lifeline-proof' | 'no-lifeline-ingress'): void {
    if (this.state.armedAt) return;
    this.state.armedAt = nowIso;
    this.state.armedBy = by;
    this.state.enforceDeadlineAt = new Date(nowMs + EXIT_DEADLINE_MS).toISOString();
    console.warn(by === 'lifeline-proof'
      ? '[lifeline-ingress] armed: the lifeline proved it sends the ingress secret'
      : '[lifeline-ingress] armed: the lifeline is not the Telegram ingress on this machine');
  }

  private quietSinceMs(): number {
    const candidates = [this.state.observingSince, this.state.lastWouldRefuseAt, this.state.lastRefusedAt]
      .map((v) => (v ? Date.parse(v) : NaN))
      .filter((n) => Number.isFinite(n));
    return candidates.length > 0 ? Math.max(...candidates) : this.now();
  }

  private maybeGraduate(nowMs: number, nowIso: string, persist = false): void {
    if (this.state.graduatedAt) return;
    if (!this.state.armedAt) return;
    const deadline = this.state.enforceDeadlineAt ? Date.parse(this.state.enforceDeadlineAt) : NaN;
    const quiet =
      this.state.verifiedSinceLastWouldRefuse >= EXIT_MIN_VERIFIED &&
      nowMs - this.quietSinceMs() >= EXIT_QUIET_MS;
    const pastDeadline = Number.isFinite(deadline) && nowMs >= deadline;
    if (!quiet && !pastDeadline) return;
    this.state.graduatedAt = nowIso;
    this.state.graduatedBy = quiet ? 'quiet-window' : 'deadline';
    console.warn(`[lifeline-ingress] observe exit rule met (${this.state.graduatedBy}) — the default mode is now enforce`);
    if (persist) this.persist(nowMs);
  }

  /**
   * Reports for an unverified request while UNARMED. The three checks are
   * independent: a persistently wrong secret must not hide the fact that the
   * guard is still unarmed, or that a day has passed.
   */
  private reportUnarmed(
    nowMs: number, nowIso: string, reason: LifelineIngressRefusalReason, allowanceOver: boolean, trustAllowed: boolean,
  ): void {
    if (reason === 'mismatch' && this.consecutiveMismatch >= MISMATCH_REPORT_AFTER) {
      // RECOVERABLE — both sides re-read the file first (the server in
      // evaluate, the lifeline on a refusal or a stale hint). Report only if
      // it persists.
      this.degrade(nowMs, 'secret-mismatch',
        `${this.consecutiveMismatch} requests in a row carried a lifeline secret that is not this server's`,
        'The caller and the server disagree about the secret file — for example two state directories.');
    }
    if (nowMs - this.allowanceStartMs() >= UNARMED_REPORT_AFTER_MS) {
      // RECOVERABLE — the restart signal is the heal and was written by the
      // boot nudge (or the first such request). Still unarmed an hour later.
      this.degrade(nowMs, 'unarmed',
        'the lifeline has not yet proven it sends the ingress secret; requests without it are still being accepted',
        'The internal Telegram routes are not yet protected on this machine. Restart the lifeline onto the current version.');
    }
    if (allowanceOver) {
      // A day on, the lifeline still has not updated. Tell the operator.
      this.attention(nowMs, nowIso, 'unarmed',
        'My Telegram lifeline has not updated',
        trustAllowed
          ? 'My lifeline is still running an older version a day after my server updated, so the check that Telegram messages really come through the lifeline is not active yet. Restarting the lifeline fixes it.'
          : 'My lifeline is still running an older version a day after my server updated, so Telegram messages now reach me without a verified sender and button taps are refused. Restarting the lifeline fixes it.');
    }
  }

  /**
   * One operator attention item per kind per ATTENTION_GAP_MS at most. The
   * throttle is persisted and the id is dated, so a later episode raises a
   * NEW item even after the operator resolved an earlier one. If nothing
   * reached the operator, the throttle is released.
   */
  private attention(nowMs: number, nowIso: string, kind: string, title: string, summary: string): void {
    if (!this.opts.raiseAttention) return;
    const previous = this.state.attentionAt[kind];
    const last = previous ? Date.parse(previous) : NaN;
    if (Number.isFinite(last) && nowMs - last < ATTENTION_GAP_MS) return;
    this.state.attentionAt[kind] = nowIso;
    const release = (): void => {
      if (this.state.attentionAt[kind] !== nowIso) return;
      if (previous) this.state.attentionAt[kind] = previous; else delete this.state.attentionAt[kind];
      this.persistSoon(this.now());
    };
    try {
      const result = this.opts.raiseAttention({ id: `telegram-ingress:${kind}:${nowIso.slice(0, 10)}`, title, summary });
      if (result === false) release();
      else if (result && typeof (result as Promise<boolean | void>).then === 'function') {
        (result as Promise<boolean | void>).then((ok) => { if (ok === false) release(); }, () => release());
      }
    } catch {
      release();
    }
  }

  /** One report per kind per hour. */
  private degrade(nowMs: number, kind: string, reason: string, impact: string): void {
    const last = this.lastDegradationAt.get(kind);
    if (last !== undefined && nowMs - last < 60 * 60 * 1000) return;
    this.lastDegradationAt.set(kind, nowMs);
    try { this.opts.reportDegradation?.({ kind, reason, impact }); } catch { /* reporting is best-effort */ }
  }

  /** At most one log line per 10 s; the next line says how many were skipped. */
  private logLimited(nowMs: number, line: string): void {
    if (this.lastLogAt !== 0 && nowMs - this.lastLogAt < 10_000) {
      this.suppressedLogLines++;
      return;
    }
    const suffix = this.suppressedLogLines > 0 ? ` (+${this.suppressedLogLines} similar not logged)` : '';
    this.suppressedLogLines = 0;
    this.lastLogAt = nowMs;
    this.log(line + suffix);
  }

  private loadState(): LifelineIngressState {
    const base = freshState(new Date(this.now()).toISOString());
    let raw: string;
    try {
      raw = fs.readFileSync(this.statePath, 'utf-8');
    } catch {
      // @silent-fallback-ok — no evidence yet (first boot): a fresh window,
      // nothing armed, nothing graduated, so nothing refused.
      return base;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<LifelineIngressState>;
      if (parsed && parsed.version === 1 && typeof parsed.observingSince === 'string') {
        return {
          ...base,
          ...parsed,
          attentionAt: parsed.attentionAt && typeof parsed.attentionAt === 'object' ? { ...parsed.attentionAt } : {},
          byReason: { ...base.byReason, ...(parsed.byReason ?? {}) },
          byRoute: {
            'telegram-forward': { ...base.byRoute['telegram-forward'], ...(parsed.byRoute?.['telegram-forward'] ?? {}) },
            'telegram-callback': { ...base.byRoute['telegram-callback'], ...(parsed.byRoute?.['telegram-callback'] ?? {}) },
            'lifeline-proof': { ...base.byRoute['lifeline-proof'], ...(parsed.byRoute?.['lifeline-proof'] ?? {}) },
          },
        };
      }
    } catch { /* falls through to the corrupt case */ }
    this.stateCorruptAtLoad = true;
    return base;
  }

  /**
   * Unverified requests can arrive at any rate (the caller this guard exists
   * for is a looping session), so their counter writes are bounded: the first
   * PERSIST_BURST in a window write through, the rest are coalesced into one
   * trailing write per PERSIST_COALESCE_MS.
   */
  private persistSoon(nowMs: number): void {
    if (nowMs - this.burstWindowStart >= PERSIST_COALESCE_MS) {
      this.burstWindowStart = nowMs;
      this.burstCount = 0;
    }
    if (this.burstCount < PERSIST_BURST) {
      this.burstCount++;
      this.persist(nowMs);
      return;
    }
    this.dirty = true;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        if (this.dirty) this.persist(this.now());
      }, PERSIST_COALESCE_MS);
      this.flushTimer.unref?.();
    }
  }

  /** Single writer (the server process), synchronous, tmp + rename. */
  private persist(nowMs: number): void {
    this.lastPersistAt = nowMs;
    this.dirty = false;
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      /* state-registry: lifeline-ingress-guard */
      fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      fs.renameSync(tmp, this.statePath);
    } catch {
      this.stateWriteFailures++;
      try {
        if (fs.existsSync(tmp)) {
          SafeFsExecutor.safeUnlinkSync(tmp, { operation: 'src/server/LifelineIngressGuard.ts:persist-cleanup' });
        }
      } catch { /* best-effort */ }
    }
  }
}
