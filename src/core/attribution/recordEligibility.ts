/**
 * Who wrote this logged record? One rule per channel, because only Telegram rows hold
 * `provenance`. `fromUser` is never evidence: it records direction, and logs hold agent
 * posts, session prompts and pastes under it. A logged display name alone never proves
 * identity. Spec: docs/specs/attribution-paper-trail.md section 2.
 *
 * These are exact field checks. A passing result is necessary, not sufficient: the
 * judge must also rule the words are the person's own.
 */
import type { MessageAuthorship } from '../AspAuthorshipJoin.js';
import type { SourceChannel } from './marker.js';

export type RecordStrength = 'verified' | 'logged-unclassified' | 'identity-only';
export type IneligibleReason = 'not-inbound' | 'unproven-provenance' | 'forwarded' | 'agent-authored' | 'identity-unverified' | 'not-this-person';

export type Eligibility =
  | { eligible: true; strength: RecordStrength; platformId: string }
  | { eligible: false; reason: IneligibleReason };

/** Maps a platform identity to the person it belongs to. Null means unmapped. */
export type IdentityMap = (channel: SourceChannel, platformId: string, context: { conversation: string }) => string | null;

export interface EligibilityInput {
  channel: SourceChannel;
  conversation: string;
  row: Record<string, unknown>;
  person: string;
  identity: IdentityMap;
  /** Telegram only: the ASP join's verdict for this row. */
  authorship?: MessageAuthorship;
}

/**
 * A note says "Justin" where the owner's name reads "Justin Headley", so one name may be the
 * leading words of the other. This compares a claim with an identity that already mapped from a
 * platform id: it is never how an identity is established.
 */
export function samePerson(a: string, b: string): boolean {
  const words = (value: string) => value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const [short, long] = [words(a), words(b)].sort((x, y) => x.length - y.length);
  return short.length > 0 && short.every((word, i) => word === long[i]);
}

/** The platform id of an app message from the owner's phone, whose rows carry no person. */
export const APP_OWNER_ID = 'app-owner';

function checkIdentity(input: EligibilityInput, platformId: unknown): { platformId: string } | Extract<Eligibility, { eligible: false }> {
  if (typeof platformId !== 'string' && typeof platformId !== 'number') return { eligible: false, reason: 'identity-unverified' };
  const id = String(platformId);
  const mapped = input.identity(input.channel, id, { conversation: input.conversation });
  if (mapped === null) return { eligible: false, reason: 'identity-unverified' };
  if (!samePerson(mapped, input.person)) return { eligible: false, reason: 'not-this-person' };
  return { platformId: id };
}

function identityOnly(input: EligibilityInput, platformId: unknown): Eligibility {
  const checked = checkIdentity(input, platformId);
  if ('eligible' in checked) return checked;
  return { eligible: true, strength: 'identity-only', platformId: checked.platformId };
}

export function checkEligibility(input: EligibilityInput): Eligibility {
  const { row } = input;
  switch (input.channel) {
    case 'telegram': {
      if (row.fromUser !== true) return { eligible: false, reason: 'not-inbound' };
      if (row.provenance !== 'user') return { eligible: false, reason: 'unproven-provenance' };
      // A message sent from the app has no `forwarded` field. Weaker, not refused.
      const fromApp = row.via === 'mobile-device' && row.forwarded === undefined;
      if (!fromApp && row.forwarded !== false) return { eligible: false, reason: 'forwarded' };
      if (input.authorship === 'agent-outbound' || input.authorship === 'agent-verified' || input.authorship === 'rejected') {
        return { eligible: false, reason: 'agent-authored' };
      }
      const checked = checkIdentity(input, row.telegramUserId);
      if ('eligible' in checked) return checked;
      if (fromApp) return { eligible: true, strength: 'identity-only', platformId: checked.platformId };
      return {
        eligible: true,
        strength: input.authorship === 'human' ? 'verified' : 'logged-unclassified',
        platformId: checked.platformId,
      };
    }
    case 'slack':
    case 'imessage':
    case 'whatsapp':
      if (row.fromUser !== true) return { eligible: false, reason: 'not-inbound' };
      return identityOnly(input, row.platformUserId);
    case 'app':
      if (row.role !== 'operator') return { eligible: false, reason: 'not-inbound' };
      {
        // People and roles: only an MSP row names a person. An owner row, and an older row
        // with no role, came from a device-signed owner phone, so it maps through the owner.
        const person = (row.senderPerson as { userId?: unknown } | undefined)?.userId;
        if (person !== undefined) return identityOnly(input, person);
        const ownerPhone = row.senderRole === 'owner' || (row.senderRole === undefined && row.origin !== undefined);
        return identityOnly(input, ownerPhone ? APP_OWNER_ID : undefined);
      }
    case 'threadline':
      if (row.direction !== 'inbound') return { eligible: false, reason: 'not-inbound' };
      return identityOnly(input, row.peerFingerprint);
  }
}
