/**
 * Instar Documents — who may do what with a document (spec §3.1–3.3, §3.6a).
 *
 * Pure. A document's audience is its primary conversation's audience; there are no per-document
 * grants. Every refusal maps to `404 unknown-document` at the route, so nobody can probe.
 * Deterministic by design (§6: invariant, irreversible-consequence): a disclosure to the wrong
 * person can't be taken back, so no model and no heuristic decides any of this.
 */
import type { ConversationRef } from './rows.js';

export type DocOp = 'read' | 'read-metadata' | 'comment' | 'reply' | 'send' | 'resolve-own' | 'resolve-any' | 'revise' | 'tombstone' | 'purge' | 'prune' | 'move' | 'link';

export type Principal =
  /** The owner on their phone (device-signed), or a browser approved through the owner's channel. */
  | { kind: 'owner-device'; client: 'phone' | 'browser'; approvedVia: string }
  /** A dashboard PIN session alone: the agent can read the PIN, so it is never proof of the owner. */
  | { kind: 'pin-session' }
  /** A team person on one of their own devices. A browser is `documents` or `documents-read` scoped. */
  | { kind: 'person'; personKey: string; tier: 'admin' | 'member' | 'guest'; client: 'phone' | 'browser'; scope?: 'documents' | 'documents-read' }
  /** A legacy msp phone: no conversation-derived standing on documents (§3.2). */
  | { kind: 'msp' }
  /** An agent session: its place, and whether it is owner-reach (unconfined). */
  | { kind: 'agent'; placeKey: string; ownerReach: boolean }
  /** The bearer token with no session: owner-reach. */
  | { kind: 'bearer' };

export interface DocFacts {
  primary: ConversationRef;
  /** `'owner'` or a personKey (§4.1). */
  ownerPerson: string;
  /** Has this document ever had a primary with a non-owner audience? Confined for good (§3.1). */
  everShared: boolean;
  tombstoned: boolean;
  purged: boolean;
}

/** What the team model answers about a conversation. Injected so this module stays pure. */
export interface TeamView {
  /** `mayUseConversation(person, ref, …, op)` for a team person. Never called for other kinds. */
  personMay(personKey: string, ref: ConversationRef, op: 'read' | 'send'): boolean;
  /** True when the conversation's audience is the owner alone (an owner-reach place). */
  ownerOnly(ref: ConversationRef): boolean;
  /** The place a session for this conversation resolves to (`placeOf`, §3.3). */
  placeOf(ref: ConversationRef): string;
  /** The team log's own refusal (gap, hold, privacy off): non-owners wait (§3.2 freshness). */
  teamRefusal(): string | null;
  /** Would a send by this person reach an owner-reach session (`sendReachesOwner`)? */
  sendReachesOwner(personKey: string, ref: ConversationRef): boolean;
}

export type Decision = { ok: true } | { ok: false; reason: string };
const yes: Decision = { ok: true };
const no = (reason: string): Decision => ({ ok: false, reason });

const WRITE_OPS: ReadonlySet<DocOp> = new Set(['comment', 'reply', 'send', 'resolve-own', 'resolve-any', 'revise', 'tombstone', 'purge', 'prune', 'move', 'link']);

export function mayDoDocument(p: Principal, doc: DocFacts, op: DocOp, team: TeamView): Decision {
  if (doc.purged) return op === 'read-metadata' && (p.kind === 'owner-device') ? yes : no('purged');
  if (doc.tombstoned && op !== 'read-metadata' && !(p.kind === 'owner-device')) return no('tombstoned');
  const ownerOnly = team.ownerOnly(doc.primary);

  switch (p.kind) {
    case 'owner-device': {
      // A browser approved with the PIN alone is no proof of the owner: it is a PIN session (§3.6).
      if (p.client === 'browser' && p.approvedVia === 'dashboard-pin') return mayDoDocument({ kind: 'pin-session' }, doc, op, team);
      if ((op === 'move' || op === 'purge' || op === 'prune' || op === 'tombstone') && p.client !== 'phone') return no('needs-owner-phone');
      return yes;
    }
    case 'pin-session': {
      if (op === 'read-metadata') return yes;
      if (op === 'read' && ownerOnly) return yes;
      return no('pin-session');
    }
    case 'msp':
      return no('msp-no-document-standing');
    case 'bearer':
    case 'agent': {
      const ownerReach = p.kind === 'bearer' || p.ownerReach;
      // The agent never moves, shares, deletes, purges, sends as a person, or resolves people's comments.
      if (op === 'move' || op === 'purge' || op === 'prune' || op === 'tombstone' || op === 'send' || op === 'resolve-own' || op === 'resolve-any') {
        return no('agent-cannot');
      }
      if (ownerReach) {
        // Owner-reach: metadata of every document; content only of never-shared owner-only ones (§3.1, §3.3).
        if (op === 'read-metadata') return yes;
        return ownerOnly && !doc.everShared ? yes : no('owner-reach-metadata-only');
      }
      // A confined session works only in documents whose primary is its own place: nothing else, not even metadata.
      if (p.kind === 'agent' && team.placeOf(doc.primary) === p.placeKey) return yes;
      return no('other-place');
    }
    case 'person': {
      if (p.scope === 'documents-read' && op !== 'read' && op !== 'read-metadata') return no('read-only-browser');
      if (op === 'move' || op === 'purge' || op === 'prune' || op === 'link') return no('owner-only-op');
      if (op === 'read-metadata' || op === 'read') {
        return team.personMay(p.personKey, doc.primary, 'read') ? yes : no('no-read');
      }
      if (!team.personMay(p.personKey, doc.primary, 'read')) return no('no-read');
      const refusal = team.teamRefusal();
      if (refusal) return no(refusal);
      if (p.tier === 'guest') return no('guest-read-only');
      if (op === 'revise' || op === 'tombstone' || op === 'resolve-any') return doc.ownerPerson === p.personKey ? yes : no('not-document-owner');
      if (op === 'comment' || op === 'reply' || op === 'send' || op === 'resolve-own') {
        if (!team.personMay(p.personKey, doc.primary, 'send')) return no('no-send');
        if (team.sendReachesOwner(p.personKey, doc.primary)) return no('read-only-owner-reach');
        return yes;
      }
      return no('unknown-op');
    }
    default:
      return no('unknown-principal');
  }
}
