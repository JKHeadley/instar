/**
 * The heartbeat's send-failure description + "topic is gone" classification.
 *
 * Reproduction (maturation review 2026-11-27): the fleet's "send failed" rows were
 * a bare `TypeError`. That is exactly what Node's fetch() throws when the local
 * POST /telegram/reply request itself breaks — reproduced here against a port
 * nothing listens on — and the cause (ECONNREFUSED) was being thrown away.
 */
import { describe, it, expect } from 'vitest';
import net from 'node:net';
import {
  AutonomousHeartbeatSendError,
  describeHeartbeatSendError,
  extractRouteErrorDetail,
  isHeartbeatTopicGone,
  SEND_ERROR_DETAIL_MAX,
} from '../../src/monitoring/autonomousHeartbeatSendError.js';

async function closedPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

describe('describeHeartbeatSendError', () => {
  it('reproduces the fleet TypeError: a broken local request names its cause', async () => {
    const port = await closedPort();
    let thrown: unknown;
    try {
      await fetch(`http://127.0.0.1:${port}/telegram/reply/147616`, { method: 'POST', body: '{}' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    const d = describeHeartbeatSendError(thrown);
    expect(d.errorName).toBe('TypeError');
    expect(d.causeCode).toBe('ECONNREFUSED');
    expect(d.errorMessage).toContain('fetch failed');
    expect(d.httpStatus).toBeUndefined();
    expect(isHeartbeatTopicGone(thrown)).toBe(false);
  });

  it('records the HTTP status and the route reason for a refusal', () => {
    const d = describeHeartbeatSendError(new AutonomousHeartbeatSendError(500, 'Bad Request: message thread not found'));
    expect(d).toMatchObject({ errorName: 'AutonomousHeartbeatSendError', httpStatus: 500 });
    expect(d.errorMessage).toContain('message thread not found');
  });

  it('scrubs secrets and keeps the description to one bounded line', () => {
    const token = 'ghp_' + 'a'.repeat(36);
    const d = describeHeartbeatSendError(new Error(`boom ${token}\n${'x'.repeat(400)}`));
    expect(d.errorMessage).not.toContain(token);
    expect(d.errorMessage).not.toContain('\n');
    expect(d.errorMessage.length).toBeLessThanOrEqual(SEND_ERROR_DETAIL_MAX);
  });

  it('describes a non-Error throw', () => {
    expect(describeHeartbeatSendError('nope')).toEqual({ errorName: 'unknown', errorMessage: 'nope' });
  });
});

describe('extractRouteErrorDetail', () => {
  it('reads the route error field, a non-JSON first line, or nothing', () => {
    expect(extractRouteErrorDetail('{"error":"Telegram not configured"}')).toBe('Telegram not configured');
    expect(extractRouteErrorDetail('{"message":"held"}')).toBe('held');
    expect(extractRouteErrorDetail('Bad Gateway\nmore')).toBe('Bad Gateway');
    expect(extractRouteErrorDetail('   ')).toBeNull();
  });
});

describe('isHeartbeatTopicGone', () => {
  it('is true only for a refusal saying the topic can no longer receive', () => {
    expect(isHeartbeatTopicGone(new AutonomousHeartbeatSendError(500, 'Bad Request: message thread not found'))).toBe(true);
    expect(isHeartbeatTopicGone(new AutonomousHeartbeatSendError(400, 'Bad Request: TOPIC_CLOSED'))).toBe(true);
    expect(isHeartbeatTopicGone(new AutonomousHeartbeatSendError(403, 'Forbidden: chat not found'))).toBe(true);
  });

  it('is false for passing refusals and for transport failures', () => {
    expect(isHeartbeatTopicGone(new AutonomousHeartbeatSendError(409, 'thread not found'))).toBe(false);
    expect(isHeartbeatTopicGone(new AutonomousHeartbeatSendError(503, 'topic closed'))).toBe(false);
    expect(isHeartbeatTopicGone(new AutonomousHeartbeatSendError(429, 'topic closed'))).toBe(false);
    expect(isHeartbeatTopicGone(new AutonomousHeartbeatSendError(500, 'internal error'))).toBe(false);
    expect(isHeartbeatTopicGone(new AutonomousHeartbeatSendError(500, null))).toBe(false);
    expect(isHeartbeatTopicGone(new TypeError('fetch failed'))).toBe(false);
  });
});
