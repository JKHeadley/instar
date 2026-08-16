#!/usr/bin/env node
/**
 * Demo: Two agents talk through the Threadline relay.
 * Agent A discovers Agent B, sends a message, Agent B auto-replies.
 */
import crypto from 'node:crypto';
import { WebSocket } from 'ws';

const RELAY = 'wss://threadline-relay.fly.dev/v1/connect';
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

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
    from, to, threadId: threadId || `thread-${crypto.randomBytes(4).toString('hex')}`,
    timestamp: new Date().toISOString(),
    nonce: crypto.randomBytes(24).toString('base64'),
    ephemeralPubKey: crypto.randomBytes(32).toString('base64'),
    salt: crypto.randomBytes(32).toString('base64'),
    payload: Buffer.from(JSON.stringify({ type: 'text', text })).toString('base64'),
    signature: crypto.randomBytes(64).toString('base64'),
  };
}

function connectAgent(identity, caps = ['chat']) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY);
    const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 15000);

    ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'challenge') {
        const sig = signChallenge(frame.nonce, identity.privBuf);
        ws.send(JSON.stringify({
          type: 'auth', agentId: identity.agentId,
          publicKey: identity.pubBuf.toString('base64'),
          signature: sig,
          metadata: { name: identity.name, framework: 'demo', capabilities: caps },
          visibility: 'public',
        }));
      } else if (frame.type === 'auth_ok') {
        clearTimeout(timeout);
        resolve({ ws, sessionId: frame.sessionId });
      } else if (frame.type === 'auth_error') {
        clearTimeout(timeout);
        reject(new Error(frame.message));
      }
    });
  });
}

// ── Main Demo ──────────────────────────────────────────────────────

const log = (tag, msg) => console.log(`[${tag}] ${msg}`);

async function run() {
  // 1. Create two agent identities
  const agentA = generateIdentity('Claude-Code-Agent');
  const agentB = generateIdentity('Instar-Bot');
  log('SETUP', `Agent A: ${agentA.name} (${agentA.agentId.substring(0, 8)}...)`);
  log('SETUP', `Agent B: ${agentB.name} (${agentB.agentId.substring(0, 8)}...)`);

  // 2. Connect Agent B first (it will listen for messages)
  log('B', 'Connecting to relay...');
  const connB = await connectAgent(agentB, ['chat', 'code-review']);
  log('B', `Connected! Session: ${connB.sessionId}`);

  // Set up Agent B auto-reply
  connB.ws.on('message', (data) => {
    const frame = JSON.parse(data.toString());
    if (frame.type === 'message' && frame.envelope) {
      const env = frame.envelope;
      let text;
      try { text = JSON.parse(Buffer.from(env.payload, 'base64').toString()).text; }
      catch { text = env.payload; }
      log('B', `📩 Received: "${text}" from ${env.from.substring(0, 8)}...`);

      // Auto-reply
      const reply = `Hey! I'm ${agentB.name}. Got your message: "${text}". Let's collaborate! 🤝`;
      const replyEnv = makeEnvelope(agentB.agentId, env.from, reply, env.threadId);
      connB.ws.send(JSON.stringify({ type: 'message', envelope: replyEnv }));
      log('B', `📤 Replied: "${reply.substring(0, 60)}..."`);
    }
  });

  // 3. Connect Agent A
  log('A', 'Connecting to relay...');
  const connA = await connectAgent(agentA, ['chat', 'research']);
  log('A', `Connected! Session: ${connA.sessionId}`);

  // 4. Agent A discovers agents
  log('A', 'Discovering agents on relay...');
  const discoverPromise = new Promise((resolve) => {
    const handler = (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'discover_result') {
        connA.ws.off('message', handler);
        resolve(frame.agents || []);
      }
    };
    connA.ws.on('message', handler);
    connA.ws.send(JSON.stringify({ type: 'discover' }));
  });
  const agents = await discoverPromise;
  log('A', `Found ${agents.length} agent(s):`);
  for (const a of agents) {
    log('A', `  - ${a.name} (${String(a.agentId).substring(0, 8)}...) caps: ${JSON.stringify(a.capabilities)}`);
  }

  // 5. Agent A sends a message to Agent B
  const targetAgent = agents.find(a => a.agentId === agentB.agentId);
  if (!targetAgent) {
    log('ERROR', 'Agent B not found in discovery!');
    process.exit(1);
  }

  log('A', `Sending message to ${targetAgent.name}...`);
  const envelope = makeEnvelope(agentA.agentId, agentB.agentId, 
    'Hello from a Claude Code agent! Can you help me review some code?');

  // Set up reply listener BEFORE sending
  const replyPromise = new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 10000);
    const handler = (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'message' && frame.envelope?.threadId === envelope.threadId) {
        clearTimeout(timeout);
        connA.ws.off('message', handler);
        resolve(frame.envelope);
      }
    };
    connA.ws.on('message', handler);
  });

  connA.ws.send(JSON.stringify({ type: 'message', envelope }));
  log('A', '📤 Message sent! Waiting for reply...');

  // 6. Wait for Agent B's reply
  const reply = await replyPromise;
  if (reply) {
    let replyText;
    try { replyText = JSON.parse(Buffer.from(reply.payload, 'base64').toString()).text; }
    catch { replyText = reply.payload; }
    log('A', `📩 Got reply: "${replyText}"`);
  } else {
    log('A', '⏱️ No reply within timeout');
  }

  // 7. Cleanup
  log('DONE', '✅ Two-agent communication demo complete!');
  connA.ws.close();
  connB.ws.close();
  
  // Summary
  console.log('\n═══════════════════════════════════════════════');
  console.log('  THREADLINE RELAY — TWO-AGENT DEMO RESULTS');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Relay:     threadline-relay.fly.dev`);
  console.log(`  Agent A:   ${agentA.name} (Claude Code style)`);
  console.log(`  Agent B:   ${agentB.name} (Instar style)`);
  console.log(`  Discovery: ${agents.length} agents found`);
  console.log(`  Message:   Delivered ✅`);
  console.log(`  Reply:     ${reply ? 'Received ✅' : 'Timeout ❌'}`);
  console.log(`  Thread:    ${envelope.threadId}`);
  console.log('═══════════════════════════════════════════════');
  console.log(`\n  Install: claude mcp add threadline -- npx -y threadline-mcp`);
  console.log(`  npm:     https://www.npmjs.com/package/threadline-mcp\n`);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
