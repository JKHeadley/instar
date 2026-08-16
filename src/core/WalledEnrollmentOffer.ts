/**
 * WalledEnrollmentOffer — the §5A STUB for the cross-machine account & quota sharing
 * feature (spec: docs/specs/cross-machine-account-quota-sharing.md §5A / §3, governed
 * by D14/D15/D16).
 *
 * WHAT THIS IS (and is NOT): the eventual mechanism is a per-machine auto-enroll
 * bridge that makes a WALLED machine serve-capable by enrolling its OWN login. That
 * mechanism is WS5.2 Mechanism B, which DOES NOT EXIST in source on this branch (D16
 * — verified zero hits for accountFollowMe/enroll-drive). So this ships as a STUB:
 *   - DETECT a machine that cannot serve (no live account / all walled).
 *   - SURFACE an operator-INITIATED, PIN-authenticated enrollment OFFER via the
 *     existing attention path (D14).
 *   - It NEVER mints a credential, NEVER fires a mesh enrollment verb (D14/D15:
 *     enrollment is operator-initiated, never mesh-authenticated), and NEVER blocks.
 *
 * The §5.3/§5.4 layers handle serving in the meantime (route the seat to a peer that
 * can serve NOW, or degrade honestly). The offer is the Close-the-Loop surface that
 * gets the walled machine eventually enrolled — operator's decision, operator's PIN.
 *
 * Pure detection (`shouldOfferEnrollment`) is split from the side-effecting surfacing
 * so the "offered, never blocks" contract is unit-testable.
 */

import type { MachineCapacity } from './types.js';
import { hasNonWalledAccount } from './serveCapability.js';

/** A walled machine the stub would offer enrollment for. */
export interface WalledMachine {
  machineId: string;
  nickname?: string;
  reason: 'no-account-or-walled';
}

/**
 * Pure detection: which ONLINE machines in the pool currently have NO non-walled
 * account (the candidates for a per-machine enrollment offer). A machine that has a
 * non-walled account is serve-capable and needs no offer.
 *
 * NOTE: this is intentionally about ACCOUNT presence (hasNonWalledAccount), not
 * per-channel reachability — the offer is "this machine has no working account,
 * enroll one," independent of any single topic's channel.
 */
export function detectWalledMachines(machines: MachineCapacity[]): WalledMachine[] {
  const out: WalledMachine[] = [];
  for (const m of machines) {
    if (!m.online) continue; // offline machines age out; the offer is for live-but-walled
    // canServe summary is the precise signal; fall back to raw quotaState if a peer
    // predates the summary (older heartbeat) — both resolve to hasNonWalledAccount.
    const nonWalled = m.canServe
      ? m.canServe.hasNonWalledAccount
      : hasNonWalledAccount(m.quotaState);
    if (!nonWalled) {
      out.push({ machineId: m.machineId, nickname: m.nickname, reason: 'no-account-or-walled' });
    }
  }
  return out;
}

export interface WalledEnrollmentOfferDeps {
  /** Surface ONE operator attention item (the enrollment offer). Idempotent on the
   *  item id (the attention store dedupes); returns whatever the attention path does. */
  surfaceOffer: (input: {
    id: string;
    title: string;
    summary: string;
    machineId: string;
    nickname?: string;
  }) => Promise<unknown> | unknown;
  /** Whether the feature is enabled (resolveDevAgentGate live per call). */
  isEnabled: () => boolean;
  /** Whether dry-run holds — when true, the offer decision is computed + audited but
   *  no attention item is surfaced (D6 canary). */
  isDryRun: () => boolean;
  /** Append one audit line. */
  audit?: (rec: { ts: string; machineId: string; surfaced: boolean; dryRun: boolean; reason: string }) => void;
  now?: () => number;
}

export class WalledEnrollmentOfferStub {
  private readonly d: WalledEnrollmentOfferDeps;
  /** Per-machine: whether an offer was already surfaced this walled spell (idempotent —
   *  cleared when the machine recovers). */
  private readonly offered = new Set<string>();

  constructor(deps: WalledEnrollmentOfferDeps) {
    this.d = deps;
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /**
   * Sweep the pool: surface a per-machine enrollment offer for each walled machine
   * that hasn't already been offered this spell. STRICT no-op when dark. NEVER blocks
   * anything — the §5.3/§5.4 layers serve regardless.
   */
  async sweep(machines: MachineCapacity[]): Promise<{ surfaced: string[]; skipped: string[] }> {
    const surfaced: string[] = [];
    const skipped: string[] = [];
    if (!this.d.isEnabled()) return { surfaced, skipped };

    const walled = detectWalledMachines(machines);
    const walledIds = new Set(walled.map((w) => w.machineId));

    // Clear the offered-flag for any machine that has RECOVERED (so a future wall
    // re-offers) — the spell-scoped idempotency terminal.
    for (const id of [...this.offered]) {
      if (!walledIds.has(id)) this.offered.delete(id);
    }

    for (const w of walled) {
      if (this.offered.has(w.machineId)) {
        skipped.push(w.machineId);
        continue;
      }
      const dryRun = this.d.isDryRun();
      this.offered.add(w.machineId); // mark before the await so a slow surface never double-offers
      if (dryRun) {
        this.d.audit?.({ ts: new Date(this.now()).toISOString(), machineId: w.machineId, surfaced: false, dryRun: true, reason: 'dry-run-would-offer' });
        skipped.push(w.machineId);
        continue;
      }
      try {
        await this.d.surfaceOffer({
          id: `serve-failover:enroll-offer:${w.machineId}`,
          title: `Machine "${w.nickname ?? w.machineId}" has no working account`,
          summary:
            `Machine "${w.nickname ?? w.machineId}" currently has no live, non-walled Claude account, so it cannot serve conversations on its own. ` +
            `Conversations are being served from other machines in the meantime. ` +
            `To make this machine serve-capable, enroll an account on it (operator-initiated, PIN-authenticated — it logs in locally; no credential is copied between machines).`,
          machineId: w.machineId,
          nickname: w.nickname,
        });
        this.d.audit?.({ ts: new Date(this.now()).toISOString(), machineId: w.machineId, surfaced: true, dryRun: false, reason: 'walled-machine-enrollment-offer' });
        surfaced.push(w.machineId);
      } catch (err) {
        // NOT silent: audited as not-surfaced; clear the flag so a later sweep retries.
        this.offered.delete(w.machineId);
        this.d.audit?.({ ts: new Date(this.now()).toISOString(), machineId: w.machineId, surfaced: false, dryRun: false, reason: `offer-surface-failed: ${err instanceof Error ? err.message : String(err)}` });
        skipped.push(w.machineId);
      }
    }
    return { surfaced, skipped };
  }
}
