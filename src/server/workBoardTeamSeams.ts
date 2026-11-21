/**
 * The Work Board's view of the team record (agent-work-cards-default §8), built from the pairing service: who stands on
 * the team (the service's `teamMember`) and whether a person may read a conversation under the owner's grant (the pass
 * floor's `personMayRead`). Pure over a small pairing interface so the mapping is tested without a server.
 */
import { devicePerson, type OwnerIdentity, type ResolvedPerson, type TeamStanding } from '../core/MobilePeople.js';
import type { WorkBoardTeamSeams } from '../core/WorkBoardRuntime.js';
import type { TeamMembership } from '../core/WorkBoardService.js';

export interface WorkBoardTeamSource {
  /** The replicated team log, or null when this agent has none at all. */
  teamLog(): { healthState(): 'absent' | 'ok' | 'unreadable' } | null;
  /** A non-owner person's standing from the log (null = no access). */
  teamStanding(personKey: string): TeamStanding | null;
  ownerIdentity(): OwnerIdentity;
  /** The one shared conversation check. */
  mayUse(person: ResolvedPerson, ref: string, op: 'read'): boolean;
}

/** `team` standing that carries cards: the member and admin tiers; a guest reads and does not act. */
export function membershipOf(standing: TeamStanding | null): TeamMembership {
  if (!standing) return 'not-a-member';
  return standing.tier === 'member' || standing.tier === 'admin' ? 'member' : 'not-a-member';
}

export function workBoardTeamSeams(pairing: WorkBoardTeamSource): WorkBoardTeamSeams {
  return {
    teamMember: (personKey) => {
      const log = pairing.teamLog();
      // No log, or a log with no rows yet: a team of one, so nobody but the owner carries a card. Only a log that
      // exists and cannot be read is `unavailable` (no card changes hands on a guess).
      if (!log || log.healthState() === 'absent') return 'not-a-member';
      if (log.healthState() !== 'ok') return 'unavailable';
      return membershipOf(pairing.teamStanding(personKey));
    },
    personMayRead: (personKey, conversationKey) => {
      const log = pairing.teamLog();
      if (!log || log.healthState() !== 'ok') return null;
      const p = devicePerson({ userId: personKey, role: 'team' }, null, pairing.ownerIdentity(), undefined, (k) => pairing.teamStanding(k));
      return p.ok ? pairing.mayUse(p, `app:${conversationKey}`, 'read') : false;
    },
  };
}
