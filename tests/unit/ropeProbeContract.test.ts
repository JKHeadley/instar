/**
 * U4.3 — typed-contract probe classifier (docs/specs/u4-3-breaker-recovery-probe.md §6).
 *
 * parseProbeResponse is a REGISTERED parser (Scrape/Parser Fixture Realness):
 * the load-bearing test feeds it CAPTURED byte-for-byte fixtures of real
 * /mesh/rpc responses (produced by the production MeshRpcDispatcher + route +
 * createDeliverMessageHandler over loopback with real Ed25519 keys) plus real
 * wrong-server/captive-portal bodies. Success is the EXACT typed contract —
 * `refused:not-router` / `ack:sender-rejected` — never any-2xx.
 */
import { describe, it, expect } from 'vitest';
import { loadCapturedFixture } from '../helpers/loadCapturedFixture.js';
import {
  parseProbeResponse,
  buildRopeProbeCommand,
  ROPE_PROBE_BOGUS_UID,
  ROPE_PROBE_SESSION_PREFIX,
} from '../../src/core/ropeProbeContract.js';

describe('parseProbeResponse — typed-contract success classifier', () => {
  it('classifies the REAL captured /mesh/rpc probe responses byte-for-byte', () => {
    // Typed success 1 — the peer's sender re-validation refused the bogus uid.
    const senderRejected = loadCapturedFixture('mesh-rpc-probe-responses', 'ack-sender-rejected');
    expect(parseProbeResponse(senderRejected, 200)).toMatchObject({
      typedSuccess: true,
      classification: 'ack-sender-rejected',
    });

    // Typed success 2 — RBAC refused a non-router sender.
    const notRouter = loadCapturedFixture('mesh-rpc-probe-responses', 'refused-not-router');
    expect(parseProbeResponse(notRouter, 403)).toMatchObject({
      typedSuccess: true,
      classification: 'refused-not-router',
    });

    // A typed ack that ACCEPTED the probe (degenerate-registry peer failed toward
    // delivery) is NOT the contract — failure.
    const queued = loadCapturedFixture('mesh-rpc-probe-responses', 'accepted-queued');
    expect(parseProbeResponse(queued, 200)).toMatchObject({
      typedSuccess: false,
      classification: 'accepted-not-refused',
      detail: 'queued',
    });

    // Unsigned/garbage signature — the dispatcher's 401. Failure (wrong keys ≠ alive rope).
    const unsigned = loadCapturedFixture('mesh-rpc-probe-responses', 'unsigned-signature-invalid');
    expect(parseProbeResponse(unsigned, 401)).toMatchObject({
      typedSuccess: false,
      classification: 'auth-rejected',
      detail: 'signature-invalid',
    });

    // A REAL captive portal answers 200 HTML to anything — a 2xx that never closes.
    const captive = loadCapturedFixture('mesh-rpc-probe-responses', 'captive-portal-200');
    const captiveVerdict = parseProbeResponse(captive, 200);
    expect(captiveVerdict.typedSuccess).toBe(false);
    expect(['malformed', 'untyped-2xx']).toContain(captiveVerdict.classification);

    // A REAL wrong server (example.com) answering HTML 405 — failure.
    const wrongServer = loadCapturedFixture('mesh-rpc-probe-responses', 'wrong-server-405-html');
    expect(parseProbeResponse(wrongServer, 405).typedSuccess).toBe(false);
  });

  it('an untyped JSON 2xx (parses, but not the ack shape) is a FAILURE — any-2xx never closes', () => {
    expect(parseProbeResponse('{"ok":true}', 200)).toMatchObject({
      typedSuccess: false,
      classification: 'untyped-2xx',
    });
    expect(parseProbeResponse('{"status":"healthy"}', 200)).toMatchObject({
      typedSuccess: false,
      classification: 'untyped-2xx',
    });
    // 204-ish empty body inside the 2xx band.
    expect(parseProbeResponse('', 204)).toMatchObject({ typedSuccess: false, classification: 'malformed' });
  });

  it('a 403 with a NON-not-router reason is a failure (only the exact typed refusal counts)', () => {
    expect(parseProbeResponse('{"ok":false,"reason":"claim-unauthorized"}', 403)).toMatchObject({
      typedSuccess: false,
      classification: 'http-error',
    });
  });

  it('a 409 replayed-nonce / stale-timestamp is a failure, not a close', () => {
    expect(parseProbeResponse('{"ok":false,"reason":"replayed-nonce"}', 409).typedSuccess).toBe(false);
    expect(parseProbeResponse('{"ok":false,"reason":"stale-timestamp"}', 409).typedSuccess).toBe(false);
  });
});

describe('buildRopeProbeCommand — the G4 canary payload contract', () => {
  it('builds a bogus-uid deliverMessage with a NON-numeric session key', () => {
    const cmd = buildRopeProbeCommand('machine-a', 'n-1') as {
      type: string;
      session: string;
      messageId: string;
      ownershipEpoch: number;
      senderEnvelope?: { userId?: number };
    };
    expect(cmd.type).toBe('deliverMessage');
    // Non-numeric session: no topic-shaped consumer (Number(session)-gated spawn/
    // working-set triggers) can ever act on a probe.
    expect(cmd.session.startsWith(ROPE_PROBE_SESSION_PREFIX)).toBe(true);
    expect(Number.isFinite(Number(cmd.session))).toBe(false);
    expect(cmd.ownershipEpoch).toBe(0);
    // The bogus uid the peer's sender re-validation refuses.
    expect(cmd.senderEnvelope?.userId).toBe(ROPE_PROBE_BOGUS_UID);
    expect(cmd.messageId).toContain('machine-a');
    expect(cmd.messageId).toContain('n-1');
  });
});
