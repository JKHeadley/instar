/**
 * Channel registry — which ways of reaching another agent exist, and which of them work RIGHT NOW.
 *
 * WHY THIS EXISTS (2026-07-26, topic 29723). The relay died mid-session. I stopped, told the operator
 * I could not reach the peer, and moved on — because I had no way to ask "what else reaches him, and
 * which of those is alive?". I did not CHOOSE a channel; I used the one I reached for. The operator's
 * words: the paths we use to communicate feel arbitrary.
 *
 * ── THE DESIGN CONSTRAINT, EARNED THE HARD WAY ─────────────────────────────────────────────────
 *
 * A registry that merely LISTS what exists would have made that night WORSE. Reviewing the channels by
 * hand I misclassified three of them in one hour — each time by reading a label (a header, a name, a
 * directory) instead of the consumer. One "channel" was a purpose-built peer protocol whose SEND half
 * has no caller at all. Had a naive list shown it to me mid-outage, I would have reached for it with
 * exactly the same false confidence and lost more time.
 *
 * So the load-bearing property is not the list. It is:
 *
 *   1. ABSENCE IS IMPOSSIBLE. The channel set is defined in CODE, never derived from what happened to
 *      construct successfully. Three separate failures that night were invisible for precisely this
 *      reason — the thing that failed removed itself from the list of failures. A relay that dropped
 *      left "connected" as the only record. A subsystem that threw before registering was missing from
 *      an 88-row guard inventory: not "off", not "errored" — ABSENT. A peer had no row at all in the
 *      surface built to report peer health. A missing row and a healthy system read identically.
 *
 *   2. A CHANNEL THAT CANNOT DETERMINE ITS OWN LIVENESS SAYS SO. `unknown` is a first-class verdict
 *      carrying a reason, never collapsed into `working` and never rendered as a clean-looking empty.
 *
 *   3. THE STATE SET MATCHES REALITY. Binary up/down cannot express what was actually found:
 *      half-built (receive works, send has no caller), reachable-but-no-credential, or configured-off.
 *      A registry whose vocabulary is too small will lie in the most confident-sounding way.
 *
 * This idiom is NOT invented here — the codebase already does it in at least three places
 * (`/capability-registry` reporting `scanState: "never-observed"` rather than an empty list;
 * `/capabilities` reporting `autoDispatch: false` rather than omitting the key; a discovery adapter
 * whose `isAvailable()` returns false when its breaker is open). This makes that property UNIVERSAL
 * across channels rather than a habit some surfaces happen to have.
 */

/**
 * What a channel's liveness verdict can be. Every value here was observed on a real channel — none is
 * speculative, and the set is deliberately wider than working/broken.
 */
export type ChannelState =
  /** Probed and usable right now. */
  | 'working'
  /** Probed; it exists and is meant to work, but does not. */
  | 'broken'
  /** Only part of it is implemented — e.g. inbound is wired, outbound has no caller. */
  | 'half-built'
  /** The endpoint answers, but this agent holds no credential for its authenticated routes. */
  | 'reachable-no-credential'
  /** Deliberately not enabled here (config absent/false). Off is not broken. */
  | 'not-configured'
  /** Could not be determined. Carries a reason. NEVER a synonym for healthy. */
  | 'unknown';

/** Which direction(s) a channel can actually carry traffic — the half-built case made explicit. */
export type ChannelDirection = 'bidirectional' | 'send-only' | 'receive-only' | 'none';

/**
 * Who is on the other end. This exists because "which channel should I use?" is ONE question with
 * two very different answers, and splitting it across two surfaces recreates the arbitrariness this
 * registry was built to remove — a caller would have to already know which list to consult.
 *
 * The distinction is kept as DATA rather than as two registries because the choice between them is
 * itself a routing decision: reaching a peer costs latency, reaching the operator costs their
 * attention. A caller cannot weigh that trade-off if it can only see one side of it.
 */
export type ChannelAudience =
  /** Another agent. */
  | 'peer'
  /** A human operator, on the surface they actually read. */
  | 'user';

export interface ChannelDefinition {
  id: string;
  /** Who is on the other end — see ChannelAudience for why this is data, not two registries. */
  audience: ChannelAudience;
  /** What it is for, in the operator's terms. */
  purpose: string;
  /** When this channel is the right choice over the others. */
  whenPreferred: string;
  /** What using it costs — latency, visibility, quota, operator attention. */
  cost: string;
  /**
   * Determines liveness. May throw or hang; the resolver contains that and reports `unknown` with the
   * reason. A probe is never trusted to behave.
   */
  probe: () => Promise<ChannelProbeResult>;
}

export interface ChannelProbeResult {
  state: ChannelState;
  direction: ChannelDirection;
  /** Plain-English evidence for the verdict. Required — a verdict without evidence is an assertion. */
  detail: string;
}

export interface ChannelReport extends ChannelProbeResult {
  id: string;
  audience: ChannelAudience;
  purpose: string;
  whenPreferred: string;
  cost: string;
  /** True when the verdict came from a probe that failed rather than from an observation. */
  probeFailed: boolean;
}

export interface ChannelRegistryReport {
  /** Every code-defined channel. Length is invariant regardless of probe outcomes. */
  channels: ChannelReport[];
  /** Convenience counts. `unknown` is surfaced separately so it can never hide inside a total. */
  summary: { total: number; working: number; unusable: number; unknown: number };
  generatedAt: string;
}

const PROBE_TIMEOUT_MS = 3_000;

/** Bound a probe so one hanging channel cannot make the whole registry unanswerable. */
async function withTimeout(p: Promise<ChannelProbeResult>): Promise<ChannelProbeResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<ChannelProbeResult>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`probe exceeded ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolve every channel. The guarantee this function exists to provide: the returned `channels` array
 * has exactly one entry per definition, ALWAYS — a throwing probe, a hanging probe, and a probe that
 * returns nonsense all yield a row, never an omission.
 */
export async function resolveChannels(
  definitions: readonly ChannelDefinition[],
  now: () => string = () => new Date().toISOString(),
): Promise<ChannelRegistryReport> {
  const channels = await Promise.all(
    definitions.map(async (def): Promise<ChannelReport> => {
      const base = {
        id: def.id,
        audience: def.audience,
        purpose: def.purpose,
        whenPreferred: def.whenPreferred,
        cost: def.cost,
      };
      try {
        const result = await withTimeout(def.probe());
        // A probe returning a shape we do not recognise is a failed probe, not a healthy channel.
        if (!result || typeof result.state !== 'string' || typeof result.detail !== 'string') {
          return { ...base, state: 'unknown', direction: 'none', probeFailed: true,
            detail: 'probe returned an unrecognised result; treating as undetermined rather than healthy' };
        }
        return { ...base, ...result, probeFailed: false };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { ...base, state: 'unknown', direction: 'none', probeFailed: true,
          detail: `could not determine liveness: ${reason.slice(0, 200)}` };
      }
    }),
  );

  const working = channels.filter(c => c.state === 'working').length;
  const unknown = channels.filter(c => c.state === 'unknown').length;
  // "unusable" deliberately EXCLUDES unknown — conflating "known broken" with "could not tell"
  // is the exact collapse this module exists to prevent.
  const unusable = channels.filter(c =>
    c.state === 'broken' || c.state === 'half-built' || c.state === 'reachable-no-credential').length;

  return { channels, summary: { total: channels.length, working, unusable, unknown }, generatedAt: now() };
}
