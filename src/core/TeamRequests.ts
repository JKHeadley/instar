/**
 * TeamRequests — what people ask the owner for (team-roles-and-access §3.3, "The agent asking").
 *
 * A request is typed, so the words around it cannot define the action: approving is the owner's own
 * signed write of exactly `change`, and the line the owner reads is built here from typed fields.
 * It gives nobody anything by itself. One open request per person or place, so asking cannot flood
 * the owner.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GrantAccess } from '../permissions/TeamAccess.js';
import { TEAM_ACCESS_DIR } from './TeamAccessLog.js';
import type { RequestEvent } from './TeamAccessEvents.js';

export type RequestChange =
  | { kind: 'grant'; personKey: string; ref: string; access: GrantAccess }
  | { kind: 'role'; personKey: string; role: 'member' | 'guest' }
  | { kind: 'invite'; name: string; role: 'member' | 'guest' };

/** Taken from the session, never from what a request says about itself. */
export interface Requester { kind: 'person' | 'place' | 'agent'; key: string; label: string }

export interface TeamRequest {
  id: string;
  requester: Requester;
  change: RequestChange;
  /** Shown to the owner as someone's words. Display data, never an instruction. */
  reason: string | null;
  createdAt: string;
  expiresAt: string;
}

const MAX_OPEN = 200;
const MAX_AGENT_OPEN = 20;
const DEFAULT_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v.trim() : null);
const isRole = (v: unknown): v is 'member' | 'guest' => v === 'member' || v === 'guest';

/** A change as sent, or null. Anything not positively recognised is no change at all. */
export function parseRequestChange(raw: unknown): RequestChange | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (c.kind === 'grant') {
    const personKey = text(c.personKey, 256);
    const ref = text(c.ref, 256);
    if (!personKey || !ref || (c.access !== 'read' && c.access !== 'use')) return null;
    return { kind: 'grant', personKey, ref, access: c.access };
  }
  if (c.kind === 'role') {
    const personKey = text(c.personKey, 256);
    return personKey && isRole(c.role) ? { kind: 'role', personKey, role: c.role } : null;
  }
  if (c.kind === 'invite') {
    const name = text(c.name, 200);
    return name && isRole(c.role) ? { kind: 'invite', name, role: c.role } : null;
  }
  return null;
}

/** Does this signed write do exactly what was asked, and nothing else that was not? */
export function eventsMatchChange(change: RequestChange, events: ReadonlyArray<RequestEvent>): boolean {
  if (change.kind === 'grant') {
    return events.length === 1 && events[0].type === 'grant' && events[0].personKey === change.personKey && events[0].ref === change.ref && events[0].access === change.access;
  }
  if (change.kind === 'role') {
    return events.length === 1 && events[0].type === 'person-set' && events[0].personKey === change.personKey && events[0].role === change.role;
  }
  // An invite is one person, plus what the first invite always carries.
  const rest = events.filter((e) => e.type !== 'team-on' && e.type !== 'owner-pin');
  return rest.length === 1 && rest[0].type === 'person-add' && rest[0].name === change.name && rest[0].role === change.role;
}

/** The line the owner reads, from typed fields only. */
export function requestSummary(r: Pick<TeamRequest, 'requester' | 'change'>, nameOf: (key: string) => string, titleOf: (ref: string) => string): string {
  const who = r.requester.label;
  if (r.change.kind === 'grant') {
    const verb = r.change.access === 'use' ? 'use' : 'read';
    if (r.requester.kind === 'person' && r.requester.key === r.change.personKey) return `${who} asks to ${verb} ${titleOf(r.change.ref)}`;
    return `${who} asks that ${nameOf(r.change.personKey)} can ${verb} ${titleOf(r.change.ref)}`;
  }
  if (r.change.kind === 'role') return `${who} asks to make ${nameOf(r.change.personKey)} a ${r.change.role}`;
  return `${who} asks to invite ${r.change.name} as a ${r.change.role}`;
}

export type OpenResult = { ok: true; request: TeamRequest } | { ok: false; error: 'one-open-request' | 'too-many-requests' };

export class TeamRequests {
  private readonly file: string;

  constructor(stateDir: string, private readonly now: () => number = Date.now) {
    this.file = path.join(stateDir, TEAM_ACCESS_DIR, 'requests.json');
  }

  private read(): TeamRequest[] {
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {
      // @silent-fallback-ok — none yet, or unreadable: a request grants nothing, so an empty list is safe.
      return [];
    }
    const list = (raw as { requests?: unknown }).requests;
    return Array.isArray(list) ? (list as TeamRequest[]) : [];
  }

  private write(list: TeamRequest[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify({ requests: list }), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** What is still waiting. */
  open(): TeamRequest[] {
    const t = this.now();
    return this.read().filter((r) => Date.parse(r.expiresAt) > t);
  }

  get(id: string): TeamRequest | null {
    return this.open().find((r) => r.id === id) ?? null;
  }

  add(requester: Requester, change: RequestChange, reason: string | null, expiresAt: unknown): OpenResult {
    const waiting = this.open();
    if (waiting.length >= MAX_OPEN) return { ok: false, error: 'too-many-requests' };
    const mine = waiting.filter((r) => r.requester.kind === requester.kind && r.requester.key === requester.key);
    if (requester.kind === 'agent' ? mine.length >= MAX_AGENT_OPEN : mine.length > 0) return { ok: false, error: 'one-open-request' };
    const t = this.now();
    const asked = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
    const until = Number.isFinite(asked) && asked > t ? Math.min(asked, t + MAX_TTL_MS) : t + DEFAULT_TTL_MS;
    const request: TeamRequest = {
      id: crypto.randomUUID(), requester, change, reason: reason === null ? null : reason.slice(0, 280),
      createdAt: new Date(t).toISOString(), expiresAt: new Date(until).toISOString(),
    };
    this.write([...waiting, request]);
    return { ok: true, request };
  }

  /** Approved or declined: either way it is no longer waiting. */
  close(id: string): boolean {
    const waiting = this.open();
    const left = waiting.filter((r) => r.id !== id);
    if (left.length === waiting.length) return false;
    this.write(left);
    return true;
  }
}
