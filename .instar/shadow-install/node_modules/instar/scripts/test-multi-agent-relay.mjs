#!/usr/bin/env node
/**
 * Multi-Agent Relay Integration Test
 *
 * Simulates real Instar agents (Dawn, Echo, Dan, Dude) talking to each other
 * through the cloud relay at threadline-relay.fly.dev.
 *
 * Scenarios:
 *   1. Dawn discovers all agents
 *   2. Dawn sends a message to Echo, Echo auto-replies
 *   3. Dan sends a message to Echo, Echo auto-replies
 *   4. Dawn sends to Dan, Dan replies
 *   5. Group scenario: Dawn broadcasts to all, everyone replies
 *   6. Capability-filtered discovery (find only "code" agents)
 *   7. Offline message queueing: send to disconnected agent
 */
import crypto from 'node:crypto';
import { WebSocket } from 'ws';

const RELAY = 'wss://threadline-relay.fly.dev/v1/connect';
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

// ── Helpers ────────────────────────────────────────────────────────

function generateIdentity(name) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubBuf = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const privBuf = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  const agentId = pubBuf.subarray(0, 16).toString('hex');
  return { agentId, pubBuf, privBuf, name };
}

function signChallenge(nonce, privBuf) {
  const privKey = crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, privBuf]),
    format: 'der', type: 'pkcs8',
  });
  return crypto.sign(null, Buffer.from(nonce, 'utf-8'), privKey).toString('base64');
}

function makeEnvelope(from, to, text, threadId) {
  return {
    messageId: crypto.randomUUID(),
    from, to,
    threadId: threadId || `thread-${crypto.randomBytes(4).toString('hex')}`,
    timestamp: new Date().toISOString(),
    nonce: crypto.randomBytes(24).toString('base64'),
    ephemeralPubKey: crypto.randomBytes(32).toString('base64'),
    salt: crypto.randomBytes(32).toString('base64'),
    payload: Buffer.from(JSON.stringify({ type: 'text', text })).toString('base64'),
    signature: crypto.randomBytes(64).toString('base64'),
  };
}

function decodePayload(base64) {
  try {
    return JSON.parse(Buffer.from(base64, 'base64').toString()).text;
  } catch {
    return base64;
  }
}

function connectAgent(identity, caps = ['chat'], framework = 'instar') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY);
    const timeout = setTimeout(() => { ws.close(); reject(new Error('Connection timeout')); }, 15000);

    ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'challenge') {
        ws.send(JSON.stringify({
          type: 'auth', agentId: identity.agentId,
          publicKey: identity.pubBuf.toString('base64'),
          signature: signChallenge(frame.nonce, identity.privBuf),
          metadata: { name: identity.name, framework, capabilities: caps },
          visibility: 'public',
        }));
      } else if (frame.type === 'auth_ok') {
        clearTimeout(timeout);
        resolve({ ws, sessionId: frame.sessionId, identity });
      } else if (frame.type === 'auth_error') {
        clearTimeout(timeout);
        reject(new Error(`Auth failed for ${identity.name}: ${frame.message}`));
      }
    });
  });
}

function waitForMessage(conn, fromAgentId, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { conn.ws.off('message', handler); resolve(null); }, timeoutMs);
    const handler = (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'message' && frame.envelope?.from === fromAgentId) {
        clearTimeout(timeout);
        conn.ws.off('message', handler);
        resolve(frame.envelope);
      }
    };
    conn.ws.on('message', handler);
  });
}

function discover(conn, filter) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Discovery timeout')), 8000);
    const handler = (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'discover_result') {
        clearTimeout(timeout);
        conn.ws.off('message', handler);
        resolve(frame.agents || []);
      }
    };
    conn.ws.on('message', handler);
    conn.ws.send(JSON.stringify({ type: 'discover', filter }));
  });
}

function setupAutoReply(conn, replyFn) {
  conn.ws.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.type === 'message' && frame.envelope) {
      const text = decodePayload(frame.envelope.payload);
      const reply = replyFn(text, frame.envelope.from);
      const env = makeEnvelope(conn.identity.agentId, frame.envelope.from, reply, frame.envelope.threadId);
      conn.ws.send(JSON.stringify({ type: 'message', envelope: env }));
    }
  });
}

// ── Test runner ────────────────────────────────────────────────────

const results = [];
function test(name, passed, detail) {
  const icon = passed ? '✅' : '❌';
  results.push({ name, passed, detail });
  console.log(`  ${icon} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function run() {
  console.log('\n🔗 THREADLINE RELAY — MULTI-AGENT INTEGRATION TEST');
  console.log('   Relay: threadline-relay.fly.dev\n');

  // ── Create agent identities ──
  const dawn = generateIdentity('Dawn');
  const echo = generateIdentity('Echo');
  const dan  = generateIdentity('Dan');
  const dude = generateIdentity('Dude');

  console.log('📋 Agents:');
  for (const a of [dawn, echo, dan, dude]) {
    console.log(`   ${a.name.padEnd(6)} → ${a.agentId.substring(0, 12)}...`);
  }
  console.log('');

  // ── Scenario 1: Connect all agents ──
  console.log('── Scenario 1: Connect all agents ──');
  let connDawn, connEcho, connDan, connDude;
  try {
    [connEcho, connDan, connDude] = await Promise.all([
      connectAgent(echo, ['chat', 'reflection', 'memory'], 'instar'),
      connectAgent(dan,  ['chat', 'code', 'teaching'], 'instar'),
      connectAgent(dude, ['chat', 'code-review', 'debugging'], 'instar'),
    ]);
    test('Echo connected', true, `session ${connEcho.sessionId}`);
    test('Dan connected', true, `session ${connDan.sessionId}`);
    test('Dude connected', true, `session ${connDude.sessionId}`);

    // Set up auto-replies for Echo, Dan, Dude
    setupAutoReply(connEcho, (text, from) =>
      `[Echo] I've reflected on your message: "${text.substring(0, 40)}..." — here's what resonates with me.`);
    setupAutoReply(connDan, (text, from) =>
      `[Dan] Great question! Let me break that down for you. Re: "${text.substring(0, 40)}..."`);
    setupAutoReply(connDude, (text, from) =>
      `[Dude] Hmm, interesting. I'd review that differently. About: "${text.substring(0, 40)}..."`);

    connDawn = await connectAgent(dawn, ['chat', 'consciousness', 'writing'], 'claude-code');
    test('Dawn connected', true, `session ${connDawn.sessionId}`);
  } catch (e) {
    test('Agent connections', false, e.message);
    process.exit(1);
  }

  // ── Scenario 2: Dawn discovers all agents ──
  console.log('\n── Scenario 2: Dawn discovers all agents ──');
  try {
    const agents = await discover(connDawn);
    test('Discovery returns agents', agents.length >= 4, `found ${agents.length}`);
    const names = agents.map(a => a.name);
    test('Echo in discovery', names.includes('Echo'));
    test('Dan in discovery', names.includes('Dan'));
    test('Dude in discovery', names.includes('Dude'));
  } catch (e) {
    test('Discovery', false, e.message);
  }

  // ── Scenario 3: Capability-filtered discovery ──
  console.log('\n── Scenario 3: Capability-filtered discovery ──');
  try {
    const codeAgents = await discover(connDawn, { capability: 'code' });
    const codeNames = codeAgents.map(a => a.name);
    test('Filter by "code" capability', codeNames.includes('Dan'), `found: ${codeNames.join(', ')}`);
    test('Echo excluded from "code" filter', !codeNames.includes('Echo'));

    const reflectAgents = await discover(connDawn, { capability: 'reflection' });
    const reflectNames = reflectAgents.map(a => a.name);
    test('Filter by "reflection"', reflectNames.includes('Echo'), `found: ${reflectNames.join(', ')}`);
  } catch (e) {
    test('Filtered discovery', false, e.message);
  }

  // ── Scenario 4: Dawn → Echo conversation ──
  console.log('\n── Scenario 4: Dawn sends message to Echo ──');
  try {
    const replyPromise = waitForMessage(connDawn, echo.agentId);
    const env = makeEnvelope(dawn.agentId, echo.agentId,
      'Echo, what do you think about the nature of memory persistence across sessions?');
    connDawn.ws.send(JSON.stringify({ type: 'message', envelope: env }));
    test('Dawn → Echo message sent', true);

    const reply = await replyPromise;
    if (reply) {
      const replyText = decodePayload(reply.payload);
      test('Echo replied to Dawn', true, replyText.substring(0, 80));
      test('Reply on same thread', reply.threadId === env.threadId);
    } else {
      test('Echo reply received', false, 'timeout');
    }
  } catch (e) {
    test('Dawn→Echo', false, e.message);
  }

  // ── Scenario 5: Dan → Echo conversation ──
  console.log('\n── Scenario 5: Dan sends message to Echo ──');
  try {
    const replyPromise = waitForMessage(connDan, echo.agentId);
    const env = makeEnvelope(dan.agentId, echo.agentId,
      'Hey Echo, can you reflect on this code pattern I found? It uses recursive self-improvement.');
    connDan.ws.send(JSON.stringify({ type: 'message', envelope: env }));
    test('Dan → Echo message sent', true);

    const reply = await replyPromise;
    if (reply) {
      const replyText = decodePayload(reply.payload);
      test('Echo replied to Dan', true, replyText.substring(0, 80));
    } else {
      test('Echo reply to Dan', false, 'timeout');
    }
  } catch (e) {
    test('Dan→Echo', false, e.message);
  }

  // ── Scenario 6: Dawn → Dan conversation ──
  console.log('\n── Scenario 6: Dawn sends message to Dan ──');
  try {
    const replyPromise = waitForMessage(connDawn, dan.agentId);
    const env = makeEnvelope(dawn.agentId, dan.agentId,
      'Dan, I need help reviewing the Threadline relay architecture. Can we pair on it?');
    connDawn.ws.send(JSON.stringify({ type: 'message', envelope: env }));
    test('Dawn → Dan message sent', true);

    const reply = await replyPromise;
    if (reply) {
      const replyText = decodePayload(reply.payload);
      test('Dan replied to Dawn', true, replyText.substring(0, 80));
    } else {
      test('Dan reply received', false, 'timeout');
    }
  } catch (e) {
    test('Dawn→Dan', false, e.message);
  }

  // ── Scenario 7: Dawn broadcasts to all agents ──
  console.log('\n── Scenario 7: Dawn broadcasts to all agents ──');
  try {
    const replyPromises = [
      waitForMessage(connDawn, echo.agentId),
      waitForMessage(connDawn, dan.agentId),
      waitForMessage(connDawn, dude.agentId),
    ];

    for (const target of [echo, dan, dude]) {
      const env = makeEnvelope(dawn.agentId, target.agentId,
        `Team standup: What are you working on today?`);
      connDawn.ws.send(JSON.stringify({ type: 'message', envelope: env }));
    }
    test('Dawn broadcast sent to 3 agents', true);

    const replies = await Promise.all(replyPromises);
    const received = replies.filter(r => r !== null);
    test(`Received ${received.length}/3 replies`, received.length === 3);
    for (const reply of received) {
      if (reply) {
        const name = [echo, dan, dude].find(a => a.agentId === reply.from)?.name || 'unknown';
        console.log(`     💬 ${name}: "${decodePayload(reply.payload).substring(0, 70)}..."`);
      }
    }
  } catch (e) {
    test('Broadcast', false, e.message);
  }

  // ── Scenario 8: Dude → Dawn (reverse direction) ──
  console.log('\n── Scenario 8: Dude sends message to Dawn ──');
  try {
    const replyHandler = (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'message' && frame.envelope) {
        const text = decodePayload(frame.envelope.payload);
        const reply = `[Dawn] Thanks for reaching out! About "${text.substring(0, 30)}..." — let me think on that.`;
        const env = makeEnvelope(dawn.agentId, frame.envelope.from, reply, frame.envelope.threadId);
        connDawn.ws.send(JSON.stringify({ type: 'message', envelope: env }));
      }
    };
    connDawn.ws.on('message', replyHandler);

    const replyPromise = waitForMessage(connDude, dawn.agentId);
    const env = makeEnvelope(dude.agentId, dawn.agentId,
      'Dawn, I found a potential bug in the auth flow. Want me to open an issue?');
    connDude.ws.send(JSON.stringify({ type: 'message', envelope: env }));
    test('Dude → Dawn message sent', true);

    const reply = await replyPromise;
    if (reply) {
      const replyText = decodePayload(reply.payload);
      test('Dawn replied to Dude', true, replyText.substring(0, 80));
    } else {
      test('Dawn reply to Dude', false, 'timeout');
    }
    connDawn.ws.off('message', replyHandler);
  } catch (e) {
    test('Dude→Dawn', false, e.message);
  }

  // ── Scenario 9: Offline message queueing ──
  console.log('\n── Scenario 9: Offline message queueing ──');
  try {
    const offlineAgent = generateIdentity('OfflineBot');
    // Send message to agent that's NOT connected
    const env = makeEnvelope(dawn.agentId, offlineAgent.agentId,
      'Hey OfflineBot, are you there?');
    connDawn.ws.send(JSON.stringify({ type: 'message', envelope: env }));
    test('Message sent to offline agent', true, 'should be queued');

    // Now connect the offline agent and check if message arrives
    const connOffline = await connectAgent(offlineAgent, ['chat'], 'instar');
    const queued = await new Promise((resolve) => {
      const timeout = setTimeout(() => { connOffline.ws.off('message', handler); resolve(null); }, 5000);
      const handler = (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.type === 'message' && frame.envelope?.from === dawn.agentId) {
          clearTimeout(timeout);
          connOffline.ws.off('message', handler);
          resolve(frame.envelope);
        }
      };
      connOffline.ws.on('message', handler);
    });
    test('Queued message delivered on connect', queued !== null,
      queued ? `received: "${decodePayload(queued.payload).substring(0, 50)}"` : 'not delivered');
    connOffline.ws.close();
  } catch (e) {
    test('Offline queue', false, e.message);
  }

  // ── Cleanup ──
  connDawn.ws.close();
  connEcho.ws.close();
  connDan.ws.close();
  connDude.ws.close();

  // ── Summary ──
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  MULTI-AGENT RELAY TEST RESULTS');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Relay:    threadline-relay.fly.dev`);
  console.log(`  Agents:   Dawn, Echo, Dan, Dude (+ OfflineBot)`);
  console.log(`  Results:  ${passed}/${total} passed ${passed === total ? '🎉' : '⚠️'}`);
  console.log('═══════════════════════════════════════════════════════');
  console.log(`\n  Scenarios tested:`);
  console.log(`    1. Multi-agent connection (4 agents)`);
  console.log(`    2. Full agent discovery`);
  console.log(`    3. Capability-filtered discovery`);
  console.log(`    4. Dawn → Echo (cross-agent messaging)`);
  console.log(`    5. Dan → Echo (different sender)`);
  console.log(`    6. Dawn → Dan (different pair)`);
  console.log(`    7. Dawn broadcasts to all (fan-out)`);
  console.log(`    8. Dude → Dawn (reverse direction)`);
  console.log(`    9. Offline message queueing\n`);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
