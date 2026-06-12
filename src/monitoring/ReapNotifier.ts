/**
 * ReapNotifier — the single coalescing listener for `sessionReaped`
 * (UNIFIED-SESSION-LIFECYCLE §P3).
 *
 * `SessionManager.terminateSession` emits `sessionReaped` exactly once per kill
 * at the one chokepoint. This listener turns a TERMINAL reap of a user-facing
 * session into a "your session was shut down" notice so a session never silently
 * vanishes (the 2026-05-27 incident). It stays SILENT for:
 *   - `recovery-bounce` reaps (a kill-to-respawn is a bounce, not a disappearance),
 *   - `origin:'operator'` reaps (the user clicked kill — telling them is noise).
 *
 * Coalescing (SE-7): terminal reaps within a short rolling window collapse onto a
 * single shared timer. On flush:
 *   - exactly ONE reap in the window → a per-session notice routed to its bound
 *     topic (or the lifeline topic if unbound),
 *   - MORE than one → ONE consolidated lifeline message stating the TOTAL count,
 *     so a mass-reap burst that overflows the bounded buffer is never
 *     under-reported (the reap-log P4 has the complete record regardless).
 *
 * Sanitization: session names follow user-controlled topic renames, so the
 * dynamic fields (name, reason) are wrapped as inline-code spans — the downstream
 * Telegram formatter renders code spans as literal, HTML-escaped text, never
 * markup. The notifier never emits raw markup around user-controlled values.
 */

import type { Session } from '../core/types.js';

export interface ReapEvent {
  session: Pick<Session, 'name' | 'tmuxSession'>;
  reason: string;
  disposition?: 'terminal' | 'recovery-bounce';
  origin?: 'operator' | 'autonomous';
  /** Mid-work stamp from the kill chokepoint (reap-notify spec R2.1). */
  midWork?: boolean;
  /** Clamped work-evidence names behind midWork. */
  workEvidence?: string[];
}

export interface ReapNotifierDeps {
  /** Bound messaging topic for a session, or null if unbound. */
  resolveTopic: (tmuxSession: string) => number | null;
  /** The always-on system/lifeline topic, or null if none is configured. */
  lifelineTopic: () => number | null;
  /** Deliver a (GFM) notice to a topic. Wiring decides the transport/tier. */
  send: (topicId: number, text: string) => void | Promise<void>;
  now?: () => number;
}

export interface ReapNotifierOptions {
  enabled: boolean;
  coalesceWindowMs: number;
  /** Max reaps retained for the consolidated-message detail list (count is exact regardless). */
  maxBuffer: number;
}

export const DEFAULT_REAP_NOTIFIER_OPTIONS: ReapNotifierOptions = {
  enabled: true,
  coalesceWindowMs: 60_000,
  maxBuffer: 100,
};

/** Wrap a user-controlled value as a literal inline-code span (never markup). */
function literal(value: string): string {
  // Neutralize backticks so the code span can't be broken out of.
  return '`' + String(value).replace(/`/g, "'") + '`';
}

export class ReapNotifier {
  private readonly deps: ReapNotifierDeps;
  private readonly opts: ReapNotifierOptions;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private buffer: ReapEvent[] = [];
  private windowCount = 0;

  constructor(deps: ReapNotifierDeps, opts?: Partial<ReapNotifierOptions>) {
    this.deps = deps;
    this.opts = { ...DEFAULT_REAP_NOTIFIER_OPTIONS, ...(opts ?? {}) };
    this.now = deps.now ?? (() => Date.now());
  }

  /** The `sessionReaped` event handler. */
  onReaped(event: ReapEvent): void {
    if (!this.opts.enabled) return;
    // Silent dispositions/origins: a bounce is not a disappearance, and the user
    // already knows about their own operator kill.
    if ((event.disposition ?? 'terminal') !== 'terminal') return;
    if (event.origin === 'operator') return;

    this.windowCount++;
    this.buffer.push(event);
    if (this.buffer.length > this.opts.maxBuffer) this.buffer.shift(); // drop-oldest detail

    if (!this.timer) {
      this.timer = setTimeout(() => { void this.flush(); }, this.opts.coalesceWindowMs);
      if (typeof this.timer.unref === 'function') this.timer.unref();
    }
  }

  /**
   * Emit the coalesced notice(s) for the closed window and reset. Public so the
   * lifecycle (and tests) can drive it deterministically.
   */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const count = this.windowCount;
    const detail = this.buffer;
    this.windowCount = 0;
    this.buffer = [];
    if (count === 0) return;

    if (count === 1) {
      const ev = detail[0];
      const topic = this.deps.resolveTopic(ev.session.tmuxSession) ?? this.deps.lifelineTopic();
      if (topic == null) return; // unreachable channel — reap-log (P4) still has it
      await this.deps.send(topic, this.formatSingle(ev));
      return;
    }

    // Burst → ONE consolidated lifeline message stating the exact total count.
    const topic = this.deps.lifelineTopic();
    if (topic == null) return;
    await this.deps.send(topic, this.formatBurst(count, detail));
  }

  private formatSingle(ev: ReapEvent): string {
    return `🪦 Session ${literal(ev.session.name)} was shut down — ${literal(ev.reason)}. `
      + `See the reap-log (\`GET /sessions/reap-log\`) for the full record.`;
  }

  private formatBurst(count: number, detail: ReapEvent[]): string {
    const lines = detail.map((e) => `• ${literal(e.session.name)} — ${literal(e.reason)}`);
    const shownNote = count > detail.length
      ? `\n\n(showing the latest ${detail.length}; full list in the reap-log)`
      : '';
    return `🪦 ${count} session${count === 1 ? '' : 's'} shut down in the last `
      + `${Math.round(this.opts.coalesceWindowMs / 1000)}s:\n\n`
      + lines.join('\n')
      + shownNote
      + `\n\nFull record: \`GET /sessions/reap-log\`.`;
  }
}
