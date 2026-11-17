/**
 * The organization's view of its members (docs/specs/org-members-and-keepers.md §A–C): signed
 * check-ins, invitation tokens, the membership transition table, removal and restore, and the
 * Work agents page listing. Lives on the machine holding the organization key, under
 * `org/published/<orgId>.members.json` and `.invites.json`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { recordPayload } from './OrgPack.js';

export const MEMBERS_JOINED_MAX = 500;
export const LEFT_KEEP_MAX = 5000;
export const REMOVED_KEEP_MAX = 10_000;
export const INVITE_MAX_USES = 50;
export const CHECKIN_WINDOW_MS = 10 * 60_000;
export const ONE_OFF_DROP_MS = 30 * 24 * 3600_000;
export const QUIET_MS = 3 * 24 * 3600_000;
export const NAME_MAX = 120;
/** Line separators, bidirectional overrides and zero-width characters, which can make a name display as other text. */
const HIDDEN_CHARS = new RegExp('[\\u2028\\u2029\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2069\\uFEFF]');

export type MemberState = 'joined' | 'left' | 'removed';

export interface CheckinBody {
  v: 1;
  orgId: string;
  memberKey: string;
  agentName: string;
  personName: string;
  appliedVersion: number;
  state: 'joined' | 'left';
  at: number;
  inviteToken?: string;
  rejoin?: boolean;
  sig: string;
}

export interface MemberEntry {
  agentName: string;
  personName: string;
  appliedVersion: number;
  state: MemberState;
  firstSeen: number;
  lastSeen: number;
  lastAt: number;
  checkins: number;
  leftAt?: number;
  removal?: { id: string; at: number };
}

export interface InviteEntry { createdAt: number; maxUses: number; usedBy: string[]; revokedAt?: number; active: boolean }

export type CheckinAnswer =
  | { status: 200; body: { ok: true; enrolled: boolean; state: MemberState | null; removal: { id: string; at: number } | null } }
  | { status: 400 | 403 | 409; body: { error: string } };

/** One plain line of at most 120 characters, no control characters (spec §A). */
export function plainName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (v.length > NAME_MAX || /[\x00-\x1f\x7f]/.test(v) || HIDDEN_CHARS.test(v)) return null;
  return v.trim();
}

export function newMemberKeyPair(): { publicKey: string; privateKeyPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicKey: (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64url'), privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string };
}

/** Signs any object over the canonical JSON of its other fields (the same canonical form as records). */
export function signPayload<T extends object>(unsigned: T, privateKeyPem: string): T & { sig: string } {
  const sig = crypto.sign(null, Buffer.from(recordPayload(unsigned as never)), privateKeyPem).toString('base64url');
  return { ...unsigned, sig };
}

export function verifyPayload(signed: { sig?: unknown }, publicKey: string): boolean {
  try {
    if (typeof signed.sig !== 'string') return false;
    const key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(recordPayload(signed as never)), key, Buffer.from(signed.sig, 'base64url'));
  } catch { return false; } // @silent-fallback-ok — an unreadable key or signature is an invalid signature
}

const hashToken = (t: string): string => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')) as T; } catch { return fallback; } // @silent-fallback-ok — absent reads as empty
}
function writeAtomic(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The registries of one published organization. Callers serialize writes (one in-process queue). */
export class OrgMembers {
  constructor(private readonly stateDir: string, private readonly orgId: string, private readonly now: () => number = Date.now) {}

  private file(kind: 'members' | 'invites'): string { return path.join(this.stateDir, 'org', 'published', `${this.orgId}.${kind}.json`); }
  members(): Record<string, MemberEntry> { return readJson(this.file('members'), {}); }
  invites(): Record<string, InviteEntry> { return readJson(this.file('invites'), {}); }
  private saveMembers(m: Record<string, MemberEntry>): void { writeAtomic(this.file('members'), JSON.stringify(m)); }
  private saveInvites(i: Record<string, InviteEntry>): void { writeAtomic(this.file('invites'), JSON.stringify(i)); }

  /** A new invitation token (returned once; only its hash is kept). */
  mintInvite(): { token: string; id: string } {
    const token = crypto.randomBytes(16).toString('base64url');
    const id = hashToken(token);
    const inv = this.invites();
    inv[id] = { createdAt: this.now(), maxUses: INVITE_MAX_USES, usedBy: [], active: true };
    this.saveInvites(inv);
    return { token, id };
  }

  revokeInvite(id: string): boolean {
    const inv = this.invites();
    if (!inv[id]) return false;
    inv[id]!.revokedAt = this.now();
    this.saveInvites(inv);
    return true;
  }

  /** The publisher's own agent is a member without an invitation (spec §A). */
  registerSelf(memberKey: string, agentName: string, personName: string, version: number): void {
    const m = this.members();
    if (m[memberKey]) return;
    const t = this.now();
    m[memberKey] = { agentName, personName, appliedVersion: version, state: 'joined', firstSeen: t, lastSeen: t, lastAt: 0, checkins: 0 };
    this.saveMembers(m);
  }

  private tokenUsable(token: unknown, memberKey: string, inv: Record<string, InviteEntry>): string | null {
    if (typeof token !== 'string' || token.length > 64) return null;
    const id = hashToken(token);
    const e = inv[id];
    if (!e || !e.active || e.revokedAt) return null;
    if (!e.usedBy.includes(memberKey) && e.usedBy.length >= e.maxUses) return null;
    return id;
  }

  private joinedCount(m: Record<string, MemberEntry>): number { return Object.values(m).filter((e) => e.state === 'joined').length; }

  /** Drops one-off joined entries past 30 days, and left entries over their limit (spec §A retention). */
  private compact(m: Record<string, MemberEntry>): void {
    const t = this.now();
    for (const [k, e] of Object.entries(m)) if (e.state === 'joined' && e.checkins <= 1 && t - e.lastSeen > ONE_OFF_DROP_MS) delete m[k];
    const left = Object.entries(m).filter(([, e]) => e.state === 'left').sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (const [k] of left.slice(0, Math.max(0, left.length - LEFT_KEEP_MAX))) delete m[k];
  }

  /** `POST /org/checkin` (spec §A): verify, then apply the transition table. */
  checkin(raw: unknown): CheckinAnswer {
    const b = raw as Partial<CheckinBody> | null;
    if (!b || b.v !== 1 || typeof b.memberKey !== 'string' || typeof b.at !== 'number' || typeof b.appliedVersion !== 'number'
      || (b.state !== 'joined' && b.state !== 'left')) return { status: 400, body: { error: 'malformed' } };
    if (b.orgId !== this.orgId) return { status: 400, body: { error: 'unknown-org' } };
    const agentName = plainName(b.agentName); const personName = plainName(b.personName);
    if (agentName === null || personName === null) return { status: 400, body: { error: 'name-not-plain' } };
    const t = this.now();
    if (Math.abs(t - b.at) > CHECKIN_WINDOW_MS) return { status: 400, body: { error: 'stale' } };
    if (!verifyPayload(b, b.memberKey)) return { status: 403, body: { error: 'bad-signature' } };
    const m = this.members();
    const inv = this.invites();
    const e = m[b.memberKey];
    const answer = (entry: MemberEntry | null, enrolled: boolean): CheckinAnswer =>
      ({ status: 200, body: { ok: true, enrolled, state: entry?.state ?? null, removal: entry?.removal ?? null } });

    if (!e) {
      if (b.state === 'left') return answer(null, false);
      const tokenId = this.tokenUsable(b.inviteToken, b.memberKey, inv);
      if (!tokenId) return { status: 403, body: { error: 'invitation-needed' } };
      this.compact(m);
      if (this.joinedCount(m) >= MEMBERS_JOINED_MAX) return { status: 409, body: { error: 'member-limit' } };
      m[b.memberKey] = { agentName, personName, appliedVersion: b.appliedVersion, state: 'joined', firstSeen: t, lastSeen: t, lastAt: b.at, checkins: 1 };
      if (!inv[tokenId]!.usedBy.includes(b.memberKey)) inv[tokenId]!.usedBy.push(b.memberKey);
      this.saveInvites(inv);
      this.saveMembers(m);
      return answer(m[b.memberKey]!, true);
    }

    if (b.at <= e.lastAt) return answer(e, true); // a replay changes nothing
    e.agentName = agentName; e.personName = personName; e.appliedVersion = b.appliedVersion;
    e.lastSeen = t; e.lastAt = b.at; e.checkins += 1;
    if (e.state === 'joined' && b.state === 'left') { e.state = 'left'; e.leftAt = t; }
    else if (e.state === 'removed' && b.state === 'left') { e.leftAt = t; }
    else if (e.state === 'left' && b.rejoin === true) {
      const tokenId = this.tokenUsable(b.inviteToken, b.memberKey, inv);
      // A rejoin with a cancelled or used-up link is told so, and the member asks for a new link.
      if (!tokenId) { this.saveMembers(m); return { status: 403, body: { error: 'invitation-needed' } }; }
      {
        this.compact(m);
        if (this.joinedCount(m) >= MEMBERS_JOINED_MAX) { this.saveMembers(m); return { status: 409, body: { error: 'member-limit' } }; }
        e.state = 'joined'; delete e.leftAt;
        if (!inv[tokenId]!.usedBy.includes(b.memberKey)) { inv[tokenId]!.usedBy.push(b.memberKey); this.saveInvites(inv); }
      }
    }
    // removed → joined happens only through the admin's restore.
    this.saveMembers(m);
    return answer(e, true);
  }

  remove(memberKey: string): { ok: true; removal: { id: string; at: number } } | { ok: false; error: 'not-found' | 'too-many-removed' } {
    const m = this.members();
    const e = m[memberKey];
    if (!e) return { ok: false, error: 'not-found' };
    if (e.state !== 'removed' && Object.values(m).filter((x) => x.state === 'removed').length >= REMOVED_KEEP_MAX) return { ok: false, error: 'too-many-removed' };
    e.state = 'removed';
    e.removal = { id: crypto.randomBytes(8).toString('hex'), at: this.now() };
    this.saveMembers(m);
    return { ok: true, removal: e.removal };
  }

  restore(memberKey: string): { ok: true } | { ok: false; error: 'not-found' | 'not-removed' | 'member-limit' } {
    const m = this.members();
    const e = m[memberKey];
    if (!e) return { ok: false, error: 'not-found' };
    if (e.state !== 'removed') return { ok: false, error: 'not-removed' };
    this.compact(m);
    if (this.joinedCount(m) >= MEMBERS_JOINED_MAX) return { ok: false, error: 'member-limit' };
    e.state = 'joined'; delete e.removal; delete e.leftAt;
    this.saveMembers(m);
    return { ok: true };
  }

  /** The Work agents page (spec §B). Names are what each agent reports. */
  list(currentVersion: number): Array<{ memberKey: string; agentName: string; personName: string; appliedVersion: number; behind: boolean; quiet: boolean; state: MemberState; hasLeft: boolean; lastSeen: number }> {
    const t = this.now();
    return Object.entries(this.members())
      .map(([memberKey, e]) => ({
        memberKey, agentName: e.agentName, personName: e.personName, appliedVersion: e.appliedVersion,
        behind: e.state === 'joined' && e.appliedVersion < currentVersion, quiet: e.state === 'joined' && t - e.lastSeen > QUIET_MS,
        state: e.state, hasLeft: e.state === 'removed' && e.leftAt !== undefined, lastSeen: e.lastSeen,
      }))
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }
}
