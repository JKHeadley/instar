/**
 * MemoryPrivacy — the running state behind the audience decision.
 * Spec: docs/specs/memory-privacy.md.
 *
 * `MemoryAudience.ts` holds the pure rules. This class holds what they need
 * from the live agent: who can reach it, what places exist, and the tokens of
 * sessions inside the boundary. State lives in `state/memory-privacy.json`.
 */

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { UserProfile } from '../core/types.js';
import {
  baselineFromConfig, countReachablePeople, memoryScopeDir, profileKeys, resolveMemoryAudience, resolveMemoryOwner,
  isScopedAudience, type MemoryAudience, type MemoryPlace,
} from './MemoryAudience.js';

/** How long proof that a place has one reader stays usable. Inbound re-checks every message. */
export const READER_PROOF_MS = 5 * 60_000;

/** Stands for the baseline operator on an agent with no profile for them. */
export const OPERATOR_PERSON_ID = 'operator';

export interface MemoryPrivacyConfig {
  enabled?: boolean;
  ownerUserId?: string;
  sharedMemoryPeople?: string[];
  privateGroups?: string[];
}

export interface ReachableLists {
  slackAuthorizedIds?: readonly string[];
  slackBotUserId?: string | null;
  telegramAuthorizedIds?: readonly (number | string)[];
  whatsappAuthorizedNumbers?: readonly string[];
  imessageAuthorizedContacts?: readonly string[];
  mspDeviceUserIds?: readonly string[];
  telegramOwnerId?: number | null;
}

export interface MemoryPrivacyDeps {
  stateDir: string;
  /** `~/.instar`: the parent of the scope folders. */
  instarRoot: string;
  agentId: string;
  config: () => MemoryPrivacyConfig;
  users: () => UserProfile[];
  reachable: () => ReachableLists;
  /** The Telegram group's place key, confirmed at baseline on a one-person agent. */
  telegramGroupKey?: () => string | null;
  now?: () => number;
}

/** How a session reaches its place; only one is normally set. */
export interface SessionPlaceInput {
  telegramTopicId?: number;
  slackChannelId?: string;
  /** Places with no topic or channel argument: WhatsApp, iMessage, app conversations. */
  memoryPlaceKey?: string;
  /** Set by callers that are not a conversation: jobs, the dashboard, agent-to-agent. */
  memoryPlace?: MemoryPlace;
}

export interface SessionTokenRecord {
  sessionId: string;
  audience: MemoryAudience;
  placeKey: string | null;
}

interface PersistedState {
  multiPerson: boolean;
  observedSenders: string[];
  /** Groups set at update time on a one-person agent; a growing member count removes the entry. */
  confirmedPrivateGroups: string[];
  groupBaselines: Record<string, number>;
  /**
   * Set once, at the first boot of this version. On an agent showing no second
   * person, every id it already had counts as one operator. Most existing agents
   * have no profiles and unlinked ids, so without this they would all read as
   * several people and lose their memory on update.
   */
  baselineDone: boolean;
  /** Senders seen before the baseline could run. */
  pendingSenders: string[];
  /** True when baseline found one operator, even with no id for them yet. */
  baselineSingle: boolean;
  operatorKeys: string[];
  /** Set once sessions were retired after the flip, whatever caused it. */
  flipHandled: boolean;
  /** Groups already considered once, so a lost confirmation is not restored at the next boot. */
  reviewedGroups: string[];
  places: Record<string, { kind: 'private' | 'shared'; personId: string | null }>;
  /** Audience last used per place; a change means an old transcript must not resume. */
  lastAudience: Record<string, string>;
  /** sha256 of a session token → its record. Survives restarts: a running session's env cannot change. */
  tokens: Record<string, SessionTokenRecord>;
}

const emptyState = (): PersistedState => ({ multiPerson: false, observedSenders: [], confirmedPrivateGroups: [], groupBaselines: {}, baselineDone: false, pendingSenders: [], baselineSingle: false, operatorKeys: [], flipHandled: false, reviewedGroups: [], places: {}, lastAudience: {}, tokens: {} });
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
export const audienceKey = (a: MemoryAudience): string => {
  switch (a.kind) {
    case 'owner': case 'person': return `${a.kind}:${a.userId}`;
    case 'place': return `place:${a.placeKey}`;
    default: return a.kind;
  }
};

export class MemoryPrivacy {
  private state: PersistedState;
  private readonly file: string;
  private readonly now: () => number;
  /** place key → sole reader proof; memory only, because stale proof must not survive a restart. */
  private readerProof = new Map<string, { personId: string; at: number }>();

  constructor(private readonly deps: MemoryPrivacyDeps) {
    this.file = path.join(deps.stateDir, 'state', 'memory-privacy.json');
    this.now = deps.now ?? Date.now;
    this.state = this.load();
  }

  get enabled(): boolean {
    return this.deps.config().enabled !== false;
  }

  private load(): PersistedState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<PersistedState>;
      return { ...emptyState(), ...raw };
    } catch {
      // @silent-fallback-ok — no file yet is the normal first run. An unreadable file
      // also lands here; multi-person is recomputed from the live lists on every read.
      return emptyState();
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /**
   * Once only. A later person is never added, so someone new always counts. Waits
   * for the Slack bot id: an allowlist can hold the bot, which is not a person.
   */
  establishBaseline(opts?: { force?: boolean }): void {
    if (this.state.baselineDone) return;
    const r = this.deps.reachable();
    const botUnknown = (r.slackAuthorizedIds?.length ?? 0) > 0 && !r.slackBotUserId;
    if (botUnknown && !opts?.force) return;
    // Forced with the bot id still unknown, two Slack ids count as two people: wrongly
    // merging two real people would be permanent, and wrongly splitting costs only memory.
    const { clearlySeveral, keys } = baselineFromConfig({ users: this.deps.users(), ...r });
    this.state.baselineDone = true;
    const pending = this.state.pendingSenders;
    this.state.pendingSenders = [];
    if (!clearlySeveral) {
      this.state.baselineSingle = true;
      this.state.operatorKeys = [...keys, ...(r.telegramOwnerId != null ? [`telegram:${r.telegramOwnerId}`] : [])];
    }
    this.save();
    // Senders seen while waiting get the same treatment they would have had after it.
    for (const sender of pending) this.observeSender(sender);
    const group = this.deps.telegramGroupKey?.() ?? null;
    if (group) this.confirmExistingGroup(group);
  }

  /** True when this sender is the operator recorded at baseline. */
  isOperator(senderKey: string | null): boolean {
    if (senderKey === null) return false;
    if (this.state.operatorKeys.includes(senderKey)) return true;
    if (!senderKey.startsWith('user:')) return false;
    const profile = this.deps.users().find((u) => `user:${u.id}` === senderKey);
    return profile ? profileKeys(profile).some((k) => this.state.operatorKeys.includes(k)) : false;
  }

  /**
   * True exactly once after the agent becomes multi-person, whether a message, a
   * config change or a registration did it, so running sessions are retired once.
   */
  takeFlip(): boolean {
    if (this.state.flipHandled || !this.isMultiPerson()) return false;
    this.state.flipHandled = true;
    this.save();
    return true;
  }

  /** Someone other than the operator spoke in a place: it has a second reader, proven. */
  dropGroupConfirmation(placeKey: string): boolean {
    if (!this.state.confirmedPrivateGroups.includes(placeKey)) return false;
    this.state.confirmedPrivateGroups = this.state.confirmedPrivateGroups.filter((k) => k !== placeKey);
    this.save();
    return true;
  }

  /** Who can send to the agent. A sticky flip: once more than one, it stays so. */
  isMultiPerson(): boolean {
    if (!this.enabled) return false;
    let many: boolean;
    try {
      this.establishBaseline();
      if (this.state.multiPerson) return !this.coveredBySharedPeople();
      // Until the bot id is known there is no baseline to count against, so only
      // what clearly shows a second person counts, and nothing is recorded as a flip.
      if (!this.state.baselineDone) {
        // People the operator named count as one here too; the bot may be one extra id.
        if (this.deps.config().sharedMemoryPeople?.length) return this.reachableCount() > 2;
        return baselineFromConfig({ users: this.deps.users(), ...this.deps.reachable(), slackBotUnknown: true }).clearlySeveral;
      }
      many = this.reachableCount() > 1;
    } catch {
      // A first-ever detection error counts as multi-person: the cost is availability.
      // @silent-fallback-ok — reported by the caller's audience decision log.
      return true;
    }
    if (many) { this.state.multiPerson = true; this.save(); }
    return many;
  }

  /** The operator can name people after a flip; that is the only way back to `open`. */
  private coveredBySharedPeople(): boolean {
    if (!(this.deps.config().sharedMemoryPeople?.length)) return false;
    try { return this.reachableCount() <= 1; } catch { return false; }
  }

  private reachableCount(): number {
    const r = this.deps.reachable();
    return countReachablePeople({
      users: this.deps.users(),
      slackAuthorizedIds: r.slackAuthorizedIds,
      slackBotUserId: r.slackBotUserId,
      telegramAuthorizedIds: r.telegramAuthorizedIds,
      whatsappAuthorizedNumbers: r.whatsappAuthorizedNumbers,
      imessageAuthorizedContacts: r.imessageAuthorizedContacts,
      mspDeviceUserIds: r.mspDeviceUserIds,
      observedSenderKeys: this.state.observedSenders,
      sharedMemoryPeople: this.deps.config().sharedMemoryPeople,
      operatorKeys: this.state.operatorKeys,
    });
  }

  ownerUserId(): string | null {
    const owner = resolveMemoryOwner({
      configuredOwnerUserId: this.deps.config().ownerUserId ?? null,
      telegramOwnerId: this.deps.reachable().telegramOwnerId ?? null,
      users: this.deps.users(),
    });
    return owner ?? (this.state.baselineSingle ? OPERATOR_PERSON_ID : null);
  }

  /**
   * Record a verified sender at inbound, before routing. `senderKey` is the
   * profile (`user:<id>`) when resolved, else `<platform>:<id>`. Returns true when
   * this sender just made the agent multi-person, so the caller can retire
   * sessions before the message is delivered.
   */
  observeSender(senderKey: string): boolean {
    if (!this.enabled) return false;
    this.establishBaseline();
    if (!this.state.baselineDone) {
      if (!this.state.pendingSenders.includes(senderKey)) { this.state.pendingSenders.push(senderKey); this.save(); }
      return false;
    }
    if (this.state.observedSenders.includes(senderKey) || this.isOperator(senderKey)) return false;
    // The first sender on a platform with no allowlist at baseline is the operator
    // arriving there: an empty Telegram allowlist has no id to record in advance.
    const platform = senderKey.split(':')[0];
    if (platform !== 'user' && this.state.baselineSingle && !this.state.operatorKeys.some((k) => k.startsWith(`${platform}:`)) && !this.state.multiPerson) {
      this.state.operatorKeys.push(senderKey);
      this.save();
      return false;
    }
    const before = this.isMultiPerson();
    this.state.observedSenders.push(senderKey);
    this.save();
    return !before && this.isMultiPerson();
  }

  /** Record a conversation's place at inbound. */
  recordPlace(placeKey: string, kind: 'private' | 'shared', personId: string | null): void {
    const prev = this.state.places[placeKey];
    if (prev?.kind === kind && prev.personId === personId) return;
    this.state.places[placeKey] = { kind, personId };
    this.save();
  }

  /**
   * Fresh proof that `personId` is a shared place's one human reader. Null clears it.
   * Returns true when the place stopped being private, so sessions must be rechecked.
   */
  recordSoleReader(placeKey: string, personId: string | null): boolean {
    const hadProof = this.readerProof.has(placeKey);
    if (personId) {
      this.readerProof.set(placeKey, { personId, at: this.now() });
      return false;
    }
    this.readerProof.delete(placeKey);
    return hadProof;
  }

  /**
   * A confirmed group keeps its confirmation only while its count does not grow.
   * Other bots cannot be told from people, so the count at the first message after
   * confirmation is the baseline. Returns true when the confirmation was just lost.
   */
  groupGainedReaders(placeKey: string, count: number | null): boolean {
    if (!this.state.confirmedPrivateGroups.includes(placeKey) || count === null) return false;
    const baseline = this.state.groupBaselines[placeKey];
    if (baseline === undefined) {
      this.state.groupBaselines[placeKey] = count;
      this.save();
      return false;
    }
    if (count <= baseline) return false;
    this.state.confirmedPrivateGroups = this.state.confirmedPrivateGroups.filter((k) => k !== placeKey);
    this.save();
    return true;
  }

  /**
   * The update path, on a one-person agent: that agent's existing group keeps
   * behaving as it does today. Other bots in a group cannot be told from people, so
   * without this a real owner would lose their memory on update.
   */
  confirmExistingGroup(placeKey: string): void {
    if (this.state.reviewedGroups.includes(placeKey)) return;
    this.state.reviewedGroups.push(placeKey);
    if (!this.isMultiPerson()) this.state.confirmedPrivateGroups.push(placeKey);
    this.save();
  }

  private soleReader(placeKey: string): string | null {
    if (this.deps.config().privateGroups?.includes(placeKey) || this.state.confirmedPrivateGroups.includes(placeKey)) {
      return this.ownerUserId() ?? 'sole-reader';
    }
    const proof = this.readerProof.get(placeKey);
    return proof && this.now() - proof.at < READER_PROOF_MS ? proof.personId : null;
  }

  /** The place a session serves. Nothing recognised means `unknown`, which fails closed. */
  placeFor(input: SessionPlaceInput, telegramGroupKey: string | null): MemoryPlace {
    if (input.memoryPlace) return input.memoryPlace;
    const key = input.memoryPlaceKey
      ?? (input.slackChannelId ? `slack:${input.slackChannelId}` : null)
      ?? (input.telegramTopicId !== undefined ? telegramGroupKey : null);
    if (!key) return { kind: 'unknown' };
    const known = this.state.places[key];
    if (known?.kind === 'private') return { kind: 'private', placeKey: key, personId: known.personId };
    return { kind: 'shared', placeKey: key, soleReaderId: this.soleReader(key) };
  }

  audienceFor(place: MemoryPlace): MemoryAudience {
    if (!this.enabled) return { kind: 'open' };
    return resolveMemoryAudience({ multiPerson: this.isMultiPerson(), ownerUserId: this.ownerUserId(), place });
  }

  /** The scope folder for an audience, created private. Null keeps the existing folder. */
  ensureScopeDir(audience: MemoryAudience, sessionSuffix: string): string | null {
    const dir = audience.kind === 'none'
      ? path.join(this.deps.instarRoot, 'memory-scopes', encodeURIComponent(this.deps.agentId), `none-${sessionSuffix}`)
      : memoryScopeDir(this.deps.instarRoot, this.deps.agentId, audience);
    if (!dir) return null;
    for (const sub of ['', 'inbox', 'tmp']) fs.mkdirSync(path.join(dir, sub), { recursive: true, mode: 0o700 });
    return dir;
  }

  /**
   * True when a resume must be dropped: the old transcript was read by a different
   * audience, or predates this feature on a scoped session. Records the audience.
   */
  audienceChanged(placeKey: string | null, audience: MemoryAudience): boolean {
    if (!placeKey) return isScopedAudience(audience);
    const key = audienceKey(audience);
    const prev = this.state.lastAudience[placeKey];
    if (prev !== key) { this.state.lastAudience[placeKey] = key; this.save(); }
    if (prev === undefined) return audience.kind !== 'open';
    return prev !== key;
  }

  issueSessionToken(sessionId: string, audience: MemoryAudience, placeKey: string | null): string {
    const token = `mps_${randomBytes(32).toString('base64url')}`;
    this.state.tokens[hashToken(token)] = { sessionId, audience, placeKey };
    this.save();
    return token;
  }

  /** The record for a session token, or null when it is not one. */
  sessionForToken(token: string): SessionTokenRecord | null {
    if (!token.startsWith('mps_')) return null;
    return this.state.tokens[hashToken(token)] ?? null;
  }

  revokeSessionTokens(sessionId: string): void {
    let changed = false;
    for (const [hash, record] of Object.entries(this.state.tokens)) {
      if (record.sessionId === sessionId) { delete this.state.tokens[hash]; changed = true; }
    }
    if (changed) this.save();
  }
}
