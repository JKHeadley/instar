/**
 * Which listener a request arrived on (identity A4, point 3; docs/specs/identity-security-piece3e-same-network-first-phone.md §3.3).
 *
 * The agent has a main listener (the dashboard, the API, the app's own-name routes) and, once the
 * owner asks at the computer, a same-network listener for a phone at home. Nothing that arrives on
 * the same-network listener is ever "local", whatever address it comes from. That matters most on
 * Windows, where the Windows app's pass-through reaches an agent inside WSL from a loopback address.
 *
 * The answer comes from the socket the listener accepted, never from the request's address or
 * headers. The listener marks each socket when it accepts it, before any byte of HTTP is read, and
 * it also rewrites that socket's `remoteAddress` to a non-address spelling (`sn:<address>`), so a
 * local test that reads only the address answers no on that listener too.
 *
 * Every "is this request local?" test asks `arrivalOf` first. A build-time test
 * (tests/unit/request-arrival-ratchet.test.ts) fails on a new address-only local test outside this file.
 */
import type { Socket } from 'node:net';

export type Arrival = 'main' | 'same-network' | 'hosted-relay';

const ARRIVAL = Symbol.for('instar.requestArrival');
/** The prefix a same-network socket's `remoteAddress` carries; it is never an IP address. */
export const SAME_NETWORK_ADDRESS_PREFIX = 'sn:';

type MarkedSocket = Socket & { [ARRIVAL]?: Arrival };
type RelayAssignment = Readonly<{ hostname: string; assignment: string }>;
const relayAssignments = new WeakMap<Socket, RelayAssignment>();

/** Set only by the dedicated TLS listener, before dispatching HTTP. */
export function markHostedRelaySocket(socket: Socket, scope: RelayAssignment): void {
  const s = socket as MarkedSocket;
  const prior = relayAssignments.get(s);
  if (prior?.hostname === scope.hostname && prior.assignment === scope.assignment) return;
  if (s[ARRIVAL] || prior) throw new Error('relay-arrival-already-marked');
  Object.defineProperty(s, ARRIVAL, { value: 'hosted-relay' });
  Object.defineProperty(s, 'remoteAddress', { value: 'relay:' + (s.remoteAddress ?? ''), enumerable: true });
  relayAssignments.set(s, Object.freeze({ ...scope }));
}

export function hostedRelayArrival(req: { socket?: unknown }): RelayAssignment | undefined {
  return relayAssignments.get(req.socket as Socket);
}

/**
 * Mark a socket the same-network listener accepted. Called once per connection by that listener
 * only. Returns the real peer address, which only the listener's own limits may use.
 */
export function markSameNetworkSocket(socket: Socket): string {
  const s = socket as MarkedSocket;
  const real = s[ARRIVAL] === 'same-network' ? String(socket.remoteAddress ?? '').slice(SAME_NETWORK_ADDRESS_PREFIX.length) : String(socket.remoteAddress ?? '');
  if (s[ARRIVAL] !== 'same-network') {
    Object.defineProperty(s, ARRIVAL, { value: 'same-network', enumerable: false, configurable: false, writable: false });
    // A local test that reads only the address (isLoopbackPeer and its relatives) now answers no.
    Object.defineProperty(s, 'remoteAddress', { value: `${SAME_NETWORK_ADDRESS_PREFIX}${real}`, enumerable: true, configurable: false, writable: false });
  }
  return real;
}

/** The listener a request arrived on: `same-network` only for a socket that listener marked. */
export function arrivalOf(req: { socket?: unknown } | null | undefined): Arrival {
  const s = (req?.socket ?? null) as MarkedSocket | null;
  return s?.[ARRIVAL] ?? 'main';
}

/** True only for the ordinary main listener. Local tests call this first. */
export function mayBeLocalArrival(req: { socket?: unknown } | null | undefined): boolean {
  return arrivalOf(req) === 'main';
}

/**
 * The routes the same-network listener serves to a caller with no device signature: the pairing
 * redeem and its ping (each carries its own one-time code). One list for the listener's gate and the
 * auth middleware, so the two cannot drift.
 */
export const SAME_NETWORK_PUBLIC_ROUTES: ReadonlyArray<readonly [string, RegExp]> = [
  ['POST', /^\/mobile\/pairing-codes\/redeem$/],
  ['GET', /^\/mobile\/pairing-codes\/ping$/],
];

/** Whether `method path` is one of SAME_NETWORK_PUBLIC_ROUTES (path compared lower-case, without a trailing slash). */
export function isSameNetworkPublicRoute(method: string, path: string): boolean {
  const m = String(method ?? '').toUpperCase();
  const p = (String(path ?? '/').split('?')[0].toLowerCase().replace(/\/+$/, '') || '/');
  return SAME_NETWORK_PUBLIC_ROUTES.some(([rm, re]) => rm === m && re.test(p));
}
