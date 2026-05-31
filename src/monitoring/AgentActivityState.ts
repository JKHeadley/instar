/**
 * AgentActivityState — the single shared "when was this agent last active?" signal
 * (agent-sleep design, docs/specs/agent-sleep-mode.md → "Define a single shared
 * idle signal"). The SleepController samples it to decide deep-idle; the server
 * bumps it at the inbound-message chokepoint and on session spawn.
 *
 * Deliberately tiny + in-memory: "activity" for sleep purposes is a real inbound
 * message or a session starting — NOT internal health-check traffic (which must
 * never keep an otherwise-idle agent awake). So the server bumps this only at
 * genuine activity points, not on every HTTP request.
 */
export interface ActivitySnapshot {
  lastInboundAt: number | null;
  lastActivityAt: number | null;
}

export class AgentActivityState {
  private lastInboundAt: number | null = null;
  private lastActivityAt: number | null = null;

  /** A genuine inbound user/agent message arrived. */
  markInbound(now: number): void {
    this.lastInboundAt = now;
    this.lastActivityAt = now;
  }

  /** Non-message activity that should still defer sleep (e.g. a session spawn). */
  markActivity(now: number): void {
    this.lastActivityAt = now;
  }

  snapshot(): ActivitySnapshot {
    return { lastInboundAt: this.lastInboundAt, lastActivityAt: this.lastActivityAt };
  }
}
