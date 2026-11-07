/**
 * The events of the team access log (docs/specs/team-roles-and-access.md §3.3). Pure validation.
 * Request events are read only from a phone's signed body, so a bad one rejects the whole request.
 */
import type { GrantAccess } from '../permissions/TeamAccess.js';
import type { OrgRole } from '../permissions/types.js';
import { ORG_ROLES } from '../permissions/types.js';

export type RequestEvent =
  | { type: 'team-on' }
  | { type: 'team-off' }
  | { type: 'owner-pin'; personKey: string; links?: Record<string, string | number> }
  | { type: 'person-add'; personKey: string; name: string; role: OrgRole; relationship?: 'msp'; links?: Record<string, string | number> }
  | { type: 'person-set'; personKey: string; role: OrgRole }
  | { type: 'person-remove'; personKey: string }
  | { type: 'grant'; personKey: string; ref: string; access: GrantAccess }
  | { type: 'grant-remove'; personKey: string; ref: string };

export type MachineEvent =
  | { type: 'phone-bind'; keyHash: string; deviceId: string; boundTo: string }
  | { type: 'conversation-own'; ref: string; personKey: string }
  | { type: 'lower'; personKey: string; ref?: string; role?: OrgRole; remove?: boolean };

const MAX_EVENTS = 50;
const str = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

export function isGrantAccessEvent(v: unknown): v is GrantAccess {
  return v === 'read' || v === 'use';
}

/** The owner role is never given by an event: owner authority comes only from a pairing. */
function isGrantableRole(v: unknown): v is OrgRole {
  return typeof v === 'string' && v !== 'owner' && (ORG_ROLES as readonly string[]).includes(v);
}

function validLinks(v: unknown): v is Record<string, string | number> {
  if (v === undefined) return true;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.values(v).every((x) => typeof x === 'number' || str(x));
}

export function validateRequestEvent(raw: unknown): RequestEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  switch (e.type) {
    case 'team-on': return { type: 'team-on' };
    case 'team-off': return { type: 'team-off' };
    case 'owner-pin':
      if (!str(e.personKey) || !validLinks(e.links)) return null;
      return { type: 'owner-pin', personKey: e.personKey, ...(e.links ? { links: e.links as Record<string, string | number> } : {}) };
    case 'person-add':
      if (!str(e.personKey) || !str(e.name, 200) || !isGrantableRole(e.role) || !validLinks(e.links)) return null;
      if (e.relationship !== undefined && e.relationship !== 'msp') return null;
      return {
        type: 'person-add', personKey: e.personKey, name: e.name, role: e.role,
        ...(e.relationship ? { relationship: 'msp' as const } : {}),
        ...(e.links ? { links: e.links as Record<string, string | number> } : {}),
      };
    case 'person-set':
      if (!str(e.personKey) || !isGrantableRole(e.role)) return null;
      return { type: 'person-set', personKey: e.personKey, role: e.role };
    case 'person-remove':
      return str(e.personKey) ? { type: 'person-remove', personKey: e.personKey } : null;
    case 'grant':
      if (!str(e.personKey) || !str(e.ref) || !isGrantAccessEvent(e.access)) return null;
      return { type: 'grant', personKey: e.personKey, ref: e.ref, access: e.access };
    case 'grant-remove':
      return str(e.personKey) && str(e.ref) ? { type: 'grant-remove', personKey: e.personKey, ref: e.ref } : null;
    default: return null;
  }
}

/** The events of a signed body. One bad event voids the request: it is atomic. */
export function parseSignedEvents(body: unknown): RequestEvent[] | null {
  const raw = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_EVENTS) return null;
  const events: RequestEvent[] = [];
  for (const r of raw) {
    const e = validateRequestEvent(r);
    if (!e) return null;
    events.push(e);
  }
  return events;
}

export function validateMachineEvent(raw: unknown): MachineEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  switch (e.type) {
    case 'phone-bind':
      return str(e.keyHash) && str(e.deviceId) && str(e.boundTo) ? { type: 'phone-bind', keyHash: e.keyHash, deviceId: e.deviceId, boundTo: e.boundTo } : null;
    case 'conversation-own':
      return str(e.ref) && str(e.personKey) ? { type: 'conversation-own', ref: e.ref, personKey: e.personKey } : null;
    case 'lower':
      if (!str(e.personKey)) return null;
      if (e.ref !== undefined && !str(e.ref)) return null;
      if (e.role !== undefined && !isGrantableRole(e.role)) return null;
      if (e.remove !== undefined && typeof e.remove !== 'boolean') return null;
      return { type: 'lower', personKey: e.personKey, ...(e.ref ? { ref: e.ref as string } : {}), ...(e.role ? { role: e.role as OrgRole } : {}), ...(e.remove ? { remove: true } : {}) };
    default: return null;
  }
}
