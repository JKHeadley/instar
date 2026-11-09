/**
 * ReachablePeople — who can reach this agent, whatever the memory privacy setting.
 *
 * Spec: docs/specs/team-roles-and-access.md §3.10. Memory privacy's own count does nothing when
 * privacy is off, which is exactly when an owner most needs to know a second person can reach the
 * agent. So this keeps its own small record. It feeds nothing in memory privacy, never flips
 * multi-person, and holds no authority: it answers "who?" and raises one notice.
 *
 * State: `state/reachable-people.json` (atomic write). Machine-local operational state: each
 * machine sees only the inbound it served, and `GET /team/people?scope=pool` is the whole view.
 */
import fs from 'node:fs';
import path from 'node:path';
import { deriveRole } from '../permissions/SlackPrincipalResolver.js';
import type { UserProfile } from '../core/types.js';
import { normalizeIdentifier } from '../messaging/imessage/normalize-phone.js';
import {
  baselineFromConfig, countReachablePeople, MANY_PEOPLE, profileKeys, whatsappPersonKey, type ReachablePeopleInput,
} from './MemoryAudience.js';

export type PersonTier = 'owner' | 'admin' | 'member' | 'guest' | 'unknown';

export interface PersonReach { via: string; detail: string }

export interface PersonRow {
  key: string;
  name: string;
  tier: PersonTier;
  relationship?: 'msp';
  reach: PersonReach[];
  sees: string;
  warnings: string[];
}

export interface ReachNotice { conditionKey: string; title: string; text: string; count: number }

export interface PhoneFact { userId: string | null; role: 'owner' | 'msp' | 'team'; name: string; deviceName: string }

type ReachableLists = Omit<ReachablePeopleInput, 'users' | 'observedSenderKeys' | 'operatorKeys' | 'sharedMemoryPeople'>;

export interface ReachablePeopleDeps {
  stateDir: string;
  users: () => UserProfile[];
  reachable: () => ReachableLists & { telegramOwnerId?: number | null };
  sharedMemoryPeople: () => readonly string[];
  privacyOn: () => boolean;
  ownerUserId: () => string | null;
  ownerName: () => string;
  phones: () => PhoneFact[];
  now?: () => number;
}

interface PersistedState {
  /** Ids recorded as one person when this first ran (one owner with several handles). */
  operatorKeys: string[];
  baselineDone: boolean;
  observedSenders: string[];
  /** The count last raised to the owner. A re-raise reopens an item, so the hold lives here. */
  lastRaisedCount: number;
  /** The one-time "are these both you?" question has been asked. */
  askedBothYou: boolean;
}

const MAX_OBSERVED = 500;
/** JSON has no Infinity: a count of "anyone" is stored as this. */
const HELD_AT_ANYONE = -1;

/** One form for a key, however the config or the channel wrote it. */
function canonicalKey(key: string): string {
  if (key.startsWith('whatsapp:')) return whatsappPersonKey(key.slice(9));
  if (key.startsWith('imessage:')) return `imessage:${normalizeIdentifier(key.slice(9))}`;
  return key;
}

const emptyState = (): PersistedState => ({ operatorKeys: [], baselineDone: false, observedSenders: [], lastRaisedCount: 0, askedBothYou: false });

/** Raise only for more than one person and more than the count already raised. */
export function reachNoticeDue(count: number, heldAt: number): boolean {
  return count > 1 && count > heldAt;
}

/** The display tier of an org role. One mapping, read by every surface. */
export function tierOfRole(role: string): Exclude<PersonTier, 'unknown'> {
  if (role === 'owner') return 'owner';
  if (role === 'admin') return 'admin';
  if (role === 'guest') return 'guest';
  return 'member';
}

export class ReachablePeople {
  private state: PersistedState;
  private readonly file: string;
  /** Told when a sender is new, so the notice need not wait for its next pass. Must not throw. */
  onNewSender: (() => void) | null = null;

  constructor(private readonly deps: ReachablePeopleDeps) {
    this.file = path.join(deps.stateDir, 'state', 'reachable-people.json');
    this.state = this.load();
  }

  private load(): PersistedState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<PersistedState>;
      const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
      return {
        operatorKeys: strings(raw.operatorKeys),
        baselineDone: raw.baselineDone === true,
        observedSenders: strings(raw.observedSenders).slice(-MAX_OBSERVED),
        lastRaisedCount: typeof raw.lastRaisedCount === 'number' && raw.lastRaisedCount >= HELD_AT_ANYONE ? raw.lastRaisedCount : 0,
        askedBothYou: raw.askedBothYou === true,
      };
    } catch {
      // @silent-fallback-ok — no file yet is normal; a damaged one starts over, and the only cost is a recount.
      return emptyState();
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      // A failed write loses a sender until the next one arrives. It never affects a message.
      console.warn(`[reachable-people] could not save: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * First run: unless the configuration clearly shows a second person, every id the agent already
   * has is one person, so one owner with several handles is not called two people.
   */
  private ensureBaseline(): void {
    if (this.state.baselineDone) return;
    const base = baselineFromConfig({ users: this.deps.users(), ...this.lists() });
    this.state.operatorKeys = base.clearlySeveral ? [] : base.keys.map(canonicalKey);
    this.state.baselineDone = true;
    this.save();
  }

  private lists(): ReachableLists {
    const { telegramOwnerId: _owner, ...lists } = this.deps.reachable();
    return { ...lists, imessageAuthorizedContacts: lists.imessageAuthorizedContacts?.map((id) => normalizeIdentifier(id)) };
  }

  /** The owner's own keys: the baseline, plus the Telegram owner id, which Telegram vouches for. */
  private operatorKeys(): string[] {
    const owner = this.deps.reachable().telegramOwnerId;
    const keys = owner != null ? [...new Set([...this.state.operatorKeys, `telegram:${owner}`])] : [...this.state.operatorKeys];
    // An owner who reaches the agent only by phone is in no list, and still counts as one person.
    if (keys.length === 0 && !this.hasListedIds() && this.deps.phones().some((p) => p.role === 'owner')) keys.push('app:owner');
    return keys;
  }

  private hasListedIds(): boolean {
    const l = this.deps.reachable();
    return [l.slackAuthorizedIds, l.telegramAuthorizedIds, l.whatsappAuthorizedNumbers, l.imessageAuthorizedContacts].some((x) => (x?.length ?? 0) > 0);
  }

  /** Record a verified sender. `user:<id>` when resolved, else `<platform>:<id>`. */
  observeSender(rawKey: string | null | undefined): void {
    if (!rawKey) return;
    const senderKey = canonicalKey(rawKey);
    this.ensureBaseline();
    if (this.state.observedSenders.includes(senderKey) || this.operatorKeys().includes(senderKey)) return;
    const platform = senderKey.split(':')[0];
    // The first sender on a platform with no list at baseline is the owner arriving there.
    if (platform !== 'user' && this.state.operatorKeys.length > 0 && !this.operatorKeys().some((k) => k.startsWith(`${platform}:`))) {
      this.state.operatorKeys.push(senderKey);
      this.save();
      return;
    }
    this.state.observedSenders = [...this.state.observedSenders, senderKey].slice(-MAX_OBSERVED);
    this.save();
    this.onNewSender?.();
  }

  /** What this machine has seen, for the pool union. */
  observedKeys(): string[] {
    return [...this.state.observedSenders];
  }

  /** How many people can reach the agent. `Infinity` when an allowlist is open to anyone. */
  count(peerObservedKeys: readonly string[] = []): number {
    this.ensureBaseline();
    const operator = this.operatorKeys();
    // Never below one: an agent with nothing configured yet still has its owner.
    return Math.max(1, countReachablePeople({
      ...this.lists(),
      users: this.deps.users(),
      observedSenderKeys: [...new Set([...this.state.observedSenders, ...peerObservedKeys.map(canonicalKey)])].filter((k) => !operator.includes(k)),
      operatorKeys: operator,
      sharedMemoryPeople: this.deps.sharedMemoryPeople(),
    }));
  }

  /**
   * The warning to raise now, or null. Held at the count last raised, so marking the item done
   * lasts until someone new appears. Counts only: an MSP phone can read this item.
   */
  warning(peerObservedKeys: readonly string[] = []): ReachNotice | null {
    if (this.deps.privacyOn()) return null;
    const n = this.count(peerObservedKeys);
    if (!reachNoticeDue(n, this.heldAt())) return null;
    const who = n === MANY_PEOPLE ? 'Anyone' : `${n} people`;
    return {
      conditionKey: 'team:second-person', count: n,
      title: 'A second person can reach this agent',
      text: `${who} can reach this agent, and memory privacy is off, so what one person tells it can reach another. Say "turn on memory privacy" to change this, or mark this as fine.`,
    };
  }

  private heldAt(): number {
    return this.state.lastRaisedCount === HELD_AT_ANYONE ? MANY_PEOPLE : this.state.lastRaisedCount;
  }

  /** The item is on record: hold until the count goes up. */
  noteRaised(count: number): void {
    this.state.lastRaisedCount = Number.isFinite(count) ? count : HELD_AT_ANYONE;
    this.save();
  }

  /** What this machine has raised, so a lease move does not reopen an item another machine raised. */
  hold(): { lastRaisedCount: number; askedBothYou: boolean } {
    return { lastRaisedCount: this.state.lastRaisedCount, askedBothYou: this.state.askedBothYou };
  }

  /** Take on a peer's hold, keeping the higher. */
  adoptHold(peer: { lastRaisedCount?: unknown; askedBothYou?: unknown }): void {
    const n = peer.lastRaisedCount;
    const higher = typeof n === 'number' && (n === HELD_AT_ANYONE || n > this.heldAt()) && this.state.lastRaisedCount !== HELD_AT_ANYONE;
    const asked = peer.askedBothYou === true && !this.state.askedBothYou;
    if (higher) this.state.lastRaisedCount = n as number;
    if (asked) this.state.askedBothYou = true;
    if (higher || asked) this.save();
  }

  /**
   * Once per agent: the baseline folded a Slack id and a Telegram id into one person, and each of
   * those is normally one human. iMessage and WhatsApp handles are not asked about.
   */
  bothYouQuestion(): ReachNotice | null {
    this.ensureBaseline();
    if (this.state.askedBothYou || this.deps.privacyOn()) return null;
    const keys = this.operatorKeys();
    if (!keys.some((k) => k.startsWith('slack:')) || !keys.some((k) => k.startsWith('telegram:'))) return null;
    // No ids here: an MSP phone can read this item. People shows them to the owner.
    return {
      conditionKey: 'team:both-you', count: 2,
      title: 'Are these both you?',
      text: 'This agent treats a Slack account and a Telegram account as one person. If they are different people, say "turn on memory privacy". If they are both you, mark this as fine.',
    };
  }

  noteAskedBothYou(): void {
    this.state.askedBothYou = true;
    this.save();
  }

  /** True when the Telegram group has no allowlist, so anyone in it can message the agent. */
  telegramOpenToGroup(): boolean {
    const l = this.deps.reachable();
    return l.telegramOwnerId != null && (l.telegramAuthorizedIds ?? []).length === 0;
  }

  /** One row per person. Pure read of the current facts. */
  rows(): PersonRow[] {
    this.ensureBaseline();
    const users = this.deps.users();
    const lists = this.deps.reachable();
    const privacyOn = this.deps.privacyOn();
    const ownerId = this.deps.ownerUserId();
    const rows = new Map<string, PersonRow>();
    const operator = new Set(this.operatorKeys());
    const row = (key: string, name: string, tier: PersonTier): PersonRow => {
      let r = rows.get(key);
      if (!r) { r = { key, name, tier, reach: [], sees: '', warnings: [] }; rows.set(key, r); }
      return r;
    };
    const owner = row('owner', this.deps.ownerName() || 'Owner', 'owner');

    const profileByKey = new Map<string, UserProfile>();
    for (const u of users) for (const k of profileKeys(u)) profileByKey.set(k, u);

    for (const u of users) {
      const isOwner = u.id === ownerId || deriveRole(u.permissions ?? [], u.orgRole) === 'owner'
        || (lists.telegramOwnerId != null && u.telegramUserId === lists.telegramOwnerId)
        || profileKeys(u).some((k) => operator.has(k));
      const r = isOwner ? owner : row(`user:${u.id}`, u.name || u.id, tierOfRole(deriveRole(u.permissions ?? [], u.orgRole)));
      if (u.telegramUserId != null) r.reach.push({ via: 'telegram', detail: 'Telegram' });
      if (u.slackUserId) r.reach.push({ via: 'slack', detail: 'Slack' });
      for (const c of u.channels ?? []) {
        if (c.type !== 'telegram' && c.type !== 'slack') r.reach.push({ via: c.type, detail: c.type });
      }
    }

    const listed = (via: string, label: string, prefix: string, ids: readonly (string | number)[] | undefined, skip?: string | null) => {
      for (const raw of ids ?? []) {
        const id = String(raw);
        if (id === skip) continue;
        if (id === '*') {
          row(`${prefix}:*`, `Anyone on ${label}`, 'unknown').reach.push({ via, detail: `${label}, open to anyone` });
          continue;
        }
        const key = canonicalKey(`${prefix}:${id}`);
        if (profileByKey.has(key)) continue;
        const r = operator.has(key) ? owner : row(key, `Someone on ${label} (${id})`, 'unknown');
        r.reach.push({ via, detail: label });
      }
    };
    listed('slack', 'Slack', 'slack', lists.slackAuthorizedIds, lists.slackBotUserId);
    listed('telegram', 'Telegram', 'telegram', lists.telegramAuthorizedIds);
    listed('whatsapp', 'WhatsApp', 'whatsapp', lists.whatsappAuthorizedNumbers);
    listed('imessage', 'iMessage', 'imessage', lists.imessageAuthorizedContacts);

    for (const p of this.deps.phones()) {
      if (p.role === 'owner') { owner.reach.push({ via: 'phone', detail: `Phone: ${p.deviceName}` }); continue; }
      const r = row(`user:${p.userId ?? p.name}`, p.name, p.role === 'msp' ? 'admin' : 'member');
      if (p.role === 'msp') { r.tier = 'admin'; r.relationship = 'msp'; }
      r.reach.push({ via: 'phone', detail: `Phone: ${p.deviceName}` });
    }

    for (const key of this.state.observedSenders) {
      if (operator.has(key) || rows.has(key)) continue;
      if (key.startsWith('user:')) {
        // A registered person already has a row, or is folded into the owner's.
        if (!users.some((u) => `user:${u.id}` === key)) row(key, key.slice(5), 'unknown').reach.push({ via: 'message', detail: 'Sent a message' });
        continue;
      }
      if (profileByKey.has(key)) continue;
      const [platform, ...rest] = key.split(':');
      row(key, `Someone on ${platform} (${rest.join(':')})`, 'unknown').reach.push({ via: platform, detail: 'Sent a message' });
    }

    for (const r of rows.values()) {
      const seen = new Set<string>();
      r.reach = r.reach.filter((x) => { const k = `${x.via}|${x.detail}`; if (seen.has(k)) return false; seen.add(k); return true; });
      r.sees = seesFor(r);
      if (r.tier === 'owner' && this.state.operatorKeys.length > 1) {
        r.warnings.push(`Treated as you: ${this.state.operatorKeys.map(plainKey).join(', ')}.`);
      }
      if (r.tier !== 'owner') {
        if (r.relationship === 'msp' && !privacyOn) r.warnings.push(`${r.name}'s chats run with the agent's full reach.`);
        else if (!privacyOn) r.warnings.push('Memory privacy is off, so what they tell the agent can reach others, and the other way round.');
      }
    }
    return [...rows.values()].sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || a.name.localeCompare(b.name));
  }
}

function plainKey(key: string): string {
  const [platform, ...rest] = key.split(':');
  const label: Record<string, string> = { slack: 'Slack', telegram: 'Telegram', whatsapp: 'WhatsApp', imessage: 'iMessage', user: 'Profile' };
  return `${label[platform] ?? platform} ${rest.join(':')}`;
}

const TIER_ORDER: PersonTier[] = ['owner', 'admin', 'member', 'guest', 'unknown'];

function seesFor(r: PersonRow): string {
  if (r.tier === 'owner') return 'Everything.';
  if (r.relationship === 'msp') return 'All Telegram topics, sessions and alerts, and their own app chats.';
  if (r.reach.some((x) => x.via === 'phone')) return 'Only the conversations you gave them, and their own.';
  const parts: string[] = [];
  if (r.reach.some((x) => x.via === 'telegram')) parts.push('every topic in the Telegram group');
  if (r.reach.some((x) => x.via === 'slack')) parts.push('Slack channels they are in');
  if (r.reach.some((x) => x.via === 'whatsapp' || x.via === 'imessage')) parts.push('their own chats');
  if (parts.length === 0) return 'What they send and what the agent replies.';
  const text = parts.join(', and ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}
