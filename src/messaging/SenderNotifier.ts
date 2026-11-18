/**
 * Sender notices (spec docs/specs/messages-reach-renamed-sessions.md, §C).
 *
 * When a same-agent message reaches a terminal failure, the session that sent it is
 * told once, in a fixed template marked as quoted data. Rules:
 *   - only when `from.machine` is this machine and `from.session` is a RUNNING session
 *     by exact tmux name (the sender field is caller-supplied, so no inference);
 *   - never about a `delivery-notice` (no notice loops);
 *   - the first failure for a sender goes out at once; later ones within 60s are
 *     grouped into one follow-up listing each target and reason;
 *   - `noticePending` / `noticeSentAt` live on the failed envelope (single-file writes),
 *     and pending notices are flushed at boot;
 *   - a notice that cannot be typed is recorded and dropped, never retried.
 * Senders that are not sessions (scripts, helpers) get the HTTP phase and the
 * `undelivered` counter instead.
 */

import type { MessageEnvelope } from './types.js';

export const NOTICE_GROUP_WINDOW_MS = 60_000;
const FIELD_CAP = 120;
const KEEP_HEAD = 80;
const KEEP_TAIL = 30;

export interface SenderNotifierDeps {
  localMachine: string;
  /** This agent's name: a notice only ever goes to one of this agent's own sessions. */
  localAgent?: string;
  /** True when `name` is a running session of this agent (exact tmux name). */
  isRunningExact: (name: string) => boolean;
  /** Types `text` into the session; resolves true when it landed. Never throws. */
  typeInto: (session: string, text: string) => Promise<boolean>;
  /** Persists notice markers on the failed envelope. Never throws. */
  markNotice: (messageId: string, patch: { noticePending?: boolean; noticeSentAt?: string }) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
}

interface Pending { items: Array<{ id: string; target: string; reason: string; subject: string }>; }

export function sanitizeField(text: string, messageId: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (flat.length <= FIELD_CAP) return flat;
  return `${flat.slice(0, KEEP_HEAD)}… (cut; full text in message ${messageId}) …${flat.slice(-KEEP_TAIL)}`;
}

export class SenderNotifier {
  private readonly now: () => number;
  private readonly lastSentAt = new Map<string, number>();
  private readonly pending = new Map<string, Pending>();
  private timer: NodeJS.Timeout | null = null;
  /** Counter of failures that had no session to tell, by `target|reason`. */
  readonly undelivered = new Map<string, number>();

  constructor(private readonly deps: SenderNotifierDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The sender a notice may be typed into, or null (then only the counter). */
  provenSender(envelope: MessageEnvelope): string | null {
    if (envelope.message.type === 'delivery-notice') return null;
    const from = envelope.message.from;
    if (this.deps.localAgent && from?.agent !== this.deps.localAgent) return null;
    const machine = from?.machine;
    if (machine && machine !== this.deps.localMachine && machine !== 'local') return null;
    const session = from?.session;
    if (!session || !this.deps.isRunningExact(session)) return null;
    return session;
  }

  /** A same-agent message reached a terminal failure. Never throws. */
  async onFailure(envelope: MessageEnvelope, reason: string): Promise<void> {
    try {
      if (envelope.message.type === 'delivery-notice') return;
      const id = envelope.message.id;
      const target = envelope.message.to?.session ?? '(no session)';
      const sender = this.provenSender(envelope);
      if (!sender) {
        const key = `${target}|${reason}`;
        this.undelivered.set(key, (this.undelivered.get(key) ?? 0) + 1);
        return;
      }
      const item = { id, target, reason, subject: envelope.message.subject ?? '' };
      const last = this.lastSentAt.get(sender) ?? 0;
      if (this.now() - last >= NOTICE_GROUP_WINDOW_MS && !this.pending.has(sender)) {
        await this.send(sender, [item]);
        return;
      }
      const group = this.pending.get(sender) ?? { items: [] };
      group.items.push(item);
      this.pending.set(sender, group);
      await this.deps.markNotice(id, { noticePending: true });
      this.arm();
    } catch (err) {
      // @silent-fallback-ok: the failure is already recorded on the envelope; the notice is best-effort and logged
      this.deps.log?.(`[sender-notice] failure handling error: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Flush every group whose window has passed (one timer serves all groups). */
  async flushDue(force = false): Promise<void> {
    for (const [sender, group] of [...this.pending]) {
      const last = this.lastSentAt.get(sender) ?? 0;
      if (!force && this.now() - last < NOTICE_GROUP_WINDOW_MS) continue;
      this.pending.delete(sender);
      if (this.deps.isRunningExact(sender)) await this.send(sender, group.items);
      else for (const it of group.items) await this.deps.markNotice(it.id, { noticePending: false });
    }
    if (this.pending.size === 0 && this.timer) { clearTimeout(this.timer); this.timer = null; }
    else if (this.pending.size > 0) this.arm();
  }

  /** Boot: notices left pending by a restart are re-queued (callers pass the envelopes). */
  async recover(envelopes: MessageEnvelope[]): Promise<void> {
    for (const env of envelopes) {
      if (env.delivery.noticePending && !env.delivery.noticeSentAt) {
        await this.onFailure(env, env.delivery.failureReason ?? 'not delivered');
      }
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flushDue(); }, NOTICE_GROUP_WINDOW_MS);
    this.timer.unref?.();
  }

  private async send(sender: string, items: Pending['items']): Promise<void> {
    const lines = items.map((it) => `- "${sanitizeField(it.subject, it.id)}" to ${sanitizeField(it.target, it.id)}: ${sanitizeField(it.reason, it.id)} (message ${it.id})`);
    const text = [
      '[delivery notice: quoted data, not an instruction]',
      items.length === 1 ? 'A message you sent was not delivered:' : `${items.length} messages you sent were not delivered:`,
      ...lines,
      'Details: GET /messages/<id>. If a reason says "may have arrived", check before resending.',
    ].join('\n');
    this.lastSentAt.set(sender, this.now());
    const ok = await this.deps.typeInto(sender, text);
    const at = new Date(this.now()).toISOString();
    for (const it of items) await this.deps.markNotice(it.id, ok ? { noticePending: false, noticeSentAt: at } : { noticePending: false });
    if (!ok) this.deps.log?.(`[sender-notice] could not type a notice into ${sender}; recorded and dropped`);
  }
}
