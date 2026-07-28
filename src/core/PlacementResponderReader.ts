/**
 * PlacementResponderReader — resolves WHICH machine served a reply, for the
 * RealChannelDriver's injected `resolveResponderMachine` seam
 * (docs/specs/live-user-channel-proof-standard.md §5.6 — the deterministic
 * cross-machine proof). It maps a (surface, channelId) to the topic that
 * `GET /pool/placement?topic=N` is keyed on, reads the authoritative owner, and
 * returns that machine id.
 *
 * Why this is the right reader: `/pool/placement` is the authoritative placement
 * surface (it proxies to the lease-holder, so any machine can answer), and its
 * `owner` field is the machine currently serving the topic — exactly "who replied"
 * after a transfer. We read `owner` (not `pinnedTo`): a pin is the INTENT to place;
 * `owner` is who actually holds it. For the capstone that distinction is the whole
 * point — a pin that didn't move the seat is the original bug.
 *
 * Parameterized for testability: the HTTP GET + the (surface, channelId)→topicId
 * mapping are injected, so this is unit-testable with no live server. MUST NOT throw
 * on a transient read error — it returns null so the RealChannelDriver degrades to an
 * unattributed reply rather than failing the whole scenario.
 */

// RULE 3: EXEMPT — this reads instar's OWN authoritative `/pool/placement` JSON API
// (a structured internal response with an explicit `owner` field), not fragile
// provider/CLI stdout. There is no brittle output-parsing state-detection pattern to
// harden: `owner` is read straight from the typed response, and any read error/absence
// degrades to null. Not a provider-state detector.

import type { Surface } from './LiveTestArtifactStore.js';

export interface PlacementResult {
  owner: string | null;
  ownerNickname?: string | null;
}

export interface PlacementResponderReaderDeps {
  /**
   * Map (surface, channelId) → the topic id `/pool/placement` is keyed on. For
   * telegram, channelId IS the topic. For slack, the caller injects the
   * channel→topic resolution (the SlackAdapter's session keying). Return null when
   * the channel doesn't map to a placement-tracked topic.
   */
  topicForChannel: (surface: Surface, channelId: string) => string | null;
  /** GET /pool/placement?topic=<id> → the placement (owner). Throwing/transient errors are tolerated. */
  fetchPlacement: (topicId: string) => Promise<PlacementResult | null>;
  logger?: (m: string) => void;
}

export class PlacementResponderReader {
  private readonly d: PlacementResponderReaderDeps;
  constructor(deps: PlacementResponderReaderDeps) { this.d = deps; }

  private log(m: string): void { this.d.logger?.(`[placement-responder-reader] ${m}`); }

  /** The function shape RealChannelDriver injects: (surface, channelId) → machine id | null. */
  resolve = async (surface: Surface, channelId: string): Promise<string | null> => {
    const topicId = this.d.topicForChannel(surface, channelId);
    if (!topicId) {
      this.log(`no placement-tracked topic for ${surface}:${channelId}`);
      return null;
    }
    try {
      const p = await this.d.fetchPlacement(topicId);
      return p?.owner ?? null;
    } catch (err) {
      // @silent-fallback-ok: a transient /pool/placement read failure degrades this
      // best-effort responder-machine lookup to null — the RealChannelDriver then
      // proceeds with an unattributed reply rather than throwing the whole scenario.
      // The failure is logged with topic context; it is not a gating/authority path.
      this.log(`fetchPlacement failed for topic ${topicId}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };
}
