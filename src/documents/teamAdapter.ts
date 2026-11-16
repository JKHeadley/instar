/**
 * Instar Documents — the bridge to the team model (spec §3.2, §3.4 standing, §6).
 *
 * `teamView` answers the questions access.ts asks, from the live team log. `standingCheck`
 * re-checks a received row's standing against the immutable team rows its `access` vector names,
 * so every machine reaches the same answer whatever order the team rows arrived in: the vector
 * selects a prefix of the team log, that prefix is folded, and the person's standing on the
 * document's primary conversation is read from it. A vector naming team rows this machine doesn't
 * hold yet means "pending", re-checked when the team log advances.
 */
import { foldRows, type TeamAccessRow, type TeamAccessState } from '../core/TeamAccessLog.js';
import { mayDoAsTeam, tierOfRole } from '../permissions/TeamAccess.js';
import type { OrgRole } from '../permissions/types.js';
import { placeMatches } from '../server/memorySessionGuard.js';
import { topicPlaceKey } from '../users/TeamConfinement.js';
import type { TeamView } from './access.js';
import { foldDocument } from './fold.js';
import type { DocRow, Vector } from './rows.js';

/** What the documents bridge needs from the pairing service (kept narrow so it can be faked). */
export interface TeamDeps {
  /** The live log's rows and verifier, or null when there is no team log. */
  rows(): ReadonlyArray<TeamAccessRow> | null;
  verify(row: TeamAccessRow): 'verified' | 'unknown' | 'failed';
  /** The live folded state's answers. */
  personMay(personKey: string, ref: string, op: 'read' | 'send'): boolean;
  isConfined(ref: string): boolean | null;
  teamOn(): boolean;
  teamRefusal(): string | null;
  /** A person's own app conversation, decided from its record (§3.2: never from which machine checks). */
  ownsConversation(personKey: string, ref: string): boolean;
  /** Owner-only: no grant to anyone and not a team person's own conversation. */
  ownerOnly(ref: string): boolean;
}

export function teamView(deps: TeamDeps): TeamView {
  return {
    personMay: (k, ref, op) => deps.personMay(k, ref, op),
    ownerOnly: (ref) => deps.ownerOnly(ref),
    sessionInPlace: (placeKey, ref) => {
      // A shared Telegram topic is its own place; only that topic's session is in it (spec §3.3).
      // An unshared topic belongs to the group's place. memorySessionGuard's reply rule is looser
      // (a group session may reply into any topic) and is NOT the documents rule.
      if (ref.startsWith('telegram:')) {
        const shared = deps.isConfined(ref) === true;
        if (shared) return placeKey === topicPlaceKey(ref);
        return placeKey.startsWith('telegram:') && !placeKey.startsWith('telegram:topic:');
      }
      return placeMatches(ref, placeKey);
    },
    teamRefusal: () => deps.teamRefusal(),
    sendReachesOwner: (k, ref) => {
      if (!deps.teamOn()) return false;
      if (deps.ownsConversation(k, ref)) return false;
      return deps.isConfined(ref.replace(/^app:/, '')) !== true && deps.isConfined(ref) !== true;
    },
  };
}

const streamKey = (r: TeamAccessRow): string => `${r.origin ?? r.machineSig.machineId}/${r.incarnation ?? 'v1'}`;

/** The team state as a vector saw it: fold the prefix of the log the vector names. */
export function teamStateAt(rows: ReadonlyArray<TeamAccessRow>, vector: Vector, verify: TeamDeps['verify']): TeamAccessState | 'pending' {
  const held: Record<string, number> = {};
  for (const r of rows) held[streamKey(r)] = Math.max(held[streamKey(r)] ?? 0, r.seq);
  for (const [stream, seq] of Object.entries(vector)) if ((held[stream] ?? 0) < seq) return 'pending';
  const prefix = rows.filter((r) => (vector[streamKey(r)] ?? 0) >= r.seq);
  return foldRows(prefix, verify);
}

/**
 * The store's standing re-check. Agent, machine and owner-phone rows rest on their signatures
 * (the accepting machine checked the session's place; the owner phone's device signature is
 * checked by the signature verifier); person rows are re-decided here from the team prefix.
 */
export function standingCheck(deps: TeamDeps, docRows: (docId: string) => ReadonlyArray<DocRow>) {
  return (row: DocRow): 'ok' | 'denied' | 'pending' => {
    if (row.actor.type !== 'person') return 'ok';
    const teamRows = deps.rows();
    if (!teamRows) return 'pending';
    const state = teamStateAt(teamRows, row.access, deps.verify);
    if (state === 'pending') return 'pending';
    const p = state.people.get(row.actor.personKey);
    if (!state.on || !p) return 'denied';
    const tier = tierOfRole(p.role as OrgRole);
    if (tier === 'owner') return 'denied';
    // The primary in force when the row was decided.
    const primary = primaryAt(docRows(row.docId), row);
    if (!primary) return 'pending';
    const ref = primary.replace(/^app:/, '');
    const own = state.owned.get(ref) === row.actor.personKey || state.owned.get(primary) === row.actor.personKey;
    const grant = state.grants.get(row.actor.personKey)?.get(primary) ?? state.grants.get(row.actor.personKey)?.get(ref) ?? null;
    // Every person write needs the right to speak in the place (guests are refused: read-only).
    const op = 'send' as const;
    return mayDoAsTeam(tier, op, { own, grant: grant as never }) ? 'ok' : 'denied';
  };
}

function primaryAt(rows: ReadonlyArray<DocRow>, row: DocRow): string | null {
  if (row.eventKind === 'created') return row.primary;
  if (!row.primaryRow) return null;
  const at = rows.find((r) => `${r.origin}/${r.incarnation}#${r.seq}` === row.primaryRow);
  if (!at) return null;
  if (at.eventKind === 'created' || at.eventKind === 'primary-set') return at.primary;
  return foldDocument(row.docId, rows, { kind: 'owner' }).primary;
}

