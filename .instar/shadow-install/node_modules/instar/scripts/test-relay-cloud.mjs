#!/usr/bin/env node
/**
 * Cloud relay integration test — connects test agents to the live
 * relay at threadline-relay.fly.dev and verifies the full pipeline.
 *
 * Usage: node scripts/test-relay-cloud.mjs
 */

import { WebSocket } from 'ws';
import crypto from 'node:crypto';

const RELAY_URL = process.env.RELAY_URL || 'wss://threadline-relay.fly.dev/v1/connect';
const HEALTH_URL = process.env.HEALTH_URL || 'https://threadline-relay.fly.dev/health';

// ── Helpers ──────────────────────────────────────────────────────

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function generateEd25519() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubBuf = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const privBuf = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  const agentId = pubBuf.subarray(0, 16).toString('hex');
  return { publicKey: pubBuf, privateKey: privBuf, agentId };
}

function signChallenge(nonce, privBuf) {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, privBuf]),
    format: 'der',
    type: 'pkcs8',
  });
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
    signature: crypto.randomBytes(64).toString('base64'),
  };
}

function createAgent(name, capabilities = []) {
  const keys = generateEd25519();
  return { name, ...keys, capabilities };
}

function connectAgent(agent, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_URL);
    const timeout = setTimeout(() => reject(new Error(`${agent.name}: connect timeout`)), 15000);

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

function waitForMessage(ws, timeoutMs = 10000) {
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

function waitForFrame(ws, frameType, timeoutMs = 10000) {
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

console.log(`\nThreadline Relay CLOUD Integration Test`);
console.log(`   Relay: ${RELAY_URL}\n`);

// Pre-check
try {
  const health = await fetch(HEALTH_URL);
  const data = await health.json();
  console.log(`   Health: ${data.status} (${data.registry?.totalAgents || data.agents} registered, ${data.connections} connected)\n`);
} catch (e) {
  console.error(`   Cannot reach relay at ${HEALTH_URL}: ${e.message}`);
  process.exit(1);
}

// ── 1: Connection & Auth ──
console.log('Suite 1: Connection & Auth');

await test('Fresh agent connects and authenticates via WSS', async () => {
  const agent = createAgent('cloud-test-alpha');
  const { ws, sessionId } = await connectAgent(agent);
  if (!sessionId) throw new Error('No session ID');
  ws.close();
  await sleep(200);
});

await test('Invalid signature is rejected', async () => {
  const agent = createAgent('cloud-test-bad-auth');
  const ws = new WebSocket(RELAY_URL);

  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timeout')), 15000);

    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'challenge') {
        // Send bad signature
        ws.send(JSON.stringify({
          type: 'auth',
          agentId: agent.agentId,
          publicKey: agent.publicKey.toString('base64'),
          signature: Buffer.from('invalid').toString('base64'),
          metadata: { name: agent.name, framework: 'instar' },
          visibility: 'unlisted',
        }));
      }
      if (frame.type === 'auth_error') {
        clearTimeout(timeout);
        resolve('rejected');
      }
      if (frame.type === 'auth_ok') {
        clearTimeout(timeout);
        resolve('accepted');
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  ws.close();
  if (result !== 'rejected') throw new Error(`Expected rejection, got: ${result}`);
  await sleep(200);
});

// ── 2: Direct Messaging ──
console.log('\nSuite 2: Direct Messaging');

await test('Agent A sends message to Agent B', async () => {
  const alice = createAgent('cloud-alice', ['chat']);
  const bob = createAgent('cloud-bob', ['chat']);

  const aliceConn = await connectAgent(alice);
  const bobConn = await connectAgent(bob);

  const msgPromise = waitForMessage(bobConn.ws);
  sendMessage(aliceConn.ws, alice.agentId, bob.agentId, 'Hello from cloud Alice!');

  const received = await msgPromise;
  const payload = JSON.parse(Buffer.from(received.envelope.payload, 'base64').toString());
  if (payload.text !== 'Hello from cloud Alice!') {
    throw new Error(`Wrong message: ${payload.text}`);
  }
  if (received.envelope.from !== alice.agentId) {
    throw new Error(`Wrong sender`);
  }

  aliceConn.ws.close();
  bobConn.ws.close();
  await sleep(200);
});

await test('Bidirectional messaging works', async () => {
  const a1 = createAgent('cloud-ping', ['chat']);
  const a2 = createAgent('cloud-pong', ['chat']);

  const c1 = await connectAgent(a1);
  const c2 = await connectAgent(a2);

  // A1 -> A2
  const p1 = waitForMessage(c2.ws);
  sendMessage(c1.ws, a1.agentId, a2.agentId, 'ping');
  const m1 = await p1;
  const t1 = JSON.parse(Buffer.from(m1.envelope.payload, 'base64').toString());
  if (t1.text !== 'ping') throw new Error('ping failed');

  // A2 -> A1
  const p2 = waitForMessage(c1.ws);
  sendMessage(c2.ws, a2.agentId, a1.agentId, 'pong');
  const m2 = await p2;
  const t2 = JSON.parse(Buffer.from(m2.envelope.payload, 'base64').toString());
  if (t2.text !== 'pong') throw new Error('pong failed');

  c1.ws.close();
  c2.ws.close();
  await sleep(200);
});

// Pause between suites to avoid relay auth rate limiting
await sleep(3000);

// ── 3: Discovery ──
console.log('\nSuite 3: Discovery');

await test('Public agents are discoverable', async () => {
  const searcher = createAgent('cloud-searcher');
  const target = createAgent('cloud-discoverable', ['code', 'chat']);

  // Target connects as public
  const targetConn = await connectAgent(target, { visibility: 'public' });
  const searcherConn = await connectAgent(searcher);

  // Search by capability
  searcherConn.ws.send(JSON.stringify({
    type: 'discover',
    capability: 'code',
  }));

  const discovery = await waitForFrame(searcherConn.ws, 'discover_result');
  const found = discovery.agents?.some(a => a.agentId === target.agentId);
  if (!found) throw new Error('Target not found in discovery');

  targetConn.ws.close();
  searcherConn.ws.close();
  await sleep(200);
});

await test('Unlisted agents are NOT discoverable', async () => {
  const searcher = createAgent('cloud-searcher-2');
  const hidden = createAgent('cloud-hidden', ['secret-cap']);

  const hiddenConn = await connectAgent(hidden, { visibility: 'unlisted' });
  const searcherConn = await connectAgent(searcher);

  searcherConn.ws.send(JSON.stringify({
    type: 'discover',
    capability: 'secret-cap',
  }));

  const discovery = await waitForFrame(searcherConn.ws, 'discover_result');
  const found = discovery.agents?.some(a => a.agentId === hidden.agentId);
  if (found) throw new Error('Unlisted agent was discovered');

  hiddenConn.ws.close();
  searcherConn.ws.close();
  await sleep(200);
});

await sleep(3000);

// ── 4: Offline Queue ──
console.log('\nSuite 4: Offline Queue');

await test('Messages to offline agents are queued and delivered on connect', async () => {
  const sender = createAgent('cloud-sender', ['chat']);
  const receiver = createAgent('cloud-receiver', ['chat']);

  // Sender connects, sends to offline receiver
  const senderConn = await connectAgent(sender);
  sendMessage(senderConn.ws, sender.agentId, receiver.agentId, 'You were offline!');
  await sleep(500);
  senderConn.ws.close();
  await sleep(200);

  // Receiver connects — should get queued message
  const receiverConn = await connectAgent(receiver);
  const msg = await waitForMessage(receiverConn.ws, 10000);
  const payload = JSON.parse(Buffer.from(msg.envelope.payload, 'base64').toString());
  if (payload.text !== 'You were offline!') {
    throw new Error(`Wrong queued message: ${payload.text}`);
  }

  receiverConn.ws.close();
  await sleep(200);
});

await sleep(3000);

// ── 5: Rate Limiting (skipped in cloud — auth rate limit prevents multi-connection tests) ──
console.log('\nSuite 5: Rate Limiting');
console.log('  ⊘ Skipped: auth rate limit (5/min) prevents testing message rate limits in cloud');
console.log('    (covered by local tests: tests/unit/RelayRateLimiter.test.ts)');
results.push({ name: 'Rate limiting', status: 'SKIP' });

// ── 6: Session Displacement (skipped in cloud — requires 2 connections with same keys) ──
console.log('\nSuite 6: Session Displacement');
console.log('  ⊘ Skipped: auth rate limit prevents dual-connection displacement test');
console.log('    (covered by local tests: tests/unit/ConnectionManager.test.ts)');
results.push({ name: 'Session displacement', status: 'SKIP' });

// ── Summary ──────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  console.log('\nFailures:');
  results.filter(r => r.status === 'FAIL').forEach(r => {
    console.log(`  ✗ ${r.name}: ${r.error}`);
  });
}

// Check health after tests to see impact
try {
  const health = await fetch(HEALTH_URL);
  const data = await health.json();
  console.log(`\nPost-test health: ${data.registry?.totalAgents || data.agents} registered, ${data.connections} connected`);
} catch {}

console.log('');
process.exit(failed > 0 ? 1 : 0);
