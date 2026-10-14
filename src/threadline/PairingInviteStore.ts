/**
 * The inviter's record of its open pairing invites (docs/specs/a2a-pairing-invite-link.md §4.1, §4.4).
 *
 * One JSON file, mode 0600, under `<stateDir>/threadline/`. The one-time secret S is kept only
 * while an invite is open: it is deleted the moment the invite is used, revoked or expires,
 * so a later read of the file cannot accept anything. At most one invite is open per bound
 * peer; making a new one for the same peer replaces the old.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { PairingInvite } from './PairingInvite.js';

export type InviteState = 'open' | 'used' | 'revoked' | 'expired';

export interface InviteAcceptor {
  fp: string;
  key: string;
  owner: string;
  agent: string;
  acceptedAt: string;
}

export interface StoredInvite {
  iid: string;
  /** Present only while `state === 'open'`. */
  secret?: string;
  exp: string;
  bind?: string;
  owner: string;
  agent: string;
  state: InviteState;
  createdAt: string;
  /** The (first) agent whose valid accept used this invite. */
  acceptor?: InviteAcceptor;
  /**
   * Used invites only: the MAC key derived from S, kept until `exp` solely to verify a SECOND
   * accept (spec §4.4.2; see PairingInviteFlow's header). Deleted at expiry. S itself is gone.
   */
  macKey?: string;
  /** The inviter operator's decision on the acceptor (Finish or "Not them"). Set once. */
  decision?: 'finished' | 'rejected';
  decidedAt?: string;
  /** A second, valid accept arrived after use (a leak): who, and when. The first acceptor was paused. */
  secondAccept?: { fp: string; owner: string; agent: string; at: string };
}

/** What callers outside the store see: never the secret. */
export type InviteSummary = Omit<StoredInvite, 'secret' | 'macKey'>;

export const INVITE_STORE_FILE = 'pairing-invites.json';
/** Closed invites are kept this long (for the second-accept alarm and the dashboard), then dropped. */
const CLOSED_RETENTION_MS = 7 * 24 * 60 * 60_000;

export class PairingInviteStore {
  private readonly file: string;
  private invites = new Map<string, StoredInvite>();

  constructor(stateDir: string, private readonly now: () => Date = () => new Date()) {
    this.file = path.join(stateDir, 'threadline', INVITE_STORE_FILE);
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { invites?: StoredInvite[] };
      for (const inv of raw.invites ?? []) if (inv && typeof inv.iid === 'string') this.invites.set(inv.iid, inv);
    } catch {
      // No file yet, or unreadable: start empty. An unreadable file means open invites can't be
      // accepted, which fails closed.
    }
    this.sweep();
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ invites: [...this.invites.values()] }, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
  }

  /** Expire due invites (deleting their secrets) and drop old closed ones. Returns whether anything changed. */
  sweep(): boolean {
    const now = this.now().getTime();
    let changed = false;
    for (const [iid, inv] of this.invites) {
      if (inv.state === 'open' && now >= Date.parse(inv.exp)) {
        inv.state = 'expired';
        delete inv.secret;
        changed = true;
      }
      if (inv.macKey && now >= Date.parse(inv.exp)) {
        delete inv.macKey;
        changed = true;
      }
      if (inv.state !== 'open' && now - Date.parse(inv.exp) > CLOSED_RETENTION_MS) {
        this.invites.delete(iid);
        changed = true;
      }
    }
    if (changed) this.save();
    return changed;
  }

  /** Record a new invite. A previous OPEN invite bound to the same peer is revoked (one per peer). */
  add(inv: PairingInvite): { replaced?: string } {
    this.sweep();
    let replaced: string | undefined;
    if (inv.bind) {
      for (const other of this.invites.values()) {
        if (other.state === 'open' && other.bind === inv.bind) {
          other.state = 'revoked';
          delete other.secret;
          replaced = other.iid;
        }
      }
    }
    this.invites.set(inv.iid, {
      iid: inv.iid, secret: inv.secret, exp: inv.exp, bind: inv.bind, owner: inv.owner, agent: inv.agent,
      state: 'open', createdAt: this.now().toISOString(),
    });
    this.save();
    return replaced ? { replaced } : {};
  }

  /** The record, including the secret while open. For the engine only. */
  getInternal(iid: string): StoredInvite | undefined {
    this.sweep();
    return this.invites.get(String(iid).toLowerCase());
  }

  /** Mark used by its first valid acceptor and delete the secret (single use, spec §4.4.4). */
  markUsed(iid: string, acceptor: Omit<InviteAcceptor, 'acceptedAt'>, macKeyHex?: string): boolean {
    const inv = this.invites.get(iid);
    if (!inv || inv.state !== 'open') return false;
    inv.state = 'used';
    delete inv.secret;
    if (macKeyHex) inv.macKey = macKeyHex;
    inv.acceptor = { ...acceptor, acceptedAt: this.now().toISOString() };
    this.save();
    return true;
  }

  /** Record the operator's decision on a used invite's acceptor. Refused once decided. */
  markDecided(iid: string, decision: 'finished' | 'rejected'): boolean {
    const inv = this.invites.get(String(iid).toLowerCase());
    if (!inv || inv.state !== 'used' || inv.decision) return false;
    inv.decision = decision;
    inv.decidedAt = this.now().toISOString();
    this.save();
    return true;
  }

  /** Record a second valid accept on a used invite (the latest one wins the record). */
  recordSecondAccept(iid: string, late: { fp: string; owner: string; agent: string }): boolean {
    const inv = this.invites.get(String(iid).toLowerCase());
    if (!inv || inv.state !== 'used') return false;
    inv.secondAccept = { ...late, at: this.now().toISOString() };
    this.save();
    return true;
  }

  revoke(iid: string): boolean {
    const inv = this.invites.get(String(iid).toLowerCase());
    if (!inv || inv.state !== 'open') return false;
    inv.state = 'revoked';
    delete inv.secret;
    this.save();
    return true;
  }

  /** Every invite, without secrets, newest first. */
  list(): InviteSummary[] {
    this.sweep();
    return [...this.invites.values()]
      .map(({ secret: _s, macKey: _k, ...rest }) => rest)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
