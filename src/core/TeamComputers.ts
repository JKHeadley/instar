/**
 * Joined computers as every machine sees them (docs/specs/member-browser-any-computer.md §3.4, §3.5).
 *
 * Pure reads over the folded team log. A joined computer is a `computer-bind` row; its home, its end
 * and the limits that applied are worked out here from replicated, machine-signed rows only, so every
 * machine reaches the same answer from the same rows, whatever order they arrived in:
 *
 *   - home:   the signer of the newest valid `computer-bind` / `computer-adopt` for that key, by signed time
 *   - end:    the bind's `expiresAt`, moved forward only by renews the home signed before the end they extend,
 *             never past the bind's own `endsBy`
 *   - limits: the newest `computer-limits` row by signed time; a person's own row wins over the agent-wide one
 *
 * Rows a machine wrote past the owner's `origin-gone` cut for its stream are ignored, so an old, revoked
 * machine identity can never take over as home or move an end.
 *
 * Nothing here decides access on its own: callers add the key ledger's revocation check (not in the log).
 */
import type { TeamAccessState, ComputerRowEvent } from './TeamAccessLog.js';
import type { ComputerBindEvent } from './TeamAccessEvents.js';
import { mergeDefaults } from './mergeDefaults.js';

const DAY_MS = 86_400_000;

/** The defaults when no limits row exists: the instar-document-viewer §3.6a constants (§3.5). */
export const COMPUTER_LIMIT_DEFAULTS = Object.freeze({ maxPerPerson: 3, maxNewPerHour: 4, idleDays: 30, maxDays: 90 });
export type ComputerLimits = { maxPerPerson: number; maxNewPerHour: number; idleDays: number; maxDays: number };

type Link = ComputerBindEvent & { unbound?: true; signer: string; at: string };

/** Was this row written past the owner's `origin-gone` cut for its stream? Such rows never widen anything. */
function voided(state: TeamAccessState, r: Pick<ComputerRowEvent, 'origin' | 'incarnation' | 'seq'>): boolean {
  return (state.goneCuts ?? []).some((g) => g.machine === r.origin && g.incarnation === r.incarnation && r.seq > g.throughSeq);
}

/** Signed time first, then the row hash, so two machines order the same rows the same way. */
function byTime(a: { at: string; hash?: string }, b: { at: string; hash?: string }): number {
  const d = Date.parse(a.at) - Date.parse(b.at);
  if (d) return d;
  return (a.hash ?? '') < (b.hash ?? '') ? -1 : (a.hash ?? '') > (b.hash ?? '') ? 1 : 0;
}

function adoptsOf(state: TeamAccessState, link: Link): ComputerRowEvent[] {
  return (state.computerRows ?? [])
    .filter((r) => r.event.type === 'computer-adopt' && r.event.keyHash === link.keyHash && r.event.host === link.host && !voided(state, r))
    .sort(byTime);
}

/** The machine that was this computer's home at a moment (default: the newest signer of all). */
export function computerHomeAt(state: TeamAccessState, keyHash: string, atMs = Number.POSITIVE_INFINITY): string | null {
  const link = state.computerLinks?.get(keyHash);
  if (!link) return null;
  let home: string | null = Date.parse(link.at) <= atMs ? link.signer : null;
  for (const a of adoptsOf(state, link)) if (Date.parse(a.at) <= atMs) home = a.signer;
  return home;
}

/**
 * The computer's end as of a moment. Each renew counts only if the home at its signed time signed it,
 * its signed time is before the end it extends, and it moves the end forward but not past `endsBy`.
 */
export function computerExpiresAt(state: TeamAccessState, keyHash: string, asOfMs = Number.POSITIVE_INFINITY): number | null {
  const link = state.computerLinks?.get(keyHash);
  if (!link) return null;
  let end = Date.parse(link.expiresAt);
  const cap = Date.parse(link.endsBy);
  const renews = (state.computerRows ?? [])
    .filter((r) => r.event.type === 'computer-renew' && r.event.keyHash === keyHash && !voided(state, r))
    .sort(byTime);
  for (const r of renews) {
    const at = Date.parse(r.at);
    if (at > asOfMs) break;
    if (at >= end) continue; // signed after the end it would extend: the computer had already ended
    if (r.signer !== computerHomeAt(state, keyHash, at)) continue;
    const next = Date.parse((r.event as { expiresAt: string }).expiresAt);
    if (next > end && next <= cap) end = next;
  }
  return end;
}

/** The limits for one person: their own newest row, else the newest agent-wide row, else the defaults. */
export function computerLimitsFor(state: TeamAccessState, personKey: string | null): ComputerLimits {
  const rows = (state.computerRows ?? []).filter((r) => r.event.type === 'computer-limits' && !voided(state, r)).sort(byTime);
  let wide: Partial<ComputerLimits> = {};
  let own: Partial<ComputerLimits> | null = null;
  for (const r of rows) {
    const e = r.event as { personKey?: string } & Partial<ComputerLimits>;
    const values: Partial<ComputerLimits> = {};
    for (const k of ['maxPerPerson', 'maxNewPerHour', 'idleDays', 'maxDays'] as const) if (e[k] !== undefined) values[k] = e[k];
    if (!e.personKey) wide = values;
    else if (e.personKey === personKey) own = Object.keys(values).length ? values : null; // an empty person row clears theirs
  }
  const out: ComputerLimits = mergeDefaults<ComputerLimits>({ ...COMPUTER_LIMIT_DEFAULTS }, wide, own);
  if (out.maxDays < out.idleDays) out.maxDays = out.idleDays;
  return out;
}

export interface ComputerStanding {
  keyHash: string; deviceId: string; personKey: string; host: string; browserPublicKey: string;
  scope: 'documents' | 'documents-read'; home: string | null; expiresAt: number; linkedAt: string;
}

/**
 * Does this joined computer count, now or as of a moment? Not unbound, its person on the team, and
 * before its end. The key ledger's revocation check is the caller's (it isn't in the team log).
 */
export function computerStandingIn(state: TeamAccessState, keyHash: string, atMs: number): ComputerStanding | null {
  const link = state.computerLinks?.get(keyHash);
  if (!link || link.unbound || !state.people.has(link.boundTo)) return null;
  const end = computerExpiresAt(state, keyHash, atMs);
  if (end === null || atMs >= end || Date.parse(link.linkedAt) > atMs + 60_000) return null;
  return {
    keyHash, deviceId: link.deviceId, personKey: link.boundTo, host: link.host, browserPublicKey: link.browserPublicKey,
    scope: link.scope, home: computerHomeAt(state, keyHash), expiresAt: end, linkedAt: link.linkedAt,
  };
}

/**
 * The addresses where a computer of either kind is set up and still counts (SEC-169): each standing
 * joined computer's `host`, and each live phone-linked computer's own `host` (from its signed body). Lowercase host names,
 * port kept. The public way-back list (§3.6) names only these, never every machine in the pool: a
 * computer's key lives only on the address it was set up on, so no other address is ever a way back.
 */
export function computerHomeHosts(state: TeamAccessState, nowMs: number): Set<string> {
  const out = new Set<string>();
  for (const l of state.computerLinks?.values() ?? []) {
    const s = computerStandingIn(state, l.keyHash, nowMs);
    if (s && typeof s.host === 'string' && s.host) out.add(s.host.toLowerCase());
  }
  for (const l of state.browserLinks.values()) {
    if (l.unbound || !state.people.has(l.boundTo) || !(Date.parse(l.expiresAt) > nowMs)) continue;
    const h = linkedBrowserHost(l.signed?.bodyB64);
    if (h) out.add(h);
  }
  return out;
}

/**
 * The computer's own address from a phone link's signed body (`host`, which the linking machine checked
 * equals the address it issued the computer's nonce on). `signed.host` is the address the PHONE used,
 * which can differ. Undefined for anything unreadable: the list is display only, so it is just shorter.
 */
function linkedBrowserHost(bodyB64: unknown): string | undefined {
  if (typeof bodyB64 !== 'string' || bodyB64.length > 2048) return undefined;
  try {
    const host = (JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8')) as { host?: unknown }).host;
    return typeof host === 'string' && /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/i.test(host) ? host.toLowerCase() : undefined;
  } catch {
    // @silent-fallback-ok — display only: an unreadable row just leaves its address off the list.
    return undefined;
  }
}

/**
 * A person's computers of both kinds, for the allowance (§3.5): the live ones, and every one bound in
 * the last hour (forgotten ones included, so forgetting and re-adding can't beat the hourly count).
 */
export function computersOf(state: TeamAccessState, personKey: string, nowMs: number): { live: number; lastHour: number } {
  let live = 0, lastHour = 0;
  for (const l of state.browserLinks.values()) {
    if (l.boundTo !== personKey) continue;
    if (nowMs - Date.parse(l.linkedAt) < 3_600_000) lastHour++;
    if (!l.unbound && Date.parse(l.expiresAt) > nowMs) live++;
  }
  for (const l of state.computerLinks?.values() ?? []) {
    if (l.boundTo !== personKey) continue;
    if (nowMs - Date.parse(l.linkedAt) < 3_600_000) lastHour++;
    if (computerStandingIn(state, l.keyHash, nowMs)) live++;
  }
  return { live, lastHour };
}

/** When the home should write a renew (§3.5): once a quarter of the idle window has passed since the last. */
export function renewDue(state: TeamAccessState, keyHash: string, nowMs: number): { due: boolean; expiresAt: string } | null {
  const link = state.computerLinks?.get(keyHash);
  const end = computerExpiresAt(state, keyHash, nowMs);
  if (!link || end === null || nowMs >= end) return null;
  const next = Math.min(nowMs + link.idleDays * DAY_MS, Date.parse(link.endsBy));
  const due = end - nowMs < 0.75 * link.idleDays * DAY_MS && next > end;
  return { due, expiresAt: new Date(next).toISOString() };
}
