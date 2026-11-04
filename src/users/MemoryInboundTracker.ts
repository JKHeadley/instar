/**
 * MemoryInboundTracker — the step every inbound message takes before routing.
 * Spec: docs/specs/memory-privacy.md §1, §3.
 *
 * Records who spoke and where, re-checks a shared place's readers, and ends any
 * session whose audience no longer matches BEFORE the message reaches it, so a
 * session holding wider memory never answers a new reader.
 */

import { audienceKey, OPERATOR_PERSON_ID, type MemoryPrivacy } from './MemoryPrivacy.js';
import { isScopedAudience } from './MemoryAudience.js';

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
}

export type InboundVerdict = 'deliver' | 'unavailable';

/** The fixed reply when a session cannot run inside the boundary. Never run it unprotected. */
export const MEMORY_PRIVACY_UNAVAILABLE_REPLY =
  "I can't reply here yet: private memory isn't set up on this agent. Please ask the agent's owner to finish that setup.";

export class MemoryInboundTracker {
  constructor(private readonly deps: MemoryInboundDeps) {}

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
