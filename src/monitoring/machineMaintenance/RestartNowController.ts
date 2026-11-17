/**
 * Restart now (docs/specs/machine-self-maintenance.md, Part E "Operator trigger" and Part F).
 * CMT-1199 third slice: the first caller of RestartActuator.
 *
 * Only the owner starts it. An agent may OFFER the card (the owner asked for a restart in
 * chat, or the machine looks stuck); the restart begins only on the owner's own tap of the
 * card's button, which the Telegram adapter has already checked came from the verified
 * owner (`mc:` taps are owner-only, P-class). Here, before anything is reserved:
 *
 *  - the offer's single-use nonce is live (15 minutes);
 *  - the lifeline ingress guard is armed, so forging the press takes reading a protected file;
 *  - the machine is enrolled (attended machines too: Restart now is how they get restarted);
 *  - the off switch is on, and no S1 (OS update installing) or S2 (disk or firmware operation)
 *    is active: those refuse even the owner;
 *  - S3 (a person using the machine) and S4 (on battery under 50%) were NAMED on the card the
 *    owner tapped. A hold that appeared after the card was sent gets a fresh card instead;
 *  - a boot under 6 hours ago was named on the card too: tapping that card is the second
 *    confirmation the brakes ask for.
 *
 * Then the short drain, in its first form: the episode is reserved, every running session
 * of this agent is told to save its place, and the owner gets a Cancel button. At T-0
 * (5 minutes) rung 1 runs through the actuator, which re-checks the off switch, S1 and S2
 * inside the host lock. If the machine is still up 8 minutes later, rung 2. If it is still
 * up 8 minutes after that, the episode reads `outcome-unknown` and the owner is told.
 * Closing new work, handoff, cancel at T-3 and pause at T-1 come with the MaintenanceGate
 * slice; until then running sessions resume from their saved place after the boot, as
 * they did after the 11-16 hand restart.
 *
 * A server restart mid-countdown loses no state: the countdown is a host file, re-armed at
 * start, and an episode reserved on an earlier boot is never dispatched (claimRung's
 * wrong-boot check).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../../core/hostSemaphoreCore.js';
import type { BrakeId, HostMaintenanceStore } from './HostMaintenanceStore.js';
import type { DispatchResult } from './RestartActuator.js';
import type { SafetyHoldId } from './planner.js';
import type { HoldReading } from './readings.js';

const MIN = 60_000;
export const RESTART_NOW_OFFER_TTL_MS = 15 * MIN;
export const SHORT_DRAIN_MS = 5 * MIN;
export const RUNG2_AFTER_MS = 8 * MIN;
export const UNKNOWN_AFTER_MS = 8 * MIN;
/** The episode outlives the drain and both rungs, with room for a slow boot. */
export const RESTART_NOW_EPISODE_TTL_MS = SHORT_DRAIN_MS + RUNG2_AFTER_MS + UNKNOWN_AFTER_MS + 10 * MIN;
const RECENT_BOOT_MS = 6 * 60 * MIN;

export interface RestartNowOffer { nonce: string; at: number; expiresAt: number; named: SafetyHoldId[]; recentBoot: boolean; used: boolean }
export type RestartNowPhase = 'countdown' | 'rung1-sent' | 'rung2-sent';
export interface RestartNowActive { nonce: string; episodeId: string; generation: number; bootAt: number; restartAt: number; phase: RestartNowPhase; phaseAt: number; by: string }
interface RestartNowState { offers: RestartNowOffer[]; active: RestartNowActive | null }

export interface RestartNowDeps {
  hostDir: string;
  agent: string;
  machineLabel: () => string;
  store: HostMaintenanceStore;
  dispatch: (input: { episodeId: string; generation: number; rung: 1 | 2 }) => Promise<DispatchResult>;
  /** Enrolled in any mode. Null: unread, which refuses. */
  enrolled: () => Promise<boolean | null>;
  /** The machine-maintenance off switch, read live. */
  enabled: () => boolean;
  ingressArmed: () => boolean;
  /** The four safety holds, read fresh. Null: unread, which refuses (S1 and S2 cannot be cleared unread). */
  readHolds: () => Promise<HoldReading[] | null>;
  readBootAt: () => Promise<number | null>;
  /** The card or notice in the owner's conversation; resolves to a message id or null. */
  sendOwner: (text: string, buttons: Array<{ text: string; data: string }>) => Promise<number | null>;
  /** Tells each running session of this agent to save its place; resolves to how many were told. */
  noticeSessions: (text: string) => Promise<number>;
  now?: () => number;
  /** Timers, injected in tests. Returns a cancel function. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  log?: (line: string) => void;
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

const BRAKE_TEXT: Partial<Record<BrakeId | 'lock-unavailable', string>> = {
  'recent-boot': 'It started less than 6 hours ago. I\'ll send a card that says so; tap it to restart anyway.',
  'ledger-unreadable': 'I couldn\'t record the restart safely, so I didn\'t start it. Try again in a minute.',
  'lock-unavailable': 'Another agent on this machine is writing its maintenance record. Try again in a minute.',
};

export class RestartNowController {
  private readonly now: () => number;
  private cancelTimer: (() => void) | null = null;

  constructor(private readonly deps: RestartNowDeps) { this.now = deps.now ?? Date.now; }

  private get statePath(): string { return path.join(this.deps.hostDir, `restart-now.${this.deps.agent}.json`); }
  private read(): RestartNowState {
    try {
      const v = JSON.parse(fs.readFileSync(this.statePath, 'utf-8')) as Partial<RestartNowState>;
      return { offers: Array.isArray(v.offers) ? v.offers : [], active: v.active ?? null };
    } catch { return { offers: [], active: null }; } // @silent-fallback-ok — no countdown yet
  }
  private write(s: RestartNowState): void {
    fs.mkdirSync(this.deps.hostDir, { recursive: true });
    const keep = s.offers.filter((o) => this.now() < o.expiresAt + 24 * 60 * MIN);
    atomicWriteFileSync(this.statePath, JSON.stringify({ ...s, offers: keep }, null, 2), { mode: 0o644, operation: 'RestartNowController.write' });
  }
  private timer(fn: () => void, ms: number): void {
    this.cancelTimer?.();
    const run = () => { this.cancelTimer = null; void Promise.resolve().then(fn).catch((err) => this.deps.log?.(`restart-now step failed: ${err instanceof Error ? err.message : err}`)); };
    if (this.deps.setTimer) { this.cancelTimer = this.deps.setTimer(run, Math.max(0, ms)); return; }
    const t = setTimeout(run, Math.max(0, ms));
    t.unref?.();
    this.cancelTimer = () => clearTimeout(t);
  }
  stop(): void { this.cancelTimer?.(); this.cancelTimer = null; }

  /** Why a restart cannot be offered at all right now, in plain words, or null. */
  private async refusal(holds: HoldReading[] | null): Promise<string | null> {
    if (!this.deps.enabled()) return 'Machine care is switched off here.';
    const enrolled = await this.deps.enrolled().catch(() => null);
    if (enrolled !== true) return 'This machine isn\'t enrolled for restarts yet.';
    if (holds === null) return 'I couldn\'t read whether an update or disk operation is running, so I won\'t restart it.';
    const hard = holds.find((h) => (h.id === 'S1' || h.id === 'S2') && h.active);
    if (hard) return `${hard.label}${hard.evidence ? ` (${hard.evidence})` : ''}. Restarting now could damage it, so I won't.`;
    if (this.read().active) return 'A restart is already counting down.';
    return null;
  }

  /**
   * Sends the owner the Restart now card, naming first whatever the tap would pass.
   * Returns what happened; `refused` carries the plain reason.
   */
  async offer(): Promise<{ result: 'offered'; named: SafetyHoldId[]; recentBoot: boolean } | { result: 'refused'; reason: string } | { result: 'not-delivered' }> {
    const holds = await this.deps.readHolds().catch(() => null);
    const reason = await this.refusal(holds);
    if (reason) return { result: 'refused', reason };
    const bootAt = await this.deps.readBootAt().catch(() => null);
    if (bootAt === null) return { result: 'refused', reason: 'I couldn\'t read when this machine last started, so I won\'t restart it.' };
    const named = (holds ?? []).filter((h) => (h.id === 'S3' || h.id === 'S4') && h.active);
    const recentBoot = this.now() - bootAt < RECENT_BOOT_MS;
    const lines = [
      `Restart ${this.deps.machineLabel()} now?`,
      '',
      'Running work gets 5 minutes to save its place, then the machine restarts and picks up afterward. Anything open and unsaved in ordinary apps may be lost.',
    ];
    for (const h of named) lines.push('', h.id === 'S3' ? `Someone is using it right now${h.evidence ? ` (${h.evidence})` : ''}.` : `It is on battery (${h.evidence ?? 'under 50%'}).`);
    if (recentBoot) lines.push('', `It last started ${Math.max(1, Math.round((this.now() - bootAt) / (60 * MIN)))} hour(s) ago.`);
    const nonce = crypto.randomBytes(12).toString('hex');
    const id = await this.deps.sendOwner(lines.join('\n'), [
      { text: named.length || recentBoot ? 'Restart anyway' : 'Restart now', data: `mc:rn:${nonce}` },
      { text: 'Not now', data: `mc:rnx:${nonce}` },
    ]);
    if (id === null) return { result: 'not-delivered' };
    const s = this.read();
    s.offers.push({ nonce, at: this.now(), expiresAt: this.now() + RESTART_NOW_OFFER_TTL_MS, named: named.map((h) => h.id), recentBoot, used: false });
    this.write(s);
    return { result: 'offered', named: named.map((h) => h.id), recentBoot };
  }

  /** The owner's tap on a Restart now card (`mc:rn`, `mc:rnx`, `mc:rnc`). */
  async onTap(tap: { data: string; fromIsOwner: boolean; fromUserId: number }): Promise<string> {
    const m = /^mc:(rn|rnx|rnc):([0-9a-f]{24})$/.exec(tap.data);
    if (!m) return 'That button is no longer active.';
    if (!tap.fromIsOwner) return 'Only the owner can choose this.';
    const [, action, nonce] = m;
    if (action === 'rnc') return this.cancel(nonce, `telegram:${tap.fromUserId}`);
    const s = this.read();
    const offer = s.offers.find((o) => o.nonce === nonce);
    if (!offer || offer.used || this.now() >= offer.expiresAt) return 'That card has expired. Ask me again if you still want the restart.';
    if (action === 'rnx') { offer.used = true; this.write(s); return 'OK, not restarting.'; }
    if (!this.deps.ingressArmed()) return 'I can\'t accept this tap safely yet (my message line hasn\'t proved itself since it started). Try again in a minute.';
    return this.start(offer, `telegram:${tap.fromUserId}`);
  }

  private async start(offer: RestartNowOffer, by: string): Promise<string> {
    const holds = await this.deps.readHolds().catch(() => null);
    const reason = await this.refusal(holds);
    if (reason) return reason;
    const fresh = (holds ?? []).filter((h) => (h.id === 'S3' || h.id === 'S4') && h.active && !offer.named.includes(h.id));
    if (fresh.length) {
      void this.offer();
      return `Something changed since the card: ${fresh.map((h) => h.label.toLowerCase()).join(', ')}. I've sent a fresh card.`;
    }
    const bootAt = await this.deps.readBootAt().catch(() => null);
    if (bootAt === null) return 'I couldn\'t read when this machine last started, so I won\'t restart it.';
    const r = this.deps.store.reserveEpisode({ kind: 'operator', by, bootAt, ttlMs: RESTART_NOW_EPISODE_TTL_MS, overrideRecentBoot: offer.recentBoot });
    const s = this.read();
    const o = s.offers.find((x) => x.nonce === offer.nonce);
    if (o) o.used = true;
    if (!r.ok) {
      this.write(s);
      if (r.brake === 'recent-boot') void this.offer();
      return BRAKE_TEXT[r.brake] ?? 'I couldn\'t start the restart safely. Nothing changed.';
    }
    const restartAt = this.now() + SHORT_DRAIN_MS;
    s.active = { nonce: offer.nonce, episodeId: r.episodeId, generation: r.generation, bootAt, restartAt, phase: 'countdown', phaseAt: this.now(), by };
    this.write(s);
    this.deps.log?.(`restart now: episode ${r.episodeId} g${r.generation} reserved by ${by}; T-0 ${new Date(restartAt).toISOString()}`);
    const told = await this.deps.noticeSessions(
      `[machine-maintenance] This machine restarts at ${clock(restartAt)}, in 5 minutes, at the owner's request. Save your place now: commit or write down what you are doing and where you are. Don't start anything long. You will be resumed after the restart.`,
    ).catch(() => 0);
    await this.deps.sendOwner(
      `Restarting ${this.deps.machineLabel()} at ${clock(restartAt)}. ${told === 1 ? '1 running session has' : `${told} running sessions have`} been told to save their place.`,
      [{ text: 'Cancel', data: `mc:rnc:${offer.nonce}` }],
    ).catch(() => null);
    this.timer(() => this.step(), SHORT_DRAIN_MS);
    return `Restarting at ${clock(restartAt)}.`;
  }

  private async cancel(nonce: string, by: string): Promise<string> {
    const s = this.read();
    const a = s.active;
    if (!a || a.nonce !== nonce) return 'There is no restart counting down.';
    if (a.phase !== 'countdown') return 'Too late to cancel: the restart was already sent.';
    this.stop();
    this.deps.store.transitionEpisode({ episodeId: a.episodeId, generation: a.generation, state: 'aborted', by, reason: 'owner-cancelled' });
    s.active = null;
    this.write(s);
    await this.deps.noticeSessions('[machine-maintenance] The restart was cancelled. Carry on.').catch(() => 0);
    return 'Cancelled. Nothing restarted.';
  }

  /** Re-arms a countdown after a server restart. A countdown from an earlier boot is closed, never dispatched. */
  async resume(): Promise<void> {
    const s = this.read();
    const a = s.active;
    if (!a) return;
    const bootAt = await this.deps.readBootAt().catch(() => null);
    if (bootAt !== null && Math.abs(bootAt - a.bootAt) > 60_000) {
      // The machine restarted: the boot observer attributes it. Nothing left to do here.
      s.active = null;
      this.write(s);
      return;
    }
    const due = a.phase === 'countdown' ? a.restartAt : a.phaseAt + (a.phase === 'rung1-sent' ? RUNG2_AFTER_MS : UNKNOWN_AFTER_MS);
    this.timer(() => this.step(), due - this.now());
  }

  /** One step of the ladder: rung 1 at T-0, rung 2 if still up, then outcome-unknown. */
  async step(): Promise<void> {
    const s = this.read();
    const a = s.active;
    if (!a) return;
    const label = this.deps.machineLabel();
    if (a.phase === 'rung2-sent') {
      this.deps.store.transitionEpisode({ episodeId: a.episodeId, generation: a.generation, state: 'outcome-unknown', by: this.deps.agent, reason: 'still-up-after-rung2' });
      s.active = null;
      this.write(s);
      await this.deps.sendOwner(`${label} was told to restart and hasn't. I can't tell whether it still will. Nothing more will be sent to it on its own; ask me if you want another try.`, []).catch(() => null);
      return;
    }
    const rung: 1 | 2 = a.phase === 'countdown' ? 1 : 2;
    const res = await this.deps.dispatch({ episodeId: a.episodeId, generation: a.generation, rung });
    this.deps.log?.(`restart now: rung ${rung} ${res.dispatched ? res.outcome : `not dispatched (${res.reason})`}`);
    if (!res.dispatched || res.outcome === 'refused') {
      if (rung === 1) {
        // claimRung already closed the episode for a fresh-check refusal; anything else is closed here.
        if (!res.dispatched) this.deps.store.transitionEpisode({ episodeId: a.episodeId, generation: a.generation, state: 'aborted', by: this.deps.agent, reason: res.reason });
        s.active = null;
        this.write(s);
        await this.deps.noticeSessions('[machine-maintenance] The restart did not happen. Carry on.').catch(() => 0);
        await this.deps.sendOwner(`I didn't restart ${label}: ${plainReason(res)} Nothing restarted.`, []).catch(() => null);
        return;
      }
      // Rung 2 not sent: rung 1 may still land. Wait the same interval, then read unknown.
    }
    s.active = { ...a, phase: rung === 1 ? 'rung1-sent' : 'rung2-sent', phaseAt: this.now() };
    this.write(s);
    this.timer(() => this.step(), rung === 1 ? RUNG2_AFTER_MS : UNKNOWN_AFTER_MS);
  }

  readActive(): RestartNowActive | null { return this.read().active; }
}

function plainReason(res: DispatchResult): string {
  if (res.dispatched) return 'the machine refused the restart command; the restart permission isn\'t installed.';
  switch (res.reason) {
    case 'test-process': case 'throwaway': case 'throwaway-unread': return 'this is a test copy of me, which never restarts a machine.';
    case 'boot-unread': return 'I couldn\'t read when the machine last started.';
    case 'stale-generation': case 'terminal': case 'expired': return 'the restart was replaced or ran out of time.';
    case 'wrong-boot': return 'the machine already restarted.';
    default: return /S1|S2|update|disk|off/i.test(res.reason) ? `${res.reason}.` : 'a safety check refused it at the last moment.';
  }
}

let active: RestartNowController | null = null;
export function setActiveRestartNowController(c: RestartNowController | null): void { active = c; }
export function getActiveRestartNowController(): RestartNowController | null { return active; }
