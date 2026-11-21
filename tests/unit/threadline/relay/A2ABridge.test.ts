import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  A2ABridge,
  A2ABridgeRateLimiter,
  ContextThreadMapper,
} from '../../../../src/threadline/relay/A2ABridge.js';
import { PresenceRegistry } from '../../../../src/threadline/relay/PresenceRegistry.js';
import type { MessageEnvelope } from '../../../../src/threadline/relay/types.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Valid hex agent IDs (fingerprints are hex-encoded)
const AGENT_ID = 'a1b2c3d4e5f60000';
const HIDDEN_AGENT_ID = 'deadbeef12345678';

describe('A2ABridge', () => {
  let bridge: A2ABridge;
  let presence: PresenceRegistry;
  let rateLimiter: A2ABridgeRateLimiter;
  let sentEnvelopes: Array<{ agentId: string; envelope: MessageEnvelope }>;
  let responseHandlers: Map<string, (envelope: MessageEnvelope) => void>;

  beforeEach(() => {
    presence = new PresenceRegistry();
    rateLimiter = new A2ABridgeRateLimiter({
      requestsPerMinutePerIP: 100,
      requestsPerHourPerIP: 1000,
    });
    sentEnvelopes = [];
    responseHandlers = new Map();

    bridge = new A2ABridge(
      { baseUrl: 'http://localhost:8787' },
      {
        presence,
        rateLimiter,
        sendToAgent: (agentId, envelope) => {
          sentEnvelopes.push({ agentId, envelope });
          return true;
        },
        onAgentResponse: (taskId, handler) => {
          responseHandlers.set(taskId, handler);
        },
        removeResponseHandler: (taskId) => {
          responseHandlers.delete(taskId);
        },
      },
    );

    // Register a test agent with a valid hex ID
    presence.register(
      AGENT_ID,
      Buffer.from('test-pub-key-32bytes-padded00000').toString('base64'),
      {
        name: 'test-agent',
        framework: 'instar',
        capabilities: ['conversation', 'code-review'],
        version: '1.0.0',
      },
      'public',
      'session-1',
    );
  });

  afterEach(() => {
    bridge.destroy();
  });

  // Helper to create mock req/res with proper event emitter behavior
  const mockReq = (method: string, body?: string, ip?: string) => {
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    const req = {
      method,
      headers: { host: 'localhost:8787' },
      socket: { remoteAddress: ip ?? '127.0.0.1' },
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(cb);
        return req;
      }),
      destroy: vi.fn(),
    } as unknown as IncomingMessage;

    // Fire data + end events asynchronously (after readBody sets up listeners)
    queueMicrotask(() => {
      if (body && listeners['data']) {
        for (const cb of listeners['data']) cb(Buffer.from(body));
      }
      if (listeners['end']) {
        for (const cb of listeners['end']) cb();
      }
    });

    return req;
  };

  const mockRes = () => {
    const chunks: string[] = [];
    const res = {
      writeHead: vi.fn(),
      end: vi.fn((data?: string) => { if (data) chunks.push(data); }),
      getBody: () => chunks.join(''),
      getJson: () => JSON.parse(chunks.join('')),
    } as unknown as ServerResponse & { getBody: () => string; getJson: () => unknown };
    return res;
  };

  describe('Agent Card', () => {
    it('returns agent card for public agent', async () => {
      const req = mockReq('GET');
      const res = mockRes();

      const handled = await bridge.handleRequest(req, res, `/a2a/${AGENT_ID}/.well-known/agent-card.json`);
      expect(handled).toBe(true);
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));

      const card = res.getJson();
      expect(card).toHaveProperty('name', 'test-agent');
      expect(card).toHaveProperty('url', `http://localhost:8787/a2a/${AGENT_ID}`);
      expect(card).toHaveProperty('skills');
      expect(card).toHaveProperty('extensions.threadline');
    });

    it('returns 404 for unknown agent', async () => {
      const req = mockReq('GET');
      const res = mockRes();

      await bridge.handleRequest(req, res, '/a2a/0000000000000000/.well-known/agent-card.json');
      expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

    it('returns 404 for non-public agent', async () => {
      presence.register(HIDDEN_AGENT_ID, 'key', { name: 'Hidden' }, 'unlisted', 's2');

      const req = mockReq('GET');
      const res = mockRes();

      await bridge.handleRequest(req, res, `/a2a/${HIDDEN_AGENT_ID}/.well-known/agent-card.json`);
      expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

    it('includes capabilities as skills', async () => {
      const req = mockReq('GET');
      const res = mockRes();

      await bridge.handleRequest(req, res, `/a2a/${AGENT_ID}/.well-known/agent-card.json`);
      const card = res.getJson() as { skills: Array<{ id: string }> };
      const skillIds = card.skills.map((s: { id: string }) => s.id);
      expect(skillIds).toContain('conversation');
      expect(skillIds).toContain('code-review');
    });
  });

  describe('Message sending', () => {
    it('forwards A2A message to Threadline agent', async () => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-1',
        method: 'message/send',
        params: {
          message: {
            role: 'user',
            parts: [{ type: 'text', text: 'Hello from A2A!' }],
          },
        },
      });

      const req = mockReq('POST', body);
      const res = mockRes();

      // Start the request handling (it will wait for agent response)
      const handlePromise = bridge.handleRequest(req, res, `/a2a/${AGENT_ID}/messages`);

      // Wait for the envelope to be sent
      await new Promise(r => setTimeout(r, 50));
      expect(sentEnvelopes).toHaveLength(1);
      expect(sentEnvelopes[0].agentId).toBe(AGENT_ID);

      // Simulate agent response
      const envelope = sentEnvelopes[0].envelope;
      bridge.handleAgentResponse({
        from: AGENT_ID,
        to: bridge.bridgeFingerprint,
        threadId: envelope.threadId,
        messageId: 'response-1',
        timestamp: new Date().toISOString(),
        nonce: '',
        ephemeralPubKey: '',
        salt: '',
        payload: Buffer.from('Agent response text').toString('base64'),
        signature: '',
      });

      await handlePromise;

      const response = res.getJson() as { jsonrpc: string; id: string; result: { status: string } };
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe('req-1');
      expect(response.result.status).toBe('completed');
    });

    it('returns error for unknown agent', async () => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-2',
        method: 'message/send',
        params: {
          message: { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
        },
      });

      const req = mockReq('POST', body);
      const res = mockRes();

      await bridge.handleRequest(req, res, '/a2a/0000000000000000/messages');
      expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });

    it('returns error for invalid JSON', async () => {
      const req = mockReq('POST', 'not json');
      const res = mockRes();

      await bridge.handleRequest(req, res, `/a2a/${AGENT_ID}/messages`);
      const response = res.getJson() as { error: { code: number } };
      expect(response.error.code).toBe(-32700);
    });

    it('returns error for missing message parts', async () => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-3',
        method: 'message/send',
        params: { message: {} },
      });

      const req = mockReq('POST', body);
      const res = mockRes();

      await bridge.handleRequest(req, res, `/a2a/${AGENT_ID}/messages`);
      const response = res.getJson() as { error: { code: number } };
      expect(response.error.code).toBe(-32602);
    });

    it('returns error for unsupported method', async () => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-4',
        method: 'unknown/method',
        params: {},
      });

      const req = mockReq('POST', body);
      const res = mockRes();

      await bridge.handleRequest(req, res, `/a2a/${AGENT_ID}/messages`);
      const response = res.getJson() as { error: { code: number } };
      expect(response.error.code).toBe(-32601);
    });

    it('includes transport metadata in forwarded envelope', async () => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-5',
        method: 'message/send',
        params: {
          message: { role: 'user', parts: [{ type: 'text', text: 'Test' }] },
          contextId: 'ctx-1',
        },
      });

      const req = mockReq('POST', body);
      const res = mockRes();

      const handlePromise = bridge.handleRequest(req, res, `/a2a/${AGENT_ID}/messages`);
      await new Promise(r => setTimeout(r, 50));

      expect(sentEnvelopes).toHaveLength(1);
      const payload = JSON.parse(Buffer.from(sentEnvelopes[0].envelope.payload, 'base64').toString());
      expect(payload.metadata.transport).toBe('a2a-bridge');
      expect(payload.metadata.contextId).toBe('ctx-1');
      expect(payload.content).toBe('Test');

      // Clean up
      bridge.handleAgentResponse({
        from: AGENT_ID,
        to: bridge.bridgeFingerprint,
        threadId: sentEnvelopes[0].envelope.threadId,
        messageId: 'r1',
        timestamp: new Date().toISOString(),
        nonce: '', ephemeralPubKey: '', salt: '',
        payload: Buffer.from('ok').toString('base64'),
        signature: '',
      });
      await handlePromise;
    });
  });

  describe('Context ID mapping', () => {
    it('maps same contextId to same threadId', async () => {
      const makeRequest = () => JSON.stringify({
        jsonrpc: '2.0',
        id: 'req',
        method: 'message/send',
        params: {
          message: { role: 'user', parts: [{ type: 'text', text: 'msg' }] },
          contextId: 'persistent-ctx',
        },
      });

      // First request
      const req1 = mockReq('POST', makeRequest());
      const res1 = mockRes();
      const p1 = bridge.handleRequest(req1, res1, `/a2a/${AGENT_ID}/messages`);
      await new Promise(r => setTimeout(r, 50));
      const threadId1 = sentEnvelopes[0].envelope.threadId;

      // Respond
      bridge.handleAgentResponse({
        from: AGENT_ID, to: bridge.bridgeFingerprint,
        threadId: threadId1, messageId: 'r1', timestamp: new Date().toISOString(),
        nonce: '', ephemeralPubKey: '', salt: '',
        payload: Buffer.from('ok').toString('base64'), signature: '',
      });
      await p1;

      // Second request with same contextId
      const req2 = mockReq('POST', makeRequest());
      const res2 = mockRes();
      const p2 = bridge.handleRequest(req2, res2, `/a2a/${AGENT_ID}/messages`);
      await new Promise(r => setTimeout(r, 50));
      const threadId2 = sentEnvelopes[1].envelope.threadId;

      expect(threadId2).toBe(threadId1); // Same thread!

      bridge.handleAgentResponse({
        from: AGENT_ID, to: bridge.bridgeFingerprint,
        threadId: threadId2, messageId: 'r2', timestamp: new Date().toISOString(),
        nonce: '', ephemeralPubKey: '', salt: '',
        payload: Buffer.from('ok2').toString('base64'), signature: '',
      });
      await p2;
    });

    const sendBody = (contextId: unknown) => JSON.stringify({
      jsonrpc: '2.0', id: 'req', method: 'message/send',
      params: { message: { role: 'user', parts: [{ type: 'text', text: 'msg' }] }, contextId },
    });

    it('SEC-134: the same contextId from a different caller does not join the first caller thread', async () => {
      const p1 = bridge.handleRequest(mockReq('POST', sendBody('shared-ctx'), '10.0.0.1'), mockRes(), `/a2a/${AGENT_ID}/messages`);
      await new Promise(r => setTimeout(r, 50));
      const p2 = bridge.handleRequest(mockReq('POST', sendBody('shared-ctx'), '10.0.0.2'), mockRes(), `/a2a/${AGENT_ID}/messages`);
      await new Promise(r => setTimeout(r, 50));
      expect(sentEnvelopes).toHaveLength(2);
      expect(sentEnvelopes[1].envelope.threadId).not.toBe(sentEnvelopes[0].envelope.threadId);
      bridge.destroy();
      await Promise.all([p1, p2]);
    });

    it('SEC-134: the same caller and contextId keep their thread; a different agent gets its own', async () => {
      presence.register(
        'b2c3d4e5f6070000',
        Buffer.from('test-pub-key-32bytes-padded00001').toString('base64'),
        { name: 'agent-two', framework: 'instar', capabilities: [], version: '1.0.0' },
        'public',
        'session-2',
      );
      const ps = [
        bridge.handleRequest(mockReq('POST', sendBody('keep-ctx'), '10.0.0.5'), mockRes(), `/a2a/${AGENT_ID}/messages`),
      ];
      await new Promise(r => setTimeout(r, 30));
      ps.push(bridge.handleRequest(mockReq('POST', sendBody('keep-ctx'), '10.0.0.5'), mockRes(), `/a2a/${AGENT_ID}/messages`));
      await new Promise(r => setTimeout(r, 30));
      ps.push(bridge.handleRequest(mockReq('POST', sendBody('keep-ctx'), '10.0.0.5'), mockRes(), '/a2a/b2c3d4e5f6070000/messages'));
      await new Promise(r => setTimeout(r, 30));
      expect(sentEnvelopes).toHaveLength(3);
      const meta = (i: number) => JSON.parse(Buffer.from(sentEnvelopes[i].envelope.payload, 'base64').toString()).metadata;
      expect(sentEnvelopes[1].envelope.threadId).toBe(sentEnvelopes[0].envelope.threadId);
      expect(meta(1).isNewThread).toBe(false);
      expect(sentEnvelopes[2].envelope.threadId).not.toBe(sentEnvelopes[0].envelope.threadId);
      bridge.destroy();
      await Promise.all(ps);
    });

    it('SEC-134: a forwarded address that is not an IP falls back to the socket address', async () => {
      const req = mockReq('POST', sendBody('xff-ctx'), '10.0.0.7');
      (req.headers as Record<string, string>)['x-forwarded-for'] = 'x'.repeat(5000);
      const p = bridge.handleRequest(req, mockRes(), `/a2a/${AGENT_ID}/messages`);
      await new Promise(r => setTimeout(r, 30));
      const req2 = mockReq('POST', sendBody('xff-ctx'), '10.0.0.7');
      const p2 = bridge.handleRequest(req2, mockRes(), `/a2a/${AGENT_ID}/messages`);
      await new Promise(r => setTimeout(r, 30));
      expect(sentEnvelopes[1].envelope.threadId).toBe(sentEnvelopes[0].envelope.threadId);
      bridge.destroy();
      await Promise.all([p, p2]);
    });

    it('SEC-134: refuses a contextId that is too long or not text', async () => {
      for (const bad of ['x'.repeat(257), 42]) {
        const res = mockRes();
        await bridge.handleRequest(mockReq('POST', sendBody(bad)), res, `/a2a/${AGENT_ID}/messages`);
        expect((res as unknown as { getJson: () => { error: { code: number } } }).getJson().error.code).toBe(-32602);
      }
      expect(sentEnvelopes).toHaveLength(0);
    });
  });

  describe('Task management', () => {
    it('handles task status query', async () => {
      // Create a pending task first
      const body = JSON.stringify({
        jsonrpc: '2.0', id: 'req', method: 'message/send',
        params: { message: { role: 'user', parts: [{ type: 'text', text: 'msg' }] } },
      });
      const req = mockReq('POST', body);
      const res = mockRes();
      bridge.handleRequest(req, res, `/a2a/${AGENT_ID}/messages`);
      await new Promise(r => setTimeout(r, 50));

      // Extract task ID from the envelope metadata
      const payload = JSON.parse(Buffer.from(sentEnvelopes[0].envelope.payload, 'base64').toString());
      const taskId = payload.metadata.a2aTaskId;

      // Query task status
      const statusReq = mockReq('GET');
      const statusRes = mockRes();
      await bridge.handleRequest(statusReq, statusRes, `/a2a/${AGENT_ID}/tasks/${taskId}`);
      const status = statusRes.getJson() as { result: { status: string } };
      expect(status.result.status).toBe('submitted');

      // Clean up
      bridge.destroy();
    });

    it('handles task cancellation', async () => {
      const body = JSON.stringify({
        jsonrpc: '2.0', id: 'req', method: 'message/send',
        params: { message: { role: 'user', parts: [{ type: 'text', text: 'msg' }] } },
      });
      const req = mockReq('POST', body);
      const res = mockRes();
      const handlePromise = bridge.handleRequest(req, res, `/a2a/${AGENT_ID}/messages`);
      await new Promise(r => setTimeout(r, 50));

      const payload = JSON.parse(Buffer.from(sentEnvelopes[0].envelope.payload, 'base64').toString());
      const taskId = payload.metadata.a2aTaskId;

      // Cancel the task
      const cancelReq = mockReq('POST');
      const cancelRes = mockRes();
      await bridge.handleRequest(cancelReq, cancelRes, `/a2a/${AGENT_ID}/tasks/${taskId}:cancel`);

      const cancelResult = cancelRes.getJson() as { result: { status: string } };
      expect(cancelResult.result.status).toBe('canceled');

      // Original request should resolve
      await handlePromise;
      const response = res.getJson() as { result: { status: string } };
      expect(response.result.status).toBe('canceled');
    });
  });

  describe('Rate limiting', () => {
    it('rate limits excessive requests', async () => {
      const strictLimiter = new A2ABridgeRateLimiter({
        requestsPerMinutePerIP: 2,
        requestsPerHourPerIP: 10,
      });

      const strictBridge = new A2ABridge(
        { baseUrl: 'http://localhost:8787' },
        {
          presence,
          rateLimiter: strictLimiter,
          sendToAgent: () => true,
          onAgentResponse: () => {},
          removeResponseHandler: () => {},
        },
      );

      // Use up the limit
      strictLimiter.record('1.2.3.4');
      strictLimiter.record('1.2.3.4');

      const req = mockReq('POST', '{}', '1.2.3.4');
      const res = mockRes();
      await strictBridge.handleRequest(req, res, `/a2a/${AGENT_ID}/messages`);
      expect(res.writeHead).toHaveBeenCalledWith(429, expect.any(Object));

      strictBridge.destroy();
    });
  });

  describe('Concurrent task limits', () => {
    it('rejects when concurrent task limit exceeded', async () => {
      // Create a bridge with limit of 1 concurrent task
      const limitedBridge = new A2ABridge(
        { baseUrl: 'http://localhost:8787', maxConcurrentTasksPerAgent: 1 },
        {
          presence,
          rateLimiter,
          sendToAgent: () => true,
          onAgentResponse: () => {},
          removeResponseHandler: () => {},
        },
      );

      const makeBody = () => JSON.stringify({
        jsonrpc: '2.0', id: 'req', method: 'message/send',
        params: { message: { role: 'user', parts: [{ type: 'text', text: 'msg' }] } },
      });

      // First task — should succeed
      const req1 = mockReq('POST', makeBody());
      const res1 = mockRes();
      limitedBridge.handleRequest(req1, res1, `/a2a/${AGENT_ID}/messages`);
      await new Promise(r => setTimeout(r, 50));

      // Second task — should be rejected
      const req2 = mockReq('POST', makeBody());
      const res2 = mockRes();
      await limitedBridge.handleRequest(req2, res2, `/a2a/${AGENT_ID}/messages`);
      expect(res2.writeHead).toHaveBeenCalledWith(429, expect.any(Object));

      limitedBridge.destroy();
    });
  });

  describe('Routing', () => {
    it('returns false for non-A2A paths', async () => {
      const req = mockReq('GET');
      const res = mockRes();
      const handled = await bridge.handleRequest(req, res, '/health');
      expect(handled).toBe(false);
    });

    it('returns 404 for unknown A2A subpaths', async () => {
      const req = mockReq('GET');
      const res = mockRes();
      await bridge.handleRequest(req, res, `/a2a/${AGENT_ID}/unknown-path`);
      expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    });
  });
});

describe('A2ABridgeRateLimiter', () => {
  it('allows requests within limits', () => {
    const limiter = new A2ABridgeRateLimiter({ requestsPerMinutePerIP: 5, requestsPerHourPerIP: 50 });
    expect(limiter.check('1.2.3.4').allowed).toBe(true);
  });

  it('blocks after minute limit exceeded', () => {
    const limiter = new A2ABridgeRateLimiter({ requestsPerMinutePerIP: 2, requestsPerHourPerIP: 50 });
    limiter.record('1.2.3.4');
    limiter.record('1.2.3.4');
    expect(limiter.check('1.2.3.4').allowed).toBe(false);
    expect(limiter.check('1.2.3.4').limitType).toBe('per_ip_minute');
  });

  it('different IPs are independent', () => {
    const limiter = new A2ABridgeRateLimiter({ requestsPerMinutePerIP: 1, requestsPerHourPerIP: 50 });
    limiter.record('1.2.3.4');
    expect(limiter.check('1.2.3.4').allowed).toBe(false);
    expect(limiter.check('5.6.7.8').allowed).toBe(true);
  });

  it('reset clears all limits', () => {
    const limiter = new A2ABridgeRateLimiter({ requestsPerMinutePerIP: 1, requestsPerHourPerIP: 50 });
    limiter.record('1.2.3.4');
    expect(limiter.check('1.2.3.4').allowed).toBe(false);
    limiter.reset();
    expect(limiter.check('1.2.3.4').allowed).toBe(true);
  });
});

describe('SEC-134: bridge state stays bounded', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('the rate limiter forgets a caller once its windows have passed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T00:00:00Z'));
    const limiter = new A2ABridgeRateLimiter();
    for (let i = 0; i < 500; i++) { limiter.check(`10.0.${i >> 8}.${i & 255}`); limiter.record(`10.0.${i >> 8}.${i & 255}`); }
    expect(limiter.size).toBe(1000);
    vi.setSystemTime(new Date('2026-11-20T01:01:00Z'));
    limiter.check('192.0.2.1');
    expect(limiter.size).toBe(0);
  });

  it('the sweep never lifts a limit whose hour window is still active', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T00:00:00Z'));
    const limiter = new A2ABridgeRateLimiter({ requestsPerMinutePerIP: 100, requestsPerHourPerIP: 2 });
    limiter.record('203.0.113.9'); limiter.record('203.0.113.9');
    expect(limiter.check('203.0.113.9').allowed).toBe(false);
    vi.setSystemTime(new Date('2026-11-20T00:59:00Z'));
    limiter.check('192.0.2.1'); // triggers a sweep
    expect(limiter.check('203.0.113.9')).toEqual({ allowed: false, limitType: 'per_ip_hour' });
  });

  it('keeps at most MAX_KEYS keys however many addresses are used', () => {
    const limiter = new A2ABridgeRateLimiter();
    const n = A2ABridgeRateLimiter.MAX_KEYS / 2 + 500;
    for (let i = 0; i < n; i++) limiter.record(`2001:db8::${i.toString(16)}`);
    expect(limiter.size).toBeLessThanOrEqual(A2ABridgeRateLimiter.MAX_KEYS);
  });

  it('a check alone never creates a key', () => {
    const limiter = new A2ABridgeRateLimiter();
    for (let i = 0; i < 100; i++) limiter.check(`198.51.100.${i}`);
    expect(limiter.size).toBe(0);
  });

  it('the context map keeps at most maxEntries, dropping the least recently used', () => {
    const map = new ContextThreadMapper(3, 60_000);
    const a = map.getOrCreateThreadId('s', 'a', 0).threadId;
    map.getOrCreateThreadId('s', 'b', 1);
    map.getOrCreateThreadId('s', 'c', 2);
    expect(map.getOrCreateThreadId('s', 'a', 3)).toEqual({ threadId: a, isNew: false });
    map.getOrCreateThreadId('s', 'd', 4);
    expect(map.size).toBe(3);
    expect(map.getOrCreateThreadId('s', 'b', 5).isNew).toBe(true);
    expect(map.getOrCreateThreadId('s', 'a', 6)).toEqual({ threadId: a, isNew: false });
  });

  it('a mapping unused past its lifetime starts a new thread', () => {
    const map = new ContextThreadMapper(10, 1_000);
    const first = map.getOrCreateThreadId('s', 'ctx', 0).threadId;
    expect(map.getOrCreateThreadId('s', 'ctx', 900).threadId).toBe(first);
    expect(map.getOrCreateThreadId('s', 'ctx', 2_000).isNew).toBe(true);
  });

  it('a message without a contextId is not stored', () => {
    const map = new ContextThreadMapper();
    for (let i = 0; i < 50; i++) map.getOrCreateThreadId('s', undefined);
    expect(map.size).toBe(0);
  });
});
