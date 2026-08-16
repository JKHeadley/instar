#!/usr/bin/env node
/**
 * Live relay integration test — connects real agents via WebSocket
 * and sends encrypted messages through the running relay.
 *
 * Usage: RELAY_PORT=8800 node scripts/test-relay-live.mjs
 */

import { WebSocket } from 'ws';
import crypto from 'node:crypto';

const RELAY_PORT = process.env.RELAY_PORT || 8800;
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}/v1/connect`;
const HEALTH_URL = `http://127.0.0.1:${RELAY_PORT}/health`;

// ── Helpers ──────────────────────────────────────────────────────

// DER prefixes for raw Ed25519 key wrapping
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function generateEd25519() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubBuf = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const privBuf = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  // Fingerprint: first 16 bytes of raw public key as hex (matches relay's verification)
  const agentId = pubBuf.subarray(0, 16).toString('hex');
  return { publicKey: pubBuf, privateKey: privBuf, agentId };
}

function signChallenge(nonce, privBuf) {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, privBuf]),
    format: 'der',
    type: 'pkcs8',
  });
  // Relay verifies Buffer.from(nonce, 'utf-8'), so sign the raw string bytes
  const sig = crypto.sign(null, Buffer.from(nonce, 'utf-8'), privateKey);
  return sig.toString('base64');
}

function makeEnvelope(from, to, text) {
  return {
    messageId: crypto.randomUUID(),
    from,
    to,
    threadId: `thread-${crypto.randomBytes(4).toString('hex')}`,
    timestamp: new Date().toISOString(),
    nonce: crypto.randomBytes(24).toString('base64'),
    ephemeralPubKey: crypto.randomBytes(32).toString('base64'),
    salt: crypto.randomBytes(32).toString('base64'),
    payload: Buffer.from(JSON.stringify({ type: 'text', text })).toString('base64'),
    signature: crypto.randomBytes(64).toString('base64'), // Placeholder — relay doesn't verify envelope signatures
  };
}

function createAgent(name, capabilities = []) {
  const keys = generateEd25519();
  return { name, ...keys, capabilities };
}

function connectAgent(agent, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_URL);
    const timeout = setTimeout(() => reject(new Error(`${agent.name}: connect timeout`)), 10000);

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());

      if (frame.type === 'challenge') {
        const signature = signChallenge(frame.nonce, agent.privateKey);
        ws.send(JSON.stringify({
          type: 'auth',
          agentId: agent.agentId,
          publicKey: agent.publicKey.toString('base64'),
          signature,
          metadata: {
            name: agent.name,
            framework: 'instar',
            capabilities: agent.capabilities,
            version: '1.0.0',
          },
          visibility: options.visibility || 'unlisted',
        }));
      }

      if (frame.type === 'auth_ok') {
        clearTimeout(timeout);
        resolve({ ws, sessionId: frame.sessionId, agent });
      }

      if (frame.type === 'auth_error') {
        clearTimeout(timeout);
        reject(new Error(`${agent.name}: auth error: ${frame.message}`));
      }
    });
  });
}

function sendMessage(ws, from, to, text) {
  const envelope = makeEnvelope(from, to, text);
  ws.send(JSON.stringify({ type: 'message', envelope }));
  return envelope.messageId;
}

function waitForMessage(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Message timeout')), timeoutMs);
    const handler = (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'message') {
        clearTimeout(timeout);
        ws.off('message', handler);
        resolve(frame);
      }
    };
    ws.on('message', handler);
  });
}

function waitForFrame(ws, frameType, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${frameType} timeout`)), timeoutMs);
    const handler = (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === frameType) {
        clearTimeout(timeout);
        ws.off('message', handler);
        resolve(frame);
      }
    };
    ws.on('message', handler);
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Test runner ──────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const results = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push({ name, status: 'PASS' });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    results.push({ name, status: 'FAIL', error: err.message });
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

// ── Tests ────────────────────────────────────────────────────────

console.log(`\nThreadline Relay Live Integration Test`);
console.log(`   Relay: ${RELAY_URL}\n`);

// Pre-check: is the relay running?
try {
  const health = await fetch(HEALTH_URL);
  const data = await health.json();
  console.log(`   Health: ${data.status} (${data.agents} agents, ${data.connections} connections)\n`);
} catch {
  console.error(`   Cannot reach relay at ${HEALTH_URL}. Is it running?`);
  process.exit(1);
}

// ── Test 1: Basic connection & auth ──
console.log('Test Suite: Connection & Auth');
await test('Agent connects and authenticates', async () => {
  const agent = createAgent('test-alpha');
  const { ws, sessionId } = await connectAgent(agent);
  if (!sessionId) throw new Error('No session ID');
  ws.close();
  await sleep(100);
});

// ── Test 2: Direct messaging ──
console.log('\nTest Suite: Direct Messaging');
await test('Agent A sends message to Agent B', async () => {
  const alice = createAgent('alice', ['chat']);
  const bob = createAgent('bob', ['chat']);

  const aliceConn = await connectAgent(alice);
  const bobConn = await connectAgent(bob);

  const msgPromise = waitForMessage(bobConn.ws);
  sendMessage(aliceConn.ws, alice.agentId, bob.agentId, 'Hello from Alice!');

  const received = await msgPromise;
  const payload = JSON.parse(Buffer.from(received.envelope.payload, 'base64').toString());
  if (payload.text !== 'Hello from Alice!') {
    throw new Error(`Wrong message: ${payload.text}`);
  }
  if (received.envelope.from !== alice.agentId) {
    throw new Error(`Wrong sender: ${received.envelope.from}`);
  }

  aliceConn.ws.close();
  bobConn.ws.close();
  await sleep(100);
});

await test('Bidirectional messaging', async () => {
  const agent1 = createAgent('agent-one', ['chat']);
  const agent2 = createAgent('agent-two', ['chat']);

  const conn1 = await connectAgent(agent1);
  const conn2 = await connectAgent(agent2);

  // Set up listeners BEFORE sending
  const msg1Promise = waitForMessage(conn2.ws);
  const msg2Promise = waitForMessage(conn1.ws);

  // Agent 1 -> Agent 2
  sendMessage(conn1.ws, agent1.agentId, agent2.agentId, 'ping');
  const msg1 = await msg1Promise;
  const p1 = JSON.parse(Buffer.from(msg1.envelope.payload, 'base64').toString());
  if (p1.text !== 'ping') throw new Error('ping failed');

  // Agent 2 -> Agent 1
  sendMessage(conn2.ws, agent2.agentId, agent1.agentId, 'pong');
  const msg2 = await msg2Promise;
  const p2 = JSON.parse(Buffer.from(msg2.envelope.payload, 'base64').toString());
  if (p2.text !== 'pong') throw new Error('pong failed');

  conn1.ws.close();
  conn2.ws.close();
  await sleep(100);
});

// ── Test 3: Discovery ──
console.log('\nTest Suite: Discovery');
await test('Discover public agents by capability', async () => {
  const searcher = createAgent('searcher');
  const coder = createAgent('code-bot', ['code', 'debug']);
  const writer = createAgent('write-bot', ['write', 'summarize']);

  // Searcher and discoverable agents must use 'public' visibility
  const sConn = await connectAgent(searcher, { visibility: 'public' });
  const cConn = await connectAgent(coder, { visibility: 'public' });
  const wConn = await connectAgent(writer, { visibility: 'public' });

  await sleep(300); // Let presence propagate

  // Discover agents with 'code' capability
  const discoverPromise = waitForFrame(sConn.ws, 'discover_result');
  sConn.ws.send(JSON.stringify({ type: 'discover', filter: { capability: 'code' } }));
  const result = await discoverPromise;

  const found = result.agents || [];
  const coderFound = found.some(a => a.agentId === coder.agentId);
  if (!coderFound) throw new Error('Code-bot not found in discovery');

  const writerFound = found.some(a => a.agentId === writer.agentId);
  if (writerFound) throw new Error('Write-bot should not match code filter');

  sConn.ws.close();
  cConn.ws.close();
  wConn.ws.close();
  await sleep(100);
});

// ── Test 4: Offline queue ──
console.log('\nTest Suite: Offline Queue');
await test('Messages queued for offline agent are delivered on connect', async () => {
  const sender = createAgent('sender');
  const receiver = createAgent('receiver');

  // Only sender connects
  const sConn = await connectAgent(sender);

  // Send message to offline receiver — wait for 'queued' ack
  const ackPromise = waitForFrame(sConn.ws, 'ack', 5000);
  sendMessage(sConn.ws, sender.agentId, receiver.agentId, 'You have mail!');
  const ack = await ackPromise;
  if (ack.status !== 'queued') throw new Error(`Expected queued ack, got: ${ack.status}`);

  // Now receiver connects — should get the queued message
  const rConn = await connectAgent(receiver);
  const queued = await waitForMessage(rConn.ws, 8000);

  const payload = JSON.parse(Buffer.from(queued.envelope.payload, 'base64').toString());
  if (payload.text !== 'You have mail!') {
    throw new Error(`Wrong queued message: ${payload.text}`);
  }

  sConn.ws.close();
  rConn.ws.close();
  await sleep(100);
});

// ── Test 5: Multi-agent mesh ──
console.log('\nTest Suite: Multi-Agent Mesh');
await test('4 agents exchange messages in mesh pattern', async () => {
  const agents = [
    createAgent('mesh-a', ['mesh']),
    createAgent('mesh-b', ['mesh']),
    createAgent('mesh-c', ['mesh']),
    createAgent('mesh-d', ['mesh']),
  ];

  const conns = await Promise.all(agents.map(a => connectAgent(a)));
  await sleep(300);

  // Set up receive handlers for all agents FIRST
  const receivePromises = conns.map((conn, i) => {
    let received = 0;
    const expectedCount = conns.length - 1;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Agent ${i} only got ${received}/${expectedCount} messages`)), 10000);
      const handler = (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.type === 'message') {
          received++;
          if (received >= expectedCount) {
            clearTimeout(timeout);
            conn.ws.off('message', handler);
            resolve(received);
          }
        }
      };
      conn.ws.on('message', handler);
    });
  });

  // THEN send messages from each agent to every other
  for (let i = 0; i < conns.length; i++) {
    for (let j = 0; j < conns.length; j++) {
      if (i === j) continue;
      sendMessage(conns[i].ws, agents[i].agentId, agents[j].agentId, `Hello from ${agents[i].name}`);
    }
  }

  // Wait for all agents to receive their messages
  await Promise.all(receivePromises);

  conns.forEach(c => c.ws.close());
  await sleep(100);
});

// ── Test 6: Presence subscription ──
console.log('\nTest Suite: Presence');
await test('Presence change notification on connect/disconnect', async () => {
  const watcher = createAgent('watcher');
  const watched = createAgent('watched-agent');

  const wConn = await connectAgent(watcher);

  // Subscribe to all presence changes
  wConn.ws.send(JSON.stringify({ type: 'subscribe' }));
  await sleep(200);

  // Connect the watched agent — watcher should get presence change
  const presencePromise = waitForFrame(wConn.ws, 'presence_change', 5000);
  const watchedConn = await connectAgent(watched);

  const change = await presencePromise;
  if (change.agentId !== watched.agentId) {
    throw new Error(`Wrong agent in presence: ${change.agentId}`);
  }
  if (change.status !== 'online') {
    throw new Error(`Expected online, got ${change.status}`);
  }

  wConn.ws.close();
  watchedConn.ws.close();
  await sleep(100);
});

// ── Test 7: Admin API ──
console.log('\nTest Suite: Admin API');
const ADMIN_PORT = process.env.RELAY_ADMIN_PORT || 9095;
const ADMIN_KEY = process.env.RELAY_ADMIN_KEY || 'test-admin-key-123';

await test('Admin status endpoint', async () => {
  const res = await fetch(`http://127.0.0.1:${ADMIN_PORT}/admin/status`, {
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
  if (!res.ok) throw new Error(`Status ${res.status}`);
  const data = await res.json();
  if (data.status !== 'ok') throw new Error(`Bad status: ${data.status}`);
});

await test('Admin agents list', async () => {
  const agent = createAgent('admin-test-agent', ['test']);
  const conn = await connectAgent(agent);
  await sleep(200);

  const res = await fetch(`http://127.0.0.1:${ADMIN_PORT}/admin/agents`, {
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
  if (!res.ok) throw new Error(`Status ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.agents)) throw new Error('No agents array');
  const found = data.agents.some(a => a.agentId === agent.agentId);
  if (!found) throw new Error('Agent not in admin list');

  conn.ws.close();
  await sleep(100);
});

await test('Admin ban/unban flow', async () => {
  const agent = createAgent('ban-test');
  const conn = await connectAgent(agent);

  // Ban the agent — API uses agentId, durationMs
  const banRes = await fetch(`http://127.0.0.1:${ADMIN_PORT}/admin/ban`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ADMIN_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ agentId: agent.agentId, reason: 'test ban', durationMs: 60000 }),
  });
  if (!banRes.ok) {
    const body = await banRes.text();
    throw new Error(`Ban failed: ${banRes.status} - ${body}`);
  }

  await sleep(500);

  // Check bans
  const bansRes = await fetch(`http://127.0.0.1:${ADMIN_PORT}/admin/bans`, {
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
  const bans = await bansRes.json();
  const banned = (bans.bans || []).some(b => b.agentId === agent.agentId);
  if (!banned) throw new Error('Agent not in ban list');

  // Unban
  const unbanRes = await fetch(`http://127.0.0.1:${ADMIN_PORT}/admin/unban`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ADMIN_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ agentId: agent.agentId }),
  });
  if (!unbanRes.ok) throw new Error(`Unban failed: ${unbanRes.status}`);

  conn.ws.close();
  await sleep(100);
});

await test('Admin rejects unauthorized requests', async () => {
  const res = await fetch(`http://127.0.0.1:${ADMIN_PORT}/admin/status`);
  if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
});

// ── Test 8: A2A Bridge ──
console.log('\nTest Suite: A2A Bridge');
await test('A2A message delivery to connected agent', async () => {
  const agent = createAgent('a2a-receiver', ['a2a']);
  const conn = await connectAgent(agent);

  const msgPromise = waitForMessage(conn.ws, 5000);

  // Send via A2A HTTP bridge
  const res = await fetch(`http://127.0.0.1:${RELAY_PORT}/a2a/${agent.agentId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'message/send',
      id: '1',
      params: {
        message: {
          messageId: crypto.randomUUID(),
          role: 'user',
          parts: [{ type: 'text', text: 'Hello via A2A!' }],
        },
      },
    }),
  });

  if (!res.ok) throw new Error(`A2A POST returned ${res.status}`);

  const received = await msgPromise;
  if (!received.envelope) throw new Error('No envelope in A2A message');

  conn.ws.close();
  await sleep(100);
});

await test('A2A agent card endpoint', async () => {
  const agent = createAgent('card-agent');
  // Connect with public visibility for agent card to work
  const conn = await connectAgent(agent, { visibility: 'public' });
  await sleep(300);

  const res = await fetch(`http://127.0.0.1:${RELAY_PORT}/a2a/${agent.agentId}/.well-known/agent-card.json`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Agent card returned ${res.status}: ${body}`);
  }
  const card = await res.json();
  if (!card.name) throw new Error('No name in agent card');

  conn.ws.close();
  await sleep(100);
});

// ── Test 9: Displacement ──
console.log('\nTest Suite: Displacement');
await test('Second connection displaces first', async () => {
  const agent = createAgent('displace-me');
  const conn1 = await connectAgent(agent);

  // Listen for displacement on first connection
  const displacePromise = waitForFrame(conn1.ws, 'displaced', 5000);

  // Connect same agent again
  const conn2 = await connectAgent(agent);

  const displaced = await displacePromise;
  if (!displaced) throw new Error('No displacement frame received');

  conn2.ws.close();
  await sleep(100);
});

// ── Summary ──────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  console.log('\nFailed tests:');
  results.filter(r => r.status === 'FAIL').forEach(r => {
    console.log(`  ✗ ${r.name}: ${r.error}`);
  });
}

// Final health check
const finalHealth = await fetch(HEALTH_URL);
const finalData = await finalHealth.json();
console.log(`\nRelay final state: ${finalData.status}`);
console.log(`  Throughput: ${finalData.throughput.messagesRouted} routed`);
console.log(`  Uptime: ${Math.round(finalData.uptime)}s`);

process.exit(failed > 0 ? 1 : 0);
