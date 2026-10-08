/**
 * relayBootStatus — the one truthful boot line about the relay connection.
 *
 * Spec: docs/specs/threadline-identity-single-writer.md §3.
 *
 * The server used to print "relay connected to <host>" as soon as the inbound
 * handlers were wired, whatever the connection attempt had returned. On
 * 2026-10-08 that line followed a relay rejection ("Invalid public key")
 * directly. The line now reports the client's actual state.
 */

export interface RelayBootStatus {
  /** True only when the client reports an authenticated relay session. */
  connected: boolean;
  text: string;
}

export function describeRelayBootStatus(
  host: string,
  connectionState: string,
  opts: { daemonHandlingRelay?: boolean } = {},
): RelayBootStatus {
  if (connectionState === 'connected') {
    return { connected: true, text: `Threadline: relay connected to ${host}` };
  }
  if (opts.daemonHandlingRelay) {
    return {
      connected: false,
      text: `Threadline: relay handlers wired for ${host}; this server holds no relay connection (the listener daemon owns it)`,
    };
  }
  return {
    connected: false,
    text: `Threadline: relay NOT connected to ${host} (state: ${connectionState}) — handlers are wired; the "relay connection" line above says why and whether it retries`,
  };
}
