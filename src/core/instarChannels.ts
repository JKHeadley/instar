/**
 * The actual inter-agent channels this agent has, wired into the channel registry.
 *
 * Scope discipline: PEER-TO-PEER only. Two things were on my first hand-written list that do not
 * belong here, and cutting them is the point rather than an omission:
 *   - the intelligence dispatcher polls an upstream service for instructions. One direction, not a peer.
 *   - the reputation/discovery client feeds trust decisions about peers. An input to a channel, not one.
 * Both were listed because their NAMES sounded like communication. Classify by consumer, not by label.
 */

import type { ChannelDefinition, ChannelProbeResult } from './channelRegistry.js';

/** What the registry needs from the running server. Injected so the definitions stay testable. */
export interface ChannelProbeContext {
  /** Live relay state, or null when the threadline layer was never constructed. */
  relayStatus: () => { ready: boolean; connected: boolean } | null;
  /** True when the mutual-SSH runtime constructed successfully (it throws on some installs). */
  mutualSshConstructed: () => boolean;
  /** Whether mutual-SSH is switched on for this agent at all. */
  mutualSshEnabled: () => boolean;
  /** Reachability of a named peer's own HTTP server, and whether we hold a credential for it. */
  peerHttp: () => Promise<{ reachable: boolean; haveCredential: boolean; detail: string }>;
}

/**
 * The agent-to-agent-over-Telegram protocol.
 *
 * Its inbound half is wired in production; its outbound function has no executing caller. That is a
 * BUILD-TIME fact, not something a runtime probe can see — so it is asserted here and guarded by a
 * source-scan test (`channel-registry-claims.test.ts`). If someone wires the sender, that test fails
 * and forces this verdict to be updated. An unguarded assertion in a registry is exactly the kind of
 * confident-but-stale label that cost me time in the first place.
 */
const A2A_TELEGRAM_LIMITATION =
  'inbound is wired in production; the outbound send function has no executing caller, so this ' +
  'channel can receive but cannot send';

export function buildChannelDefinitions(ctx: ChannelProbeContext): ChannelDefinition[] {
  return [
    {
      id: 'threadline-relay',
      audience: 'peer',
      purpose: 'Direct agent-to-agent messaging over the shared relay.',
      whenPreferred: 'The default for peer work: fastest, and invisible to the operator, so it does not spend their attention.',
      cost: 'Requires the server process relay client to be connected, and another process can hold a different relay state. Invisible when it fails, which is its main hazard.',
      probe: async (): Promise<ChannelProbeResult> => {
        const s = ctx.relayStatus();
        if (s === null) {
          return { state: 'not-configured', direction: 'none', detail: 'threadline layer was never constructed on this agent' };
        }
        if (s.ready && s.connected) {
          return {
            state: 'working', direction: 'bidirectional',
            detail: 'server process relay client reports ready and connected; NOTE this confirms the server client, not another process client such as the MCP tool path, and not that any given send will land',
          };
        }
        return {
          state: 'broken', direction: 'none',
          detail: `server process relay client reports ready=${s.ready}, connected=${s.connected}; a server-process send would be refused, while another process client such as the MCP tool path has its own state`,
        };
      },
    },
    {
      id: 'a2a-telegram',
      audience: 'peer',
      purpose: 'Agent-to-agent messages carried over the operator-visible Telegram channel, with a marker and anti-loop machinery.',
      whenPreferred: 'When the exchange should be reviewable by the operator, or as a fallback the relay cannot provide — ONCE its sender is wired.',
      cost: 'Consumes operator attention; slower; the conversation is visible.',
      // Static by necessity (see above), guarded by a source-scan test so it cannot rot silently.
      probe: async (): Promise<ChannelProbeResult> =>
        ({ state: 'half-built', direction: 'receive-only', detail: A2A_TELEGRAM_LIMITATION }),
    },
    {
      id: 'mutual-ssh',
      audience: 'peer',
      purpose: 'Machine-to-machine execution between paired hosts over a restricted SSH endpoint.',
      whenPreferred: 'Peer work that needs to run ON the other machine rather than be asked for.',
      cost: 'Requires paired keys and a listening endpoint; heaviest of the three to set up.',
      probe: async (): Promise<ChannelProbeResult> => {
        if (!ctx.mutualSshEnabled()) {
          return { state: 'not-configured', direction: 'none', detail: 'not enabled on this agent' };
        }
        if (!ctx.mutualSshConstructed()) {
          return {
            state: 'broken', direction: 'none',
            detail: 'enabled, but its runtime did not construct at boot — check the server log for an initialization-blocked line',
          };
        }
        // Constructed is not the same as reaching a peer, and the registry must not overstate it.
        return {
          state: 'working', direction: 'bidirectional',
          detail: 'runtime constructed and listening; NOTE this confirms initialisation, not a completed round-trip to a peer',
        };
      },
    },
    {
      id: 'peer-http',
      audience: 'peer',
      purpose: "Direct HTTP to a peer agent's own server on this machine.",
      whenPreferred: 'Last resort when the relay is down and the peer is co-located.',
      cost: 'Needs a credential for the peer\'s authenticated routes; on-box only.',
      probe: async (): Promise<ChannelProbeResult> => {
        const r = await ctx.peerHttp();
        if (!r.reachable) return { state: 'broken', direction: 'none', detail: r.detail };
        if (!r.haveCredential) {
          return { state: 'reachable-no-credential', direction: 'none', detail: r.detail };
        }
        return { state: 'working', direction: 'bidirectional', detail: r.detail };
      },
    },
  ];
}

/** Exported for the rot-guard test. */
export const A2A_TELEGRAM_CLAIM = A2A_TELEGRAM_LIMITATION;
