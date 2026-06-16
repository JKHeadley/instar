/**
 * RealChannelDriver — the production `ChannelDriver` for the LiveTestHarness
 * (docs/specs/live-user-channel-proof-standard.md §5.4 "Platform-Sanctioned
 * Automation"). It drives a feature end-to-end through the REAL user surfaces by
 * composing one `SurfaceSender` per surface (Telegram, Slack, dashboard) plus:
 *
 *   - a DemoChannelRegistry → `isDemoChannel` (§5.3 isolation), and
 *   - a `resolveResponderMachine` reader → the `responderMachineId` stamped on every
 *     reply, which is the DETERMINISTIC cross-machine proof the harness asserts on
 *     (e.g. "after the transfer, the reply was served FROM the Mini").
 *
 * The driver itself is pure transport composition: it knows nothing about HTTP,
 * Telegram, or Slack — each surface sender + the placement reader are injected, so
 * this module is fully unit-testable with fakes. The real senders (a demo-bot/user
 * Telegram sender, a Slack user-token sender) and the real placement reader (a
 * GET /pool/placement call) are wired at construction in server.ts.
 *
 * Safety: a surface with no registered sender is a hard error on use (never a silent
 * skip that would fabricate a "no reply" FAIL), and `responderMachineId` resolution
 * failures degrade to `undefined` (the harness then simply can't assert on responder)
 * rather than throwing the whole scenario — the SEND/REPLY evidence is still recorded.
 */

import type { ChannelDriver, SendResult, ReplyResult } from './LiveTestHarness.js';
import type { Surface } from './LiveTestArtifactStore.js';
import type { DemoChannelRegistry } from './DemoChannelRegistry.js';

/** One real surface transport. `channelId` is the surface-native id (topic id, Slack channel). */
export interface SurfaceSender {
  /** Send a USER-role message on the real surface. */
  send(channelId: string, text: string): Promise<SendResult>;
  /** Await the agent's reply after `afterMessageId` (null on timeout). No responder id — the driver stamps that. */
  awaitReply(channelId: string, opts: { timeoutMs: number; afterMessageId?: string }): Promise<Omit<ReplyResult, 'responderMachineId'> | null>;
}

export interface RealChannelDriverDeps {
  /** Per-surface real senders. A surface absent here throws if a scenario targets it. */
  senders: Partial<Record<Surface, SurfaceSender>>;
  /** §5.3 demo-channel isolation. */
  demoRegistry: Pick<DemoChannelRegistry, 'isDemoChannel'>;
  /**
   * Resolve WHICH machine served (owns) the given channel at reply time — the
   * cross-machine proof. Returns the machine id (or nickname-resolvable id), or null
   * if it can't be determined. MUST NOT throw on a transient read error (return null).
   */
  resolveResponderMachine: (surface: Surface, channelId: string) => Promise<string | null>;
  logger?: (m: string) => void;
}

export class RealChannelDriver implements ChannelDriver {
  private readonly d: RealChannelDriverDeps;
  constructor(deps: RealChannelDriverDeps) { this.d = deps; }

  private log(m: string): void { this.d.logger?.(`[real-channel-driver] ${m}`); }

  private senderFor(surface: Surface): SurfaceSender {
    const s = this.d.senders[surface];
    if (!s) {
      // A missing sender is a CONFIGURATION error, surfaced loudly — never a silent
      // skip that the harness would misread as a clean "no reply" FAIL.
      throw new Error(`no real sender configured for surface "${surface}" — cannot drive it`);
    }
    return s;
  }

  isDemoChannel(surface: Surface, channelId: string): boolean {
    return this.d.demoRegistry.isDemoChannel(surface, channelId);
  }

  async send(surface: Surface, channelId: string, text: string): Promise<SendResult> {
    return this.senderFor(surface).send(channelId, text);
  }

  async awaitReply(surface: Surface, channelId: string, opts: { timeoutMs: number; afterMessageId?: string }): Promise<ReplyResult | null> {
    const reply = await this.senderFor(surface).awaitReply(channelId, opts);
    if (!reply) return null;
    let responderMachineId: string | undefined;
    try {
      responderMachineId = (await this.d.resolveResponderMachine(surface, channelId)) ?? undefined;
    } catch (err) {
      // Degrade, never throw: we still have a real reply; we just can't attribute the
      // responder machine this round. The harness records the reply evidence and
      // (only) any responder-machine assertion can't be satisfied.
      this.log(`responder-machine resolve failed for ${surface}:${channelId} (recording reply without it): ${err instanceof Error ? err.message : String(err)}`);
      responderMachineId = undefined;
    }
    return { ...reply, responderMachineId };
  }
}
