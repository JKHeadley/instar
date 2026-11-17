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
}

function writeAtomic(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class OrgMemberSide {
  constructor(private readonly stateDir: string, private readonly orgId: string, private readonly now: () => number = Date.now) {}

  private dir(): string { return path.join(this.stateDir, 'org', 'keys', this.orgId); }
  private stateFile(): string { return path.join(this.dir(), 'member.json'); }
  private keyFile(): string { return path.join(this.dir(), 'member-key'); }

  state(): SideState | null {
    try { return JSON.parse(fs.readFileSync(this.stateFile(), 'utf-8')) as SideState; } catch { return null; } // @silent-fallback-ok — no member state yet
  }
  private save(s: SideState): void { writeAtomic(this.stateFile(), JSON.stringify(s)); }

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
