/**
 * SentinelNotifier — the single delivery policy for the silently-stopped
 * sentinels (ActiveWorkSilenceSentinel + SocketDisconnectSentinel).
 *
 * Built in response to the 2026-05-22 topic-spam flood. Three problems were
 * stacked together; this module owns two of them (the detector fix lives in
 * sentinelWiring.ts):
 *
 *   1. Severity — sentinel monitoring is housekeeping. Every lifecycle
 *      transition (detected / nudged / recovered / escalated) is written to
 *      the logs (console + a JSONL audit trail) and, by default, NOTHING is
 *      sent to Telegram. Per the user: "anything that just needs to be logged
 *      for the system should not by default be sent to Telegram." This is
 *      stronger than throttling — routine noise is never GENERATED, not merely
 *      rate-limited.
 *
 *   2. Routing — when Telegram escalation is explicitly enabled, genuine
 *      recovery-failed escalations are COALESCED into ONE message and sent to
 *      ONE reused system topic. They never each spawn a brand-new forum topic
 *      (the old path went through /attention → createAttentionItem →
 *      createForumTopic, one topic per event, which produced the wall of
 *      "X went quiet" topics).
 *
 * Signal-vs-authority: this is a delivery sink, not a gate. It introduces no
 * blocking authority. The escalation message is a fixed plain-English template
 * with a yes/no CTA; the system-topic sender it is wired to may still apply the
 * outbound tone gate.
 *
 * Spec: docs/specs/silently-stopped-trio.md
 */

export type SentinelEventKind =
  | 'detected'
  | 'nudged'
  | 'recovered'
  | 'escalated'
  | 'escalation-sent'
  | 'escalation-suppressed'
  | 'nudge-error'
  | 'recovery-error'
  | 'notify-error';

export interface SentinelLogEntry {
  ts: string;
  kind: SentinelEventKind;
  sentinel: string;
  sessionName: string;
  detail?: string;
}

export interface SentinelNotifierDeps {
  /**
   * Append a structured audit entry. Always invoked for every transition.
   * server.ts wires this to console + a JSONL file; tests pass a capture array.
   */
  log: (entry: SentinelLogEntry) => void;
  /**
   * Send ONE consolidated escalation message to the single reused system topic.
   * Only invoked when telegramEscalation is enabled. Returns true on delivery.
   * When omitted, escalation is log-only regardless of the enabled flag.
   */
  sendConsolidated?: (text: string) => Promise<boolean>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface SentinelNotifierConfig {
  /**
   * Master gate for Telegram escalation. Default false → all sentinel notices
   * are log-only. When true, genuine recovery-failed escalations are coalesced
   * and sent to the system topic.
   */
  telegramEscalation?: boolean;
  /**
   * Coalescing window (ms). Escalations that arrive within this window of each
   * other are flushed together as a single message. Default 5000ms — long
   * enough to absorb a restart-time burst, short enough to feel timely.
   */
  coalesceWindowMs?: number;
}

const DEFAULT_CONFIG: Required<SentinelNotifierConfig> = {
  telegramEscalation: false,
  coalesceWindowMs: 5_000,
};

export class SentinelNotifier {
  private readonly cfg: Required<SentinelNotifierConfig>;
  private readonly pending = new Map<string, string>();
  private flushHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly deps: SentinelNotifierDeps,
    cfg: SentinelNotifierConfig = {},
  ) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
  }

  /** True if Telegram escalation is wired AND enabled. */
  get telegramEnabled(): boolean {
    return this.cfg.telegramEscalation === true && typeof this.deps.sendConsolidated === 'function';
  }

  /**
   * Record a routine lifecycle transition. Always log-only — never reaches
   * Telegram. This is the "housekeeping goes to the logs" path.
   */
  record(kind: SentinelEventKind, sentinel: string, sessionName: string, detail?: string): void {
    this.write(kind, sentinel, sessionName, detail);
  }

  /**
   * A sentinel could not recover a genuinely-stuck session. Always logged. Sent
   * to Telegram (coalesced, single system topic) ONLY when escalation is
   * enabled; otherwise log-only.
   */
  escalate(sentinel: string, sessionName: string, text: string): void {
    this.write('escalated', sentinel, sessionName, text);
    if (!this.telegramEnabled) {
      this.write('escalation-suppressed', sentinel, sessionName, 'telegramEscalation disabled (log-only)');
      return;
    }
    this.pending.set(sessionName, text);
    this.scheduleFlush();
  }

  /** Flush immediately (test seam + graceful shutdown). */
  async flushNow(): Promise<void> {
    this.clearFlush();
    await this.flush();
  }

  /** Cancel any pending flush (graceful shutdown). */
  stop(): void {
    this.clearFlush();
    this.pending.clear();
  }

  private scheduleFlush(): void {
    if (this.flushHandle) return; // a flush is already queued; coalesce into it
    const setTimer = this.deps.setTimer ?? setTimeout;
    this.flushHandle = setTimer(() => {
      this.flushHandle = null;
      void this.flush();
    }, this.cfg.coalesceWindowMs);
    if (this.flushHandle && typeof (this.flushHandle as { unref?: () => void }).unref === 'function') {
      (this.flushHandle as { unref: () => void }).unref();
    }
  }

  private clearFlush(): void {
    if (this.flushHandle) {
      (this.deps.clearTimer ?? clearTimeout)(this.flushHandle);
      this.flushHandle = null;
    }
  }

  private async flush(): Promise<void> {
    if (this.pending.size === 0) return;
    if (!this.deps.sendConsolidated) {
      this.pending.clear();
      return;
    }
    const entries = Array.from(this.pending.entries());
    this.pending.clear();
    const message = this.composeMessage(entries);
    try {
      const delivered = await this.deps.sendConsolidated(message);
      this.write(
        delivered ? 'escalation-sent' : 'notify-error',
        'sentinel-notifier',
        entries.map(([name]) => name).join(','),
        delivered ? `consolidated ${entries.length} escalation(s)` : 'sendConsolidated returned false',
      );
    } catch (err) {
      this.write(
        'notify-error',
        'sentinel-notifier',
        entries.map(([name]) => name).join(','),
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** Build ONE plain-English, CTA-bearing message for all coalesced sessions. */
  private composeMessage(entries: Array<[string, string]>): string {
    if (entries.length === 1) {
      return entries[0][1];
    }
    const names = entries.map(([name]) => `• ${friendly(name)}`).join('\n');
    return (
      `${entries.length} background sessions were working and then went quiet, and a gentle nudge didn't bring them back:\n` +
      `${names}\n\n` +
      `Want me to dig into them?`
    );
  }

  private write(kind: SentinelEventKind, sentinel: string, sessionName: string, detail?: string): void {
    const entry: SentinelLogEntry = {
      ts: new Date((this.deps.now ?? Date.now)()).toISOString(),
      kind,
      sentinel,
      sessionName,
      ...(detail ? { detail } : {}),
    };
    try {
      this.deps.log(entry);
    } catch {
      // A logging sink failure must never crash the monitoring path.
    }
  }
}

function friendly(sessionName: string): string {
  return sessionName.replace(/^ai\.instar\./, '').replace(/-server$/, '').replace(/-lifeline$/, '');
}
