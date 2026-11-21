/**
 * identity-security-piece1d: the dashboard PIN reaches the owner privately, never a group.
 * Spec: docs/specs/identity-security-piece1d-pin-private.md
 *
 * One delivery per machine and PIN generation (plus whenever the owner or an agent asks). Recorded
 * only when Telegram accepts the send. A pending delivery is resumed by the configured owner's own
 * private message. The record holds the generation id, never the PIN or a hash of it.
 */
import fs from 'node:fs';
import path from 'node:path';

export type PinPrivateOutcome =
  | { sent: true; machine: string; recent?: true }
  | { sent: false; reason: 'no-owner' | 'no-private-chat' | 'no-private-channel' | 'no-pin' | 'held' };

export interface DashboardPinPrivateDeps {
  stateDir: string;
  agentName: string;
  machineId: () => string;
  machineLabel: () => string;
  dashboardUrl: () => string | null;
  /** The current PIN, read inside the server only. */
  pin: () => string | null;
  /** The PIN's generation id (never derived from the PIN). */
  generation: () => string | null;
  /** The owner's private send; null when this agent has no Telegram. */
  sendSecret: ((text: string) => Promise<{ ok: true } | { ok: false; reason: 'no-owner' | 'no-private-chat' | 'held' }>) | null;
  /** Called after a delivery succeeds, so the group Dashboard message drops the digits. */
  onDelivered?: () => void;
  /** The owner has another remote way in (a paired owner phone that can approve). */
  ownerHasOtherWayIn?: () => boolean;
  /** This machine does not poll Telegram (a standby): it never shows digits in the group. */
  isStandby?: () => boolean;
}

interface DeliveryRecord { generation: string; delivered: boolean; deliveredAt?: string; lastReason?: string }

export class DashboardPinPrivate {
  private inFlight: Promise<PinPrivateOutcome> | null = null;
  constructor(private readonly deps: DashboardPinPrivateDeps) {}

  private file(): string { return path.join(this.deps.stateDir, 'state', 'dashboard-pin-private.json'); }

  private readAll(): Record<string, DeliveryRecord> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), 'utf-8')) as unknown;
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, DeliveryRecord> : {};
    } catch { return {}; /* @silent-fallback-ok: no record means not delivered yet, the safe reading */ }
  }

  private write(rec: DeliveryRecord): void {
    try {
      const all = this.readAll();
      all[this.deps.machineId()] = rec;
      fs.mkdirSync(path.dirname(this.file()), { recursive: true });
      const tmp = `${this.file()}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
      fs.renameSync(tmp, this.file());
    } catch { /* @silent-fallback-ok: an unwritten record reads as not delivered, so the next trigger sends again (one extra private message, never a group post) */ }
  }

  /** The current PIN generation id (for per-generation limits). */
  currentGeneration(): string { return this.deps.generation() ?? ''; }

  /** Whether this machine's CURRENT PIN generation has reached the owner privately. */
  deliveredForCurrent(): boolean {
    const gen = this.deps.generation();
    if (!gen) return false;
    const rec = this.readAll()[this.deps.machineId()];
    return !!rec && rec.delivered && rec.generation === gen;
  }

  /**
   * Whether the group Dashboard message may still carry the digits: only on a definite "no private
   * route" (no owner set, or Telegram's 403), on the polling machine, when the owner has no other
   * remote way in. Anything else (a held send, a standby, a paired phone) never shows digits.
   */
  groupMayCarryDigits(reason: string): boolean {
    if (reason !== 'no-owner' && reason !== 'no-private-chat') return false;
    if (this.deps.isStandby?.()) return false;
    if (this.deps.ownerHasOtherWayIn?.()) return false;
    return true;
  }

  /** The last outcome reason for the current generation, if any (for the group message wording). */
  lastReason(): string | null {
    const rec = this.readAll()[this.deps.machineId()];
    return rec && rec.generation === this.deps.generation() ? rec.lastReason ?? null : null;
  }

  /**
   * Send the PIN privately. `force` sends even if this generation was already delivered (the owner or
   * an agent asked); otherwise it sends only when not yet delivered. One send in flight at a time.
   */
  deliver(opts: { force?: boolean } = {}): Promise<PinPrivateOutcome> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run(opts).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async run(opts: { force?: boolean }): Promise<PinPrivateOutcome> {
    if (!this.deps.sendSecret) return { sent: false, reason: 'no-private-channel' };
    const pin = this.deps.pin();
    const gen = this.deps.generation();
    if (!pin || !gen) return { sent: false, reason: 'no-pin' };
    if (!opts.force && this.deliveredForCurrent()) return { sent: true, machine: this.deps.machineLabel() };
    // Asked again within 5 minutes of a delivery of this same PIN: it is already there (and the
    // outbound dedup gate would refuse a near-identical message anyway).
    if (opts.force && this.deliveredForCurrent()) {
      const at = Date.parse(this.readAll()[this.deps.machineId()]?.deliveredAt ?? '');
      if (Number.isFinite(at) && Date.now() - at < 5 * 60_000) return { sent: true, machine: this.deps.machineLabel(), recent: true };
    }
    const url = this.deps.dashboardUrl();
    const text = `Your dashboard PIN for ${this.deps.agentName} on ${this.deps.machineLabel()} is ${pin}.`
      + (url ? ` Dashboard: ${url}` : '')
      + `\nKeep it to yourself; I don't post it in the group. Ask me here if you need it again.`
      // Each send is distinct (the origin layer refuses identical content while an earlier send is unresolved).
      + ` (Sent ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC.)`;
    const r = await this.deps.sendSecret(text);
    if (r.ok) {
      this.write({ generation: gen, delivered: true, deliveredAt: new Date().toISOString() });
      try { this.deps.onDelivered?.(); } catch { /* @silent-fallback-ok: the next broadcast edits the group message */ }
      return { sent: true, machine: this.deps.machineLabel() };
    }
    const prior = this.readAll()[this.deps.machineId()];
    const stillDelivered = !!prior && prior.delivered && prior.generation === gen;
    this.write({ generation: gen, delivered: stillDelivered, deliveredAt: stillDelivered ? prior!.deliveredAt : undefined, lastReason: r.reason });
    return { sent: false, reason: r.reason };
  }
}
