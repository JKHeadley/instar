/**
 * MemoryAudience — who a session's memory may be shown to.
 *
 * Spec: docs/specs/memory-privacy.md. The audience is decided by the PLACE a
 * conversation happens in, not by who is speaking: a private chat serves one
 * person, and a shared place serves everyone who can read it. A person's own
 * private memory is therefore never loaded into a channel, even when that
 * person is the one asking there.
 *
 * Every function here is pure and deterministic. This is the privacy boundary,
 * so it fails closed: anything not positively recognised resolves to `none`,
 * which loads no memory at all.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { deriveRole } from '../permissions/SlackPrincipalResolver.js';
import type { UserProfile } from '../core/types.js';

export type MemoryAudience =
  /** Today's behaviour: nothing is scoped. */
  | { kind: 'open' }
  /** The agent's owner in a private place. */
  | { kind: 'owner'; userId: string }
  /** Another registered person in a private place. */
  | { kind: 'person'; userId: string }
  /** A shared place, or a private place whose sender is not registered. */
  | { kind: 'place'; placeKey: string }
  /** The scheduler, lifeline and agent-to-agent spawns: owner reach, no person. */
  | { kind: 'system' }
  /** Unknown, or an error. No memory at all. */
  | { kind: 'none' };

export type MemoryPlace =
  | { kind: 'private'; placeKey: string; personId: string | null }
  /** `soleReaderId` is set only on fresh proof that this person is the one human reader. */
  | { kind: 'shared'; placeKey: string; soleReaderId?: string | null }
  | { kind: 'system' }
  | { kind: 'unknown' };

export interface ResolveAudienceInput {
  multiPerson: boolean;
  ownerUserId: string | null;
  /** Required: there is deliberately no default that means "everything". */
  place: MemoryPlace;
}

export function resolveMemoryAudience(input: ResolveAudienceInput): MemoryAudience {
  const { place, ownerUserId, multiPerson } = input;
  if (place.kind === 'system') return multiPerson ? { kind: 'system' } : { kind: 'open' };
  if (place.kind === 'unknown') return multiPerson ? { kind: 'none' } : { kind: 'open' };
  if (!place.placeKey) return { kind: 'none' };

  if (place.kind === 'shared') {
    // A place with other readers is scoped even on a one-person agent.
    if (!place.soleReaderId) return { kind: 'place', placeKey: place.placeKey };
    return privateAudience(multiPerson, ownerUserId, place.placeKey, place.soleReaderId);
  }
  return privateAudience(multiPerson, ownerUserId, place.placeKey, place.personId);
}

function privateAudience(
  multiPerson: boolean,
  ownerUserId: string | null,
  placeKey: string,
  personId: string | null,
): MemoryAudience {
  if (!multiPerson) return { kind: 'open' };
  if (!personId) return { kind: 'place', placeKey };
  if (ownerUserId && personId === ownerUserId) return { kind: 'owner', userId: personId };
  return { kind: 'person', userId: personId };
}

export interface ReachablePeopleInput {
  users: Pick<UserProfile, 'id' | 'channels' | 'telegramUserId' | 'slackUserId'>[];
  slackAuthorizedIds?: readonly string[];
  slackBotUserId?: string | null;
  telegramAuthorizedIds?: readonly (number | string)[];
  whatsappAuthorizedNumbers?: readonly string[];
  imessageAuthorizedContacts?: readonly string[];
  /** `UserProfile.id`s of active phones with a non-owner role. */
  mspDeviceUserIds?: readonly string[];
  /** Senders seen at inbound that no configured list counts. */
  observedSenderKeys?: readonly string[];
  /**
   * `UserProfile.id`s of people the operator has named as sharing memory freely
   * (`memoryPrivacy.sharedMemoryPeople`). They count as one person, so an agent
   * reached only by them stays `open`. Anyone else reaching it makes it
   * multi-person again with no further setting.
   */
  sharedMemoryPeople?: readonly string[];
  /** Raw person keys recorded as one operator when this version first ran (see MemoryPrivacy.establishBaseline). */
  operatorKeys?: readonly string[];
}

/** Every raw key a profile answers to. */
export function profileKeys(u: Pick<UserProfile, 'channels' | 'telegramUserId' | 'slackUserId'>): string[] {
  return [
    ...(u.slackUserId ? [`slack:${u.slackUserId}`] : []),
    ...(u.telegramUserId != null ? [`telegram:${u.telegramUserId}`] : []),
    ...(u.channels ?? []).map((c) => (c.type === 'whatsapp' ? whatsappPersonKey(c.identifier) : `${c.type}:${c.identifier}`)),
  ];
}

/** One form for a WhatsApp person: config holds numbers, inbound holds JIDs. */
export function whatsappPersonKey(idOrJid: string): string {
  return `whatsapp:${idOrJid.split('@')[0].replace(/\D/g, '')}`;
}

/**
 * The keys of everyone reachable by configuration, and whether they show a second
 * person. Slack and Telegram ids belong to one human each, so two of them are two
 * people. iMessage and WhatsApp lists often hold one person's several handles, and
 * unlinked ids across platforms are usually one owner, so those alone prove nothing.
 */
export function baselineFromConfig(input: ReachablePeopleInput & { slackBotUnknown?: boolean }): { clearlySeveral: boolean; keys: string[] } {
  const distinct = (ids: readonly (string | number)[] | undefined, skip?: string | null) =>
    [...new Set((ids ?? []).map(String))].filter((id) => id !== skip);
  const slack = distinct(input.slackAuthorizedIds, input.slackBotUserId);
  const telegram = distinct(input.telegramAuthorizedIds);
  const reachableProfiles = input.users.filter((u) => u.slackUserId || u.telegramUserId != null || (u.channels ?? []).length > 0);
  const named = countReachablePeople({ ...input, operatorKeys: [], observedSenderKeys: [], whatsappAuthorizedNumbers: [], imessageAuthorizedContacts: [] });
  // An allowlist can hold the bot itself, so with its id unknown one Slack id may not be a person.
  const clearlySeveral = slack.length > (input.slackBotUnknown ? 2 : 1) || telegram.length > 1 || reachableProfiles.length > 1 || (input.mspDeviceUserIds?.length ?? 0) > 0
    || [input.whatsappAuthorizedNumbers, input.imessageAuthorizedContacts].some((l) => l?.includes('*')) || named === MANY_PEOPLE;
  return {
    clearlySeveral,
    keys: [
      ...reachableProfiles.map((u) => `user:${u.id}`),
      ...slack.map((id) => `slack:${id}`),
      ...telegram.map((id) => `telegram:${id}`),
      ...distinct(input.whatsappAuthorizedNumbers).map(whatsappPersonKey),
      ...distinct(input.imessageAuthorizedContacts).map((id) => `imessage:${id}`),
    ],
  };
}

/** Returned when an allowlist of `*` means anyone may send. */
export const MANY_PEOPLE = Number.POSITIVE_INFINITY;

/**
 * Count distinct humans who can send to the agent. Ids that resolve to one
 * profile count once. An id with no profile counts as its own person: two
 * unlinked ids on two platforms count as two, because compatibility cannot
 * prove identity and being wrong that way costs availability, not privacy.
 */
export function countReachablePeople(input: ReachablePeopleInput): number {
  const lists = [input.slackAuthorizedIds, input.telegramAuthorizedIds, input.whatsappAuthorizedNumbers, input.imessageAuthorizedContacts];
  if (lists.some((l) => l?.some((id) => String(id) === '*'))) return MANY_PEOPLE;

  const people = new Set<string>();
  const bySlack = new Map<string, string>();
  const byTelegram = new Map<string, string>();
  const byChannel = new Map<string, string>();
  for (const u of input.users) {
    if (u.slackUserId) bySlack.set(u.slackUserId, u.id);
    if (u.telegramUserId != null) byTelegram.set(String(u.telegramUserId), u.id);
    for (const c of u.channels ?? []) {
      if (c.type === 'slack') bySlack.set(c.identifier, u.id);
      byChannel.set(c.identifier, u.id);
    }
    if (u.slackUserId || u.telegramUserId != null || (u.channels ?? []).length > 0) people.add(`user:${u.id}`);
  }
  const add = (known: Map<string, string>, prefix: string, id: string) => {
    people.add(known.has(id) ? `user:${known.get(id)}` : `${prefix}:${id}`);
  };
  for (const id of input.slackAuthorizedIds ?? []) {
    if (id !== input.slackBotUserId) add(bySlack, 'slack', id);
  }
  for (const raw of input.telegramAuthorizedIds ?? []) add(byTelegram, 'telegram', String(raw));
  for (const id of input.whatsappAuthorizedNumbers ?? []) {
    people.add(byChannel.has(id) ? `user:${byChannel.get(id)}` : whatsappPersonKey(id));
  }
  for (const id of input.imessageAuthorizedContacts ?? []) add(byChannel, 'imessage', id);
  for (const id of input.mspDeviceUserIds ?? []) people.add(`user:${id}`);
  for (const key of input.observedSenderKeys ?? []) people.add(key);

  const operator = new Set(input.operatorKeys ?? []);
  // The operator is reachable whether or not a list still names them.
  for (const key of operator) people.add(key);
  // The operator registering themselves is still the operator: a profile carrying one
  // of their ids joins them rather than counting as someone new.
  const operatorProfiles = input.users.filter((u) => profileKeys(u).some((k) => operator.has(k))).map((u) => `user:${u.id}`);
  const circle = new Set([...(input.sharedMemoryPeople ?? []).map((id) => `user:${id}`), ...operator, ...operatorProfiles]);
  let count = 0;
  let circleCounted = false;
  for (const person of people) {
    if (!circle.has(person)) count += 1;
    else if (!circleCounted) { count += 1; circleCounted = true; }
  }
  return count;
}

export interface ResolveOwnerInput {
  configuredOwnerUserId?: string | null;
  telegramOwnerId?: number | null;
  users: Pick<UserProfile, 'id' | 'permissions' | 'orgRole' | 'telegramUserId'>[];
}

/** The owner, or null when none or several qualify. Null means legacy memory loads for nobody. */
export function resolveMemoryOwner(input: ResolveOwnerInput): string | null {
  if (input.configuredOwnerUserId) {
    return input.users.some((u) => u.id === input.configuredOwnerUserId) ? input.configuredOwnerUserId : null;
  }
  if (input.telegramOwnerId != null) {
    const match = input.users.find((u) => u.telegramUserId === input.telegramOwnerId);
    if (match) return match.id;
  }
  // An organization normally has several admins, so an owner role decides first.
  const withRole = (role: string) => input.users.filter((u) => deriveRole(u.permissions, u.orgRole) === role);
  const owners = withRole('owner');
  if (owners.length > 0) return owners.length === 1 ? owners[0].id : null;
  const admins = withRole('admin');
  return admins.length === 1 ? admins[0].id : null;
}

/** A filesystem-safe folder name for a scope. Ids are hashed, never trusted as paths. */
export function memoryScopeFolderName(audience: MemoryAudience): string | null {
  const digest = (v: string) => createHash('sha256').update(v).digest('hex').slice(0, 16);
  if (audience.kind === 'person') return `person-${digest(audience.userId)}`;
  if (audience.kind === 'place') return `place-${digest(audience.placeKey)}`;
  return null;
}

/**
 * The scope folder, deliberately OUTSIDE the agent home: a file-tool deny on a
 * parent beats any allow, so the agent home must be deniable with no exceptions.
 * Null means the audience keeps the existing folder (`open`, `owner`, `system`)
 * or gets a throwaway one (`none`).
 */
export function memoryScopeDir(instarRoot: string, agentId: string, audience: MemoryAudience): string | null {
  const name = memoryScopeFolderName(audience);
  return name ? path.join(instarRoot, 'memory-scopes', encodeURIComponent(agentId), name) : null;
}

/** True when a session with this audience runs inside the boundary. */
export function isScopedAudience(audience: MemoryAudience): boolean {
  return audience.kind === 'person' || audience.kind === 'place' || audience.kind === 'none';
}

/** The value of INSTAR_MEMORY_SCOPE; null for `open`, which sets nothing. */
export function memoryScopeEnvValue(audience: MemoryAudience): string | null {
  switch (audience.kind) {
    case 'open': return null;
    case 'owner': return 'owner';
    case 'system': return 'system';
    case 'none': return 'none';
    default: return memoryScopeFolderName(audience);
  }
}

/** Who spoke on WhatsApp. In a group the chat id is the group's, and the adapter names the speaker. */
export function whatsappSpeakerJid(metadata: Record<string, unknown> | undefined, chatJid: string): string {
  const participant = metadata?.participant;
  return typeof participant === 'string' && participant ? participant : chatJid;
}
