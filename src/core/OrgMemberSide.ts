/**
 * A member agent's side of check-ins (docs/specs/org-members-and-keepers.md §A, §C): its member key,
 * the invitation token, consent, a pending rejoin, and removal notices. Everything lives under
 * `org/keys/<orgId>/`, which leave does not move, so a rejoin keeps the same key and entry.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { newMemberKeyPair, plainName, signPayload, type CheckinBody } from './OrgMembers.js';
import { orgRequest } from './OrgPackUpdater.js';

interface SideState {
  publicKey: string;
  inviteToken: string | null;
  enrolled: boolean;
  pendingRejoin: boolean;
  /** 'yes' after the join screen or the consent card; absent for members who joined before check-ins existed. */
  consent: 'yes' | 'no' | null;
  seenRemovals: string[];
  pendingRemoval: { id: string; at: number } | null;
  lastAt: number;
  /** Bumped on every change on any machine, so the newest change wins when machines copy to each other. */
  changedAt?: number;
}

function writeAtomic(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** A member's own check-in state as copied to the agent's other machines (org-members-and-keepers §Multi-machine). */
export interface MemberSideExport {
  orgId: string;
  state: unknown;
  memberKeyPem: string;
  keeper: { pem: string; meta: unknown } | null;
}

export class OrgMemberSide {
  constructor(private readonly stateDir: string, private readonly orgId: string, private readonly now: () => number = Date.now) {}

  private dir(): string { return path.join(this.stateDir, 'org', 'keys', this.orgId); }
  private stateFile(): string { return path.join(this.dir(), 'member.json'); }
  private keyFile(): string { return path.join(this.dir(), 'member-key'); }

  state(): SideState | null {
    try { return JSON.parse(fs.readFileSync(this.stateFile(), 'utf-8')) as SideState; } catch { return null; } // @silent-fallback-ok — no member state yet
  }
  private save(s: SideState, keepStamp = false): void {
    if (!keepStamp) s.changedAt = Math.max(this.now(), (s.changedAt ?? 0) + 1);
    writeAtomic(this.stateFile(), JSON.stringify(s));
  }

  /** At every join (app, installer or a newer link): make or keep the key, store the token, note a rejoin. */
  onJoin(opts: { inviteToken?: string | null; afterLeave: boolean; consent: boolean }): SideState {
    let s = this.state();
    if (!s || !fs.existsSync(this.keyFile())) {
      const kp = newMemberKeyPair();
      writeAtomic(this.keyFile(), kp.privateKeyPem);
      s = { publicKey: kp.publicKey, inviteToken: null, enrolled: false, pendingRejoin: false, consent: null, seenRemovals: [], pendingRemoval: null, lastAt: 0 };
    }
    if (opts.inviteToken && /^[A-Za-z0-9_-]{10,64}$/.test(opts.inviteToken)) s.inviteToken = opts.inviteToken;
    if (opts.afterLeave) s.pendingRejoin = true;
    if (opts.consent) s.consent = 'yes';
    this.save(s);
    return s;
  }

  setConsent(yes: boolean): void {
    const s = this.state();
    if (!s) return;
    s.consent = yes ? 'yes' : 'no';
    this.save(s);
  }

  /** A signed check-in body (spec §A). The token rides along until enrolled, the rejoin until joined. */
  body(fields: { agentName: string; personName: string; appliedVersion: number; state: 'joined' | 'left' }): CheckinBody | null {
    const s = this.state();
    let pem: string;
    try { pem = fs.readFileSync(this.keyFile(), 'utf-8'); } catch { return null; } // @silent-fallback-ok — no key, nothing to send
    if (!s) return null;
    const at = Math.max(this.now(), s.lastAt + 1);
    s.lastAt = at;
    this.save(s);
    const unsigned: Omit<CheckinBody, 'sig'> = {
      v: 1, orgId: this.orgId, memberKey: s.publicKey,
      agentName: plainName(fields.agentName) ?? '', personName: plainName(fields.personName) ?? '',
      appliedVersion: fields.appliedVersion, state: fields.state, at,
      ...(s.inviteToken && (!s.enrolled || s.pendingRejoin) ? { inviteToken: s.inviteToken } : {}),
      ...(s.pendingRejoin ? { rejoin: true } : {}),
    };
    return signPayload(unsigned, pem) as CheckinBody;
  }

  /** Reads an answer: enrolment, rejoin acknowledgement, and removal notices (spec §A, §C). */
  read(status: number, answer: unknown): void {
    const s = this.state();
    if (!s) return;
    const a = (answer ?? {}) as { error?: string; enrolled?: boolean; state?: string | null; removal?: { id?: unknown; at?: unknown } | null };
    if (status === 403 && a.error === 'invitation-needed') { s.enrolled = false; this.save(s); return; }
    if (status !== 200) return;
    if (a.enrolled) s.enrolled = true;
    if (a.state === 'joined') s.pendingRejoin = false;
    const r = a.removal;
    if (r && typeof r.id === 'string' && /^[0-9a-f]{16}$/.test(r.id) && typeof r.at === 'number') {
      if (!s.seenRemovals.includes(r.id)) { s.pendingRemoval = { id: r.id, at: r.at }; s.seenRemovals = [...s.seenRemovals, r.id].slice(-50); }
    } else if (r === null) {
      s.pendingRemoval = null;
    }
    this.save(s);
  }

  /** For a peer machine of the same agent: the member key, token, consent, rejoin and notices (and a keeper key). */
  exportForPeer(): MemberSideExport | null {
    const st = this.state();
    let pem: string;
    try { pem = fs.readFileSync(this.keyFile(), 'utf-8'); } catch { return null; } // @silent-fallback-ok — nothing to copy yet
    if (!st) return null;
    let keeper: MemberSideExport['keeper'] = null;
    try {
      const kp = path.join(this.dir(), 'keeper-key');
      keeper = { pem: fs.readFileSync(kp, 'utf-8'), meta: JSON.parse(fs.readFileSync(`${kp}.json`, 'utf-8')) };
    } catch { keeper = null; } // @silent-fallback-ok — not a keeper here
    return { orgId: this.orgId, state: st, memberKeyPem: pem, keeper };
  }

  /**
   * Takes a peer's copy when this machine has none, or when the peer's is newer (a later `lastAt`, or the
   * same key with a removal or rejoin this machine hasn't seen). The key never changes once set.
   */
  importFromPeer(x: MemberSideExport): boolean {
    if (x.orgId !== this.orgId || typeof x.memberKeyPem !== 'string') return false;
    const theirs = x.state as SideState;
    if (!theirs || typeof theirs.publicKey !== 'string') return false;
    const mine = this.state();
    if (mine && mine.publicKey !== theirs.publicKey) return false;
    // The newest change wins (consent, a dismissed notice, a check-in answer), whichever machine made it.
    if (mine && (theirs.changedAt ?? 0) <= (mine.changedAt ?? 0)) return false;
    if (!mine || !fs.existsSync(this.keyFile())) writeAtomic(this.keyFile(), x.memberKeyPem);
    const merged: SideState = mine ? { ...theirs, seenRemovals: [...new Set([...(mine.seenRemovals ?? []), ...(theirs.seenRemovals ?? [])])].slice(-50) } : theirs;
    this.save(merged, true);
    if (x.keeper && typeof x.keeper.pem === 'string') {
      const kp = path.join(this.dir(), 'keeper-key');
      if (!fs.existsSync(kp)) { writeAtomic(kp, x.keeper.pem); writeAtomic(`${kp}.json`, JSON.stringify(x.keeper.meta)); }
    }
    return true;
  }

  dismissRemoval(): void {
    const s = this.state();
    if (!s) return;
    s.pendingRemoval = null;
    this.save(s);
  }

  /** Sends one check-in through the update check's address rules; returns whether it was answered. */
  async send(origin: string, fields: Parameters<OrgMemberSide['body']>[0], net: { fetchFn?: typeof fetch; lookup?: (host: string) => Promise<string[]> } = {}): Promise<boolean> {
    const s = this.state();
    if (!s || s.consent !== 'yes') return false;
    const b = this.body(fields);
    if (!b) return false;
    const r = await orgRequest(origin, '/org/checkin', b, net);
    if (!r.ok) return false;
    this.read(r.status, r.body);
    return true;
  }
}
