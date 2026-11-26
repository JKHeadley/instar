/**
 * Pending-accept markers: what survives a server restart of an invite waiting for this operator
 * (docs/specs/a2a-pairing-invite-link.md §8; live walk 2026-10-20 on 1.3.1362).
 *
 * The recipient side of the invite engine (threadline-core's PairingInviteFlow) keeps a pasted or
 * forwarded invite in MEMORY ONLY, deliberately: the invite carries the secret S, and the MAC key K
 * derived from it, which must never touch this machine's disk before the operator approves. So a
 * restart while an invite waits loses it, and until now nothing said so: the item just vanished.
 *
 * This module persists a marker that holds NO secret: a hash of the invite id, the CLAIMED inviter
 * name and owner, and the expiry. Never S, never K, never the invite text, never the invite id
 * itself. The marker exists exactly while the pending accept does:
 *   - written when the flow records a pending accept (dashboard paste or Telegram forward);
 *   - deleted when the accept is sent, declined, or expires;
 *   - at startup, a marker whose pending accept is gone (it always is: the map is in memory) and
 *     which has not expired becomes a NOTICE: "an invite from <name> was waiting and was cleared by
 *     a restart; paste or forward it again before <expiry>". An expired marker is deleted silently.
 * A notice ends when the same invite is pasted again, when the operator dismisses it on the
 * dashboard, or at the invite's expiry. The Telegram copy of the notice is sent once
 * (`telegramNotified`), after which the marker carries no further Telegram duty.
 *
 * Storage: {stateDir}/threadline/pairing-pending-accept-markers.json (mode 0600). Unreadable or
 * corrupt content is treated as empty and overwritten on the next write: the file only ever holds
 * reminders, so losing it loses a reminder, never a pairing.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { PairingInviteFlow, type InviteFlowDeps, type Result } from './PairingInviteFlow.js';
import { decodeInvite, findInviteToken, INVITE_MAX_TTL_MS } from './PairingInvite.js';

/** Clock skew tolerated between inviter and recipient when checking an invite's lifetime. */
export const INVITE_EXP_SKEW_MS = 5 * 60_000;
/** The reason an invite whose expiry is further out than any invite may live is refused. */
export const EXP_TOO_FAR_REASON = 'this invite claims to stay valid for longer than 24 hours, which no real invite does; do not pair, ask for a new one';

export const PENDING_ACCEPT_MARKERS_FILE = 'pairing-pending-accept-markers.json';

export interface PendingAcceptMarker {
  /** sha256 of the invite id (hex). The id itself is not stored. */
  id: string;
  claimedAgent: string;
  claimedOwner: string;
  /** The invite's expiry (ISO). */
  exp: string;
  /** 'pending': the accept is waiting in memory. 'cleared-by-restart': a restart dropped it. */
  state: 'pending' | 'cleared-by-restart';
  recordedAt: string;
  clearedAt?: string;
  /** The Telegram notice for a cleared marker was delivered (send once). */
  telegramNotified?: boolean;
}

/** What the dashboard and Telegram show. Never carries the invite id, S, K or the invite text. */
export interface RestartNotice { id: string; claimedAgent: string; claimedOwner: string; exp: string; clearedAt: string; telegramNotified: boolean }

export function markerIdFor(iid: string): string {
  return crypto.createHash('sha256').update(`threadline-pending-accept:${String(iid).toLowerCase()}`).digest('hex');
}

const MAX_LABEL = 120;
const label = (s: unknown) => String(s ?? '').slice(0, MAX_LABEL);

export class PairingPendingAcceptMarkers {
  readonly file: string;
  private readonly now: () => Date;

  constructor(stateDir: string, opts: { now?: () => Date } = {}) {
    this.file = path.join(stateDir, 'threadline', PENDING_ACCEPT_MARKERS_FILE);
    this.now = opts.now ?? (() => new Date());
  }

  private read(): PendingAcceptMarker[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { markers?: unknown };
      if (!Array.isArray(parsed?.markers)) return [];
      return parsed.markers.filter((m): m is PendingAcceptMarker =>
        !!m && typeof m === 'object'
        && typeof (m as PendingAcceptMarker).id === 'string'
        && typeof (m as PendingAcceptMarker).exp === 'string'
        && ((m as PendingAcceptMarker).state === 'pending' || (m as PendingAcceptMarker).state === 'cleared-by-restart'));
    } catch {
      // @silent-fallback-ok — no file yet, or unreadable reminders: start empty (see header).
      return [];
    }
  }

  private write(markers: PendingAcceptMarker[]): void {
    if (markers.length === 0) {
      try { SafeFsExecutor.safeUnlinkSync(this.file, { operation: 'src/threadline/PairingPendingAcceptMarkers.ts:write' }); } catch { /* already absent */ }
      return;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ markers }, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
  }

  private expired(m: { exp: string }): boolean {
    const t = Date.parse(m.exp);
    return !(t > this.now().getTime());
  }

  /** A pending accept was recorded in memory. Replaces any notice for the same invite. */
  recordPending(p: { iid: string; claimedAgent: string; claimedOwner: string; exp: string }): void {
    const id = markerIdFor(p.iid);
    const rest = this.read().filter((m) => m.id !== id);
    rest.push({ id, claimedAgent: label(p.claimedAgent), claimedOwner: label(p.claimedOwner), exp: String(p.exp), state: 'pending', recordedAt: this.now().toISOString() });
    this.write(rest);
  }

  /** The pending accept left memory (sent, declined, expired). Deletes its marker. */
  removePending(iid: string): void {
    const id = markerIdFor(iid);
    const all = this.read();
    const rest = all.filter((m) => !(m.id === id && m.state === 'pending'));
    if (rest.length !== all.length) this.write(rest);
  }

  /**
   * Pending markers whose iid is no longer pending in memory are deleted (consumed or expired).
   * Called after the flow pruned its own map, never at startup (see convertAfterRestart).
   */
  reconcile(livePendingIids: Iterable<string>): void {
    const live = new Set([...livePendingIids].map(markerIdFor));
    const all = this.read();
    const rest = all.filter((m) => (m.state === 'pending' ? live.has(m.id) : !this.expired(m)));
    if (rest.length !== all.length) this.write(rest);
  }

  /**
   * Startup: the in-memory map is empty, so every unexpired pending marker was cleared by the
   * restart and becomes a notice; expired ones (pending or notice) are deleted. Returns the notices.
   */
  convertAfterRestart(): RestartNotice[] {
    const at = this.now().toISOString();
    const out: PendingAcceptMarker[] = [];
    for (const m of this.read()) {
      if (this.expired(m)) continue;
      out.push(m.state === 'pending' ? { ...m, state: 'cleared-by-restart', clearedAt: at } : m);
    }
    this.write(out);
    return this.notices();
  }

  /** Unexpired restart notices, oldest first. */
  notices(): RestartNotice[] {
    return this.read()
      .filter((m) => m.state === 'cleared-by-restart' && !this.expired(m))
      .map((m) => ({ id: m.id, claimedAgent: m.claimedAgent, claimedOwner: m.claimedOwner, exp: m.exp, clearedAt: m.clearedAt ?? m.recordedAt, telegramNotified: m.telegramNotified === true }));
  }

  markTelegramNotified(id: string): void {
    const all = this.read();
    let hit = false;
    for (const m of all) if (m.id === id && m.state === 'cleared-by-restart') { m.telegramNotified = true; hit = true; }
    if (hit) this.write(all);
  }

  /** The operator dismissed a notice. Returns false when there was none. */
  dismiss(id: string): boolean {
    const all = this.read();
    const rest = all.filter((m) => !(m.id === id && m.state === 'cleared-by-restart'));
    if (rest.length === all.length) return false;
    this.write(rest);
    return true;
  }
}

/**
 * The invite engine with the marker lifecycle attached. K and S stay exactly where the engine
 * keeps them (its in-memory map); this subclass only reads the engine's own secret-free listing.
 */
export class MarkedPairingInviteFlow extends PairingInviteFlow {
  private readonly clock: () => Date;
  /** When each pending accept was first recorded here: the clamp for its restart hold. */
  private readonly recordedAt = new Map<string, number>();

  constructor(deps: InviteFlowDeps, readonly markers: PairingPendingAcceptMarkers) {
    super(deps);
    this.clock = deps.now ?? (() => new Date());
  }

  /** Marker writes are reminders: a failed write must never fail the pairing step itself. */
  private safely(fn: () => void): void {
    try { fn(); } catch (err) {
      console.warn(`[pairing-invite] pending-accept marker not updated: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private livePendingIids(): string[] {
    return super.listPendingAccepts().map((p) => p.iid);
  }

  /**
   * Refuse on receipt any invite whose expiry is more than INVITE_MAX_TTL_MS (+ 5 min skew) ahead.
   * The expiry is written by the INVITER and core 0.1.0 (pinned from npm) checks only that it
   * parses: the 24 h cap is applied when an invite is created, never when one is received. An
   * unbounded expiry would otherwise bound nothing: the marker, the notice and the auto-updater's
   * restart hold all end at it (Echo's review of this change).
   */
  override async receiveInvite(text: string): Promise<Result> {
    const token = findInviteToken(String(text ?? ''));
    if (token) {
      const d = decodeInvite(token);
      if (d.ok) {
        const exp = Date.parse(d.invite.exp);
        if (Number.isFinite(exp) && exp > this.clock().getTime() + INVITE_MAX_TTL_MS + INVITE_EXP_SKEW_MS) {
          return { ok: false, reason: EXP_TOO_FAR_REASON };
        }
      }
    }
    const r = await super.receiveInvite(text);
    if (r.ok) {
      const iid = String(r.iid);
      this.recordedAt.set(iid, this.clock().getTime());
      const p = super.listPendingAccepts().find((x) => x.iid === iid);
      if (p) this.safely(() => this.markers.recordPending({ iid, claimedAgent: p.claimedAgent, claimedOwner: p.claimedOwner, exp: p.exp }));
    }
    return r;
  }

  override approveAccept(iid: string): Result {
    const r = super.approveAccept(iid);
    this.safely(() => this.markers.reconcile(this.livePendingIids()));
    return r;
  }

  override declineAccept(iid: string): Result {
    const r = super.declineAccept(iid);
    this.safely(() => this.markers.reconcile(this.livePendingIids()));
    return r;
  }

  override listPendingAccepts(): ReturnType<PairingInviteFlow['listPendingAccepts']> {
    const list = super.listPendingAccepts(); // prunes expired accepts from memory
    this.safely(() => this.markers.reconcile(list.map((p) => p.iid)));
    return list;
  }

  /**
   * Restart holds for the auto-updater (spec §8): one per pending accept, held until that
   * invite's expiry. Empty when nothing waits, so a restart is never held for nothing.
   */
  restartHolds(): Array<{ name: string; until: number; reason: string }> {
    const list = this.listPendingAccepts();
    const live = new Set(list.map((p) => p.iid));
    for (const iid of [...this.recordedAt.keys()]) if (!live.has(iid)) this.recordedAt.delete(iid);
    return list
      .map((p) => {
        // Defence in depth beside the receipt check: a hold never outlives INVITE_MAX_TTL_MS from
        // when this engine first saw the accept, whatever expiry the inviter wrote.
        if (!this.recordedAt.has(p.iid)) this.recordedAt.set(p.iid, this.clock().getTime());
        const cap = this.recordedAt.get(p.iid)! + INVITE_MAX_TTL_MS;
        const exp = Date.parse(p.exp);
        return { name: `pairing-invite:${p.iid.slice(0, 8)}`, until: Number.isFinite(exp) ? Math.min(exp, cap) : cap, reason: `a pairing invite from "${p.claimedAgent}" is waiting for the operator's approval` };
      });
  }
}
