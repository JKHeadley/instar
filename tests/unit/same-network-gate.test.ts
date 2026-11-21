/**
 * Identity A4 points 2 and 3: the gate in front of the same-network listener, both ways for every
 * route class, and `arrivalOf` (nothing on that listener is ever local).
 */
import { describe, it, expect } from 'vitest';
import net from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sameNetworkGate, fromThisComputer } from '../../src/server/phoneSetupRoutes.js';
import { DEVICE_ALLOWLIST } from '../../src/server/mobilePairingRoutes.js';
import { arrivalOf, markSameNetworkSocket, mayBeLocalArrival } from '../../src/core/requestArrival.js';
import { isLoopbackPeer, arrivedOverLocalTls } from '../../src/core/desktopTransport.js';
import { localBindingOk, sameMacHost } from '../../src/server/mobileLocalOwnerDevice.js';
import { loopbackBindingOk } from '../../src/server/mobileBrowserDevices.js';
import { arrivedLocallyUnforwarded } from '../../src/server/mobileTrustApproval.js';
import type { DeviceRecord } from '../../src/core/MobileDeviceKeys.js';

const HOST = 'wintest-pc.local:5321';
const devices: Record<string, DeviceRecord> = {
  phone: { id: 'phone', deviceName: 'p', label: null, pairedAt: '', status: 'active', publicKey: 'k1', host: HOST, addressKind: 'same-network' },
  tailscalePhone: { id: 'tailscalePhone', deviceName: 'p', label: null, pairedAt: '', status: 'active', publicKey: 'k2', host: 'pc.tail1.ts.net' },
  macApp: { id: 'macApp', deviceName: 'mac', label: null, pairedAt: '', status: 'active', publicKey: 'k3', host: '127.0.0.1:4321', localBinding: { machineId: 'm' }, addressKind: 'same-network' },
  browser: { id: 'browser', deviceName: 'b', label: null, pairedAt: '', status: 'active', client: 'browser', browserPublicKey: 'k4', host: 'localhost:4321', addressKind: 'same-network' },
  otherPort: { id: 'otherPort', deviceName: 'p', label: null, pairedAt: '', status: 'active', publicKey: 'k5', host: 'wintest-pc.local:9999', addressKind: 'same-network' },
};
const gate = sameNetworkGate({
  device: (id) => devices[id] ?? null,
  deviceRoute: (m, p) => DEVICE_ALLOWLIST.some((r) => r.method === m && r.re.test(p)),
  ownHost: () => HOST,
});

function run(method: string, url: string, headers: Record<string, string> = {}): { passed: boolean; status: number; body: string } {
  const req = { method, url, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) } as unknown as IncomingMessage;
  const out = { status: 0, body: '' };
  const res = { statusCode: 0, setHeader: () => undefined, end: (b: string) => { out.status = (res as { statusCode: number }).statusCode; out.body = b; } } as unknown as ServerResponse;
  const passed = gate(req, res);
  return { passed, ...out };
}
const signedAs = (id: string) => ({ 'X-Instar-Device': id, 'X-Instar-Device-Time': '1', 'X-Instar-Device-Sig': 's' });

describe('same-network gate', () => {
  it('passes the pairing redeem and ping, unsigned', () => {
    expect(run('POST', '/mobile/pairing-codes/redeem').passed).toBe(true);
    expect(run('GET', '/mobile/pairing-codes/ping?n=abcdefghijklmnop').passed).toBe(true);
  });
  it('answers a bare health itself, with nothing about the agent', () => {
    const r = run('GET', '/health');
    expect(r.passed).toBe(false);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ status: 'ok' });
  });
  it('passes a route the device allow-list names, signed by a phone paired on this address', () => {
    expect(run('GET', '/mobile/conversations', signedAs('phone')).passed).toBe(true);
    expect(run('POST', '/mobile/device/activate-at-computer', signedAs('phone')).passed).toBe(true);
  });
  it('refuses the dashboard and its PIN unlock', () => {
    expect(run('GET', '/dashboard').status).toBe(404);
    expect(run('POST', '/dashboard/unlock').status).toBe(404);
    expect(run('GET', '/dashboard/pair', signedAs('phone')).status).toBe(404);
  });
  it('refuses any request carrying the agent\'s token, a cookie, a step-up proof, a local credential or a forwarding claim', () => {
    expect(run('GET', '/mobile/conversations', { ...signedAs('phone'), Authorization: 'Bearer t' }).status).toBe(404);
    expect(run('POST', '/mobile/pairing-codes/redeem', { Authorization: 'Bearer t' }).status).toBe(404);
    expect(run('POST', '/mobile/pairing-codes/redeem', { Cookie: 'a=b' }).status).toBe(404);
    expect(run('GET', '/mobile/conversations', { ...signedAs('phone'), 'X-Instar-Step-Up': 'x' }).status).toBe(404);
    expect(run('GET', '/mobile/attention/x', { 'X-Instar-Device': 'phone', 'X-Instar-Notify-Token': 't' }).status).toBe(404);
    expect(run('POST', '/mobile/pairing-codes/redeem', { 'X-Forwarded-For': '1.2.3.4' }).status).toBe(404);
  });
  it('refuses the route that enrols the app on the agent\'s own computer, and the local key override route', () => {
    expect(run('POST', '/mobile/local-owner-device').status).toBe(404);
    expect(run('POST', '/mobile/trust/device-acceptance', signedAs('phone')).status).toBe(404);
  });
  it('refuses a device bound to the computer or to loopback, a browser, a phone paired elsewhere, and an unknown device', () => {
    expect(run('GET', '/mobile/conversations', signedAs('macApp')).status).toBe(404);
    expect(run('GET', '/mobile/conversations', signedAs('browser')).status).toBe(404);
    expect(run('GET', '/mobile/conversations', signedAs('tailscalePhone')).status).toBe(404);
    expect(run('GET', '/mobile/conversations', signedAs('otherPort')).status).toBe(404);
    expect(run('GET', '/mobile/conversations', signedAs('nobody')).status).toBe(404);
  });
  it('refuses a route the allow-list does not name, and any unsigned route but the two', () => {
    expect(run('GET', '/backups', signedAs('phone')).status).toBe(404);
    expect(run('POST', '/feedback', signedAs('phone')).status).toBe(404);
    expect(run('POST', '/mobile/phone-setup').status).toBe(404);
    expect(run('GET', '/mobile/devices').status).toBe(404);
    expect(run('GET', '/config').status).toBe(404);
  });
});

describe('arrivalOf: nothing on the same-network listener is local', () => {
  function sockets(): { plain: net.Socket; marked: net.Socket } {
    const plain = new net.Socket();
    Object.defineProperty(plain, 'remoteAddress', { value: '127.0.0.1', configurable: true });
    const marked = new net.Socket();
    Object.defineProperty(marked, 'remoteAddress', { value: '127.0.0.1', configurable: true });
    expect(markSameNetworkSocket(marked)).toBe('127.0.0.1');
    return { plain, marked };
  }
  it('answers from the socket the listener marked, never from the address', () => {
    const { plain, marked } = sockets();
    expect(arrivalOf({ socket: plain })).toBe('main');
    expect(arrivalOf({ socket: marked })).toBe('same-network');
    expect(mayBeLocalArrival({ socket: marked })).toBe(false);
    // Marking twice keeps the real address for the listener's own limits.
    expect(markSameNetworkSocket(marked)).toBe('127.0.0.1');
  });
  it('a request from a loopback address on that listener fails every local test', () => {
    const { plain, marked } = sockets();
    expect(isLoopbackPeer(marked.remoteAddress)).toBe(false);
    const mk = (socket: net.Socket, host: string) => ({ socket, headers: { host } }) as never;
    // Positive controls on the main listener first, so each "false" below is the arrival's doing.
    expect(sameMacHost(mk(plain, '127.0.0.1:4321'), 4321)).toBe('127.0.0.1:4321');
    expect(sameMacHost(mk(marked, '127.0.0.1:4321'), 4321)).toBeNull();
    const local = { host: '127.0.0.1:4321', localBinding: { machineId: 'm' } };
    expect(localBindingOk(local, mk(plain, '127.0.0.1:4321'), 'm')).toBe(true);
    expect(localBindingOk(local, mk(marked, '127.0.0.1:4321'), 'm')).toBe(false);
    const browser = { client: 'browser' as const, host: 'localhost:4321' };
    expect(loopbackBindingOk(browser, mk(plain, 'localhost:4321'))).toBe(true);
    expect(loopbackBindingOk(browser, mk(marked, 'localhost:4321'))).toBe(false);
    expect(arrivedLocallyUnforwarded(mk(plain, 'x'))).toBe(true);
    expect(arrivedLocallyUnforwarded(mk(marked, 'x'))).toBe(false);
    expect(fromThisComputer(mk(plain, 'x'))).toBe(true);
    expect(fromThisComputer(mk(marked, 'x'))).toBe(false);
  });
  it('the transport test presence-signed approvals need still passes on the listener (it is TLS)', () => {
    const { marked } = sockets();
    expect(arrivedOverLocalTls(true, marked.remoteAddress, undefined, null)).toBe(true);
    expect(arrivedOverLocalTls(false, marked.remoteAddress, undefined, null)).toBe(false);
  });
});
