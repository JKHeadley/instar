/**
 * People and roles for paired phones (docs/specs/mobile-app-people-and-roles.md).
 *
 * Each paired phone belongs to one person from the agent's existing user registry
 * (`UserManager`, "Know Your Principal") and has a role with this agent: `owner` or `msp`.
 * A device record with neither field is the owner's phone (every phone paired before this
 * change was approved by the owner alone as the owner's phone), so absent fields mean owner.
 *
 * Pure: the registry is read through the small `PeopleLookup` interface, which `UserManager`
 * satisfies structurally.
 */
import { deriveRole } from '../permissions/SlackPrincipalResolver.js';

export type AppRole = 'owner' | 'msp';
export const APP_ROLES: readonly AppRole[] = ['owner', 'msp'];

/** The registry fields this module reads (UserManager's `UserProfile` satisfies it). */
export interface PersonProfile {
  id: string;
  name: string;
  permissions?: string[];
  orgRole?: string;
  telegramUserId?: number;
  slackUserId?: string;
}

export interface PeopleLookup {
  getUser(userId: string): PersonProfile | null;
}

/** Who the agent's owner is, from configuration and the Telegram adapter. */
export interface OwnerIdentity {
  /** `threadline.ownerName`, already cleaned; empty when unset. */
  ownerName: string;
  /** The Telegram owner's numeric id, when the agent has one. */
  telegramOwnerId: number | null;
  /** The owner's Slack user id (`mobilePairing.slackOwnerUserId`), when set. */
  slackOwnerUserId?: string | null;
}

/** The person a phone belongs to, resolved for one request. */
/** What the owner opened to an MSP person (§3.5); always all-false for an owner phone. */
export interface PersonGrants { ownerConversations: boolean; slack: boolean }

export type DevicePerson =
  | { ok: true; role: AppRole; userId: string | null; name: string; telegramUserId: number | null; slackUserId?: string | null; grants?: PersonGrants }
  | { ok: false; reason: 'person-unknown'; role: AppRole; userId: string | null };

/** The fields of a device record this module reads. */
export interface DevicePersonFields { userId?: string; role?: AppRole }

export function isAppRole(x: unknown): x is AppRole {
  return typeof x === 'string' && (APP_ROLES as readonly string[]).includes(x);
}

/** Is this registered person the agent's owner? */
export function isOwnerProfile(p: PersonProfile, owner: OwnerIdentity): boolean {
  if (owner.telegramOwnerId !== null && p.telegramUserId === owner.telegramOwnerId) return true;
  // The owner's Slack identity is the owner's too: a profile carrying it can never be an MSP.
  if (owner.slackOwnerUserId && p.slackUserId === owner.slackOwnerUserId) return true;
  return deriveRole(p.permissions ?? [], p.orgRole) === 'owner';
}

function ownerDisplayName(owner: OwnerIdentity): string {
  return owner.ownerName || 'Operator';
}

/**
 * Resolve a device to its person. Absent role ⇒ owner. An MSP phone whose person is no longer in
 * the registry is `person-unknown` — never the owner (spec §3.1).
 */
export function devicePerson(d: DevicePersonFields, people: PeopleLookup | null, owner: OwnerIdentity, grantsFor?: (userId: string) => PersonGrants): DevicePerson {
  const userId = typeof d.userId === 'string' && d.userId.length > 0 ? d.userId : null;
  // A role this build does not know (a newer build wrote it) fails closed: never the owner.
  if (d.role !== undefined && !isAppRole(d.role)) return { ok: false, reason: 'person-unknown', role: 'msp', userId };
  const role: AppRole = d.role ?? 'owner';
  if (role === 'owner') {
    const profile = userId && people ? people.getUser(userId) : null;
    return { ok: true, role, userId, name: profile?.name || ownerDisplayName(owner), telegramUserId: owner.telegramOwnerId };
  }
  const profile = userId && people ? people.getUser(userId) : null;
  if (!profile) return { ok: false, reason: 'person-unknown', role, userId };
  return {
    ok: true, role, userId, name: profile.name || profile.id, telegramUserId: typeof profile.telegramUserId === 'number' ? profile.telegramUserId : null,
    slackUserId: typeof profile.slackUserId === 'string' && profile.slackUserId ? profile.slackUserId : null,
    grants: grantsFor ? grantsFor(profile.id) : { ownerConversations: false, slack: false },
  };
}

export type PersonChoice =
  | { ok: true; userId: string | null; role: AppRole; name: string }
  | { ok: false; error: 'bad-role' | 'bad-person'; detail: string };

/**
 * Validate a requested `{ userId, role }` for a pairing link or a reassignment (spec §3.2).
 * Neither field ⇒ the owner. A userId alone ⇒ owner if that person is the owner, else msp. `msp` needs a registered person who is not the owner; `owner` with a
 * userId needs that person to be the owner.
 */
export function choosePerson(userIdRaw: unknown, roleRaw: unknown, people: PeopleLookup | null, owner: OwnerIdentity): PersonChoice {
  if (roleRaw !== undefined && roleRaw !== null && !isAppRole(roleRaw)) {
    return { ok: false, error: 'bad-role', detail: 'role must be "owner" or "msp".' };
  }
  if (userIdRaw !== undefined && userIdRaw !== null && (typeof userIdRaw !== 'string' || userIdRaw.length === 0 || userIdRaw.length > 128)) {
    return { ok: false, error: 'bad-person', detail: 'userId must be the id of a person in this agent\'s user list.' };
  }
  const userId = typeof userIdRaw === 'string' ? userIdRaw : null;
  if (!userId) {
    const role: AppRole = isAppRole(roleRaw) ? roleRaw : 'owner';
    if (role === 'msp') return { ok: false, error: 'bad-person', detail: 'An MSP phone needs the userId of a person in this agent\'s user list (instar user add).' };
    return { ok: true, userId: null, role, name: ownerDisplayName(owner) };
  }
  const profile = people?.getUser(userId) ?? null;
  if (!profile) return { ok: false, error: 'bad-person', detail: `No person with id "${userId}" is in this agent's user list.` };
  const isOwner = isOwnerProfile(profile, owner);
  // A userId with no role takes the person's own standing: the owner's phone, else an MSP phone.
  const role: AppRole = isAppRole(roleRaw) ? roleRaw : (isOwner ? 'owner' : 'msp');
  if (role === 'msp' && isOwner) return { ok: false, error: 'bad-person', detail: `${profile.name} is this agent's owner, so their phone is an owner phone.` };
  if (role === 'owner' && !isOwner) return { ok: false, error: 'bad-person', detail: `${profile.name} is not this agent's owner.` };
  return { ok: true, userId, role, name: profile.name || profile.id };
}

/** "Justin (MSP)" for an MSP phone; just the name for the owner's. */
export function personLabel(name: string, role: AppRole): string {
  return role === 'msp' ? `${name} (MSP)` : name;
}

/** A phone whose person resolved (the request principal carries this). */
export type ResolvedPerson = Extract<DevicePerson, { ok: true }>;

/**
 * Who owns an app conversation (`CreatedEvent.ownerPerson`), namespaced by the machine whose
 * registry the userId belongs to: registry ids are local to each machine, so a bare id could
 * name different people on different machines. Absent ⇒ the owner's conversation.
 */
export interface ConversationOwner { machineId: string; userId: string }

export function validConversationOwner(raw: unknown): ConversationOwner | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const ok = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256;
  return ok(r.machineId) && ok(r.userId) ? { machineId: r.machineId, userId: r.userId } : null;
}

/** The stored owner of a conversation an MSP phone creates; null for an owner phone. */
export function conversationOwnerFor(person: ResolvedPerson, machineId: string): ConversationOwner | null {
  return person.role === 'msp' && person.userId ? { machineId, userId: person.userId } : null;
}

const APP_KEY = /^(?:app:)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * The one shared conversation check (spec §3.4). `ref` is a conversation reference in any device
 * route's form: `<uuid>` / `app:<uuid>`, `slack:…`, `telegram:<topicId>`.
 * - owner phone: always yes;
 * - MSP phone: Telegram yes; Slack only with the owner's `slack` grant; an app conversation when it
 *   is theirs (same machine namespace, same userId), or an OWNER conversation with the owner's
 *   `ownerConversations` grant; another MSP's, an unknown conversation or any other form: no.
 */
export function mayUseConversation(
  person: ResolvedPerson,
  ref: string,
  machineId: string,
  appOwner: ((key: string) => ConversationOwner | null | undefined) | null,
): boolean {
  if (person.role === 'owner') return true;
  if (/^telegram:-?[0-9]{1,20}$/.test(ref)) return true;
  if (ref.startsWith('slack:')) return person.grants?.slack === true;
  const m = APP_KEY.exec(ref);
  if (!m || !appOwner || !person.userId) return false;
  const owner = appOwner(m[1]);
  if (owner === undefined) return false; // no such conversation
  if (owner === null) return person.grants?.ownerConversations === true; // the owner's own
  return owner.machineId === machineId && owner.userId === person.userId;
}
