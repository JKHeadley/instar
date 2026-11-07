/**
 * MemoryInboundTracker — the step every inbound message takes before routing.
 * Spec: docs/specs/memory-privacy.md §1, §3.
 *
 * Records who spoke and where, re-checks a shared place's readers, and ends any
 * session whose audience no longer matches BEFORE the message reaches it, so a
 * session holding wider memory never answers a new reader.
 */

import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';
import { audienceKey, OPERATOR_PERSON_ID, type MemoryPrivacy } from './MemoryPrivacy.js';
import { isScopedAudience } from './MemoryAudience.js';
import type { MemoryBlocker, MemoryPrivacyRecovery } from './MemoryPrivacyRecovery.js';

export interface InboundFacts {
  placeKey: string;
  placeKind: 'private' | 'shared';
  /** Verified sender: `user:<id>` when resolved, else `<platform>:<id>`. Null when unverified. */
  senderKey: string | null;
  personId: string | null;
  /** Shared places: a fresh count of human readers. Null or a throw means unknown, so shared. */
  readerCount?: () => Promise<number | null>;
  /** This channel cannot reply from inside the boundary (iMessage). */
  scopedUnsupported?: boolean;
  /** The live session serving this place, by its tmux name, if any. */
  liveSession?: () => string | null | undefined;
}

export interface MemoryInboundDeps {
  privacy: MemoryPrivacy;
  retireSessions: () => Promise<string[]>;
  /** End this session unless its audience matches. False means it survived, so do not deliver. */
  retireSessionUnlessAudience: (tmuxSession: string, audience: string) => Promise<boolean>;
  sandboxReady: () => boolean;
  /** Framework new sessions would use. */
  framework: () => string;
  /** The owner's way out of the fixed reply. */
  recovery?: MemoryPrivacyRecovery;
}

export type InboundVerdict = 'deliver' | 'unavailable';

/** The fixed reply when a session cannot run inside the boundary. Never run it unprotected. */
export const MEMORY_PRIVACY_UNAVAILABLE_REPLY =
  "I can't reply here yet: private memory isn't set up on this agent. Please ask the agent's owner to finish that setup.";

/** A shared place sees this instead of the cause; the cause goes to the owner privately. */
export const MEMORY_PRIVACY_OWNER_CHANNEL_REPLY =
  "I can't reply here yet. I've sent you the reason and the fix in a private message.";

/** Nothing is wrong with private memory, as on a session that could not be reset. */
export const MEMORY_PRIVACY_RETRY_REPLY = "I can't reply yet. Please try again in a minute.";

/** Sends to the owner's private chat. False or a throw means it did not go. */
export type SendOwnerPrivately = (text: string) => Promise<boolean>;

export class MemoryInboundTracker {
  constructor(private readonly deps: MemoryInboundDeps) {}

  /**
   * What the place sees after an 'unavailable' verdict, sending the owner the cause and
   * link first when it should. Only the owner hears the cause, and only in private: it
   * names paths and a link, and a shared place has other readers. The channel only
   * claims a message that went.
   */
  async refuse(facts: InboundFacts, sendOwnerPrivately?: SendOwnerPrivately): Promise<string> {
    const { privacy, recovery } = this.deps;
    const owner = privacy.isOwnerSender(facts.senderKey, facts.personId);
    // Locking the owner out is the harm; anyone else refused is the boundary doing its job.
    featureEvidence.record('memoryPrivacy', owner
      ? { kind: 'error', reason: 'owner refused' }
      : { kind: 'held', reason: 'person refused' });
    if (!recovery || !owner) return MEMORY_PRIVACY_UNAVAILABLE_REPLY;
    // The owner's own private chat needs no boundary, so private memory is not the cause.
    const audience = privacy.audienceFor(privacy.placeFor({ memoryPlaceKey: facts.placeKey }, null));
    if (!isScopedAudience(audience)) return MEMORY_PRIVACY_RETRY_REPLY;
    const blocker: MemoryBlocker | undefined = this.deps.framework() !== 'claude-code' ? 'framework' : undefined;
    if (!recovery.hasCause(blocker)) return MEMORY_PRIVACY_RETRY_REPLY;
    if (!sendOwnerPrivately) return MEMORY_PRIVACY_UNAVAILABLE_REPLY;
    if (recovery.noticeIsRecent()) return MEMORY_PRIVACY_OWNER_CHANNEL_REPLY;
    try {
      if (await sendOwnerPrivately(recovery.ownerMessage(blocker))) {
        recovery.markNoticeSent();
        return MEMORY_PRIVACY_OWNER_CHANNEL_REPLY;
      }
    } catch (err) {
      console.warn(`[memory-privacy] owner message failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return MEMORY_PRIVACY_UNAVAILABLE_REPLY;
  }

  async onInbound(facts: InboundFacts): Promise<InboundVerdict> {
    const { privacy } = this.deps;
    if (!privacy.enabled) return 'deliver';

    privacy.establishBaseline();
    if (facts.senderKey) privacy.observeSender(facts.senderKey);
    const flipped = privacy.takeFlip();
    const personId = facts.personId ?? (privacy.isOperator(facts.senderKey) ? OPERATOR_PERSON_ID : null);
    privacy.recordPlace(facts.placeKey, facts.placeKind, facts.placeKind === 'private' ? personId : null);

    let readersChanged = false;
    if (facts.placeKind === 'shared') {
      let count: number | null = null;
      let countFailed = false;
      try {
        count = (await facts.readerCount?.()) ?? null;
      } catch {
        // @silent-fallback-ok — earlier proof is left to expire, so one API error ends no
        // conversation; with no proof the place reads as shared.
        countFailed = true;
      }
      readersChanged = privacy.groupGainedReaders(facts.placeKey, count);
      if (facts.senderKey && !privacy.isOperator(facts.senderKey)) {
        readersChanged = privacy.dropGroupConfirmation(facts.placeKey) || readersChanged;
      }
      const sole = count === 1 ? (personId ?? (privacy.isMultiPerson() ? null : 'sole-reader')) : null;
      if (!countFailed) readersChanged = privacy.recordSoleReader(facts.placeKey, sole) || readersChanged;
    }

    if (flipped || readersChanged) await this.deps.retireSessions();

    const audience = privacy.audienceFor(privacy.placeFor({ memoryPlaceKey: facts.placeKey }, null));
    // Whatever started this session, it must match before this message reaches it: this
    // covers sessions from before an update, a restart, and a place that lost its proof.
    const live = facts.liveSession?.();
    if (live && !(await this.deps.retireSessionUnlessAudience(live, audienceKey(audience)))) return 'unavailable';

    if (isScopedAudience(audience) && (facts.scopedUnsupported || this.deps.framework() !== 'claude-code' || !this.deps.sandboxReady())) {
      return 'unavailable';
    }
    return 'deliver';
  }
}
