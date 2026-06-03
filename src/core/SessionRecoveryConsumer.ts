/**
 * SessionRecoveryConsumer — the LIFELINE-side executor for codex session-wedge
 * self-recovery (tier C). It is the AUTHORITY half of the Signal-vs-Authority
 * split: the server-process sentinel emits requests via SessionRecoveryChannel;
 * this consumer (run from TelegramLifeline, where ServerSupervisor lives) reads
 * them and actually performs the server restart + queue replay.
 *
 * The logic is deliberately separated from TelegramLifeline and takes its
 * effects as injected callbacks (`restart`, `replay`) + an injectable clock, so
 * it is unit-testable without standing up a lifeline. TelegramLifeline wires the
 * real `supervisor.performGracefulRestart` and `replayQueue` and calls `tick()`
 * on an interval.
 *
 * Safety properties (this is the highest-blast-radius path — it restarts the
 * whole agent server):
 *  - DRY-RUN first: `dryRun:true` logs what it WOULD do and acks recovered
 *    without restarting. Ships in this mode.
 *  - DURABLE cooldown: before any restart it checks `channel.isInCooldown`. A
 *    tier-C restart wipes the sentinel's in-memory bound, so this durable guard
 *    is the only thing preventing a restart-can't-fix wedge from looping.
 *  - Records the restart BEFORE acting, so a crash mid-restart still counts
 *    against the cooldown.
 *  - Dedups on (sessionId, attemptId) so a lingering request (the sentinel was
 *    restarted before it could clear it) is not re-executed.
 *  - Never writes the request file (the server owns it) — ack + cooldown only.
 *
 * Spec: docs/specs/CODEX-SESSION-WEDGE-SELF-RECOVERY.md
 */

import type { SessionRecoveryChannel, RecoveryRequest } from './SessionRecoveryChannel.js';

export interface SessionRecoveryConsumerOptions {
  channel: SessionRecoveryChannel;
  /** Perform the server restart (TelegramLifeline → supervisor.performGracefulRestart). */
  restart: (reason: string) => Promise<boolean>;
  /** Replay the queued messages after the server is back (TelegramLifeline.replayQueue). */
  replay: () => void;
  /** When true, log only — never actually restart. Ships true. */
  dryRun: boolean;
  /** Minimum gap between tier-C restarts for the same session (loop guard). */
  cooldownMs: number;
  /** Injectable clock (epoch ms). Defaults to Date.now. */
  now?: () => number;
  /** Injectable logger. Defaults to console.log. */
  log?: (msg: string) => void;
}

export class SessionRecoveryConsumer {
  private readonly channel: SessionRecoveryChannel;
  private readonly restart: (reason: string) => Promise<boolean>;
  private readonly replay: () => void;
  private readonly dryRun: boolean;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(opts: SessionRecoveryConsumerOptions) {
    this.channel = opts.channel;
    this.restart = opts.restart;
    this.replay = opts.replay;
    this.dryRun = opts.dryRun;
    this.cooldownMs = opts.cooldownMs;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((m) => console.log(m));
  }

  /** One pass: handle every pending tier-C recovery request. Best-effort — a
   *  read/exec failure on one request never throws out of tick(). */
  async tick(): Promise<void> {
    let pending: RecoveryRequest[];
    try {
      pending = this.channel.readPendingRequests();
    } catch {
      return;
    }
    for (const req of pending) {
      if (req.tier !== 'server-restart-replay') continue; // lifeline only owns tier C
      try {
        await this.handle(req);
      } catch (err) {
        this.ack(req, 'failed', `executor error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async handle(req: RecoveryRequest): Promise<void> {
    const now = this.now();

    // Dedup: this exact attempt already reached a terminal ack → done.
    const prior = this.channel.readAck(req.sessionId);
    if (prior && prior.attemptId === req.attemptId && prior.outcome !== 'in-progress') {
      return;
    }

    // Durable cooldown — the cross-restart loop guard.
    if (this.channel.isInCooldown(req.sessionId, now, this.cooldownMs)) {
      this.ack(req, 'failed', 'restart cooldown active (loop guard)');
      this.log(`[SessionRecovery] cooldown active for ${req.sessionId} — refusing restart`);
      return;
    }

    // Mark in-progress and record the restart BEFORE acting (so a crash mid-restart
    // still counts against the cooldown).
    this.ack(req, 'in-progress', this.dryRun ? 'dry-run' : 'restarting server + replay');
    this.channel.recordRestart(req.sessionId, now);

    if (this.dryRun) {
      this.log(`[SessionRecovery] [DRY-RUN] would restart server + replay for wedged session ${req.sessionId} (${req.reason})`);
      this.ack(req, 'recovered', 'dry-run: no restart performed');
      return;
    }

    this.log(`[SessionRecovery] restarting server + replay for wedged session ${req.sessionId} (${req.reason})`);
    const ok = await this.restart(`codex-wedge-recovery: ${req.sessionId}`);
    if (ok) {
      this.replay();
      this.ack(req, 'recovered', 'server restarted + queue replayed');
    } else {
      this.ack(req, 'failed', 'graceful restart returned false');
    }
  }

  private ack(req: RecoveryRequest, outcome: 'in-progress' | 'recovered' | 'failed', detail: string): void {
    this.channel.ackRecovery({
      sessionId: req.sessionId,
      attemptId: req.attemptId,
      tier: req.tier,
      outcome,
      detail,
      updatedAt: new Date(this.now()).toISOString(),
    });
  }
}
