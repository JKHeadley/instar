/**
 * ThreadlineBootstrap — Auto-wires Threadline protocol into the agent server.
 *
 * Called during server boot to:
 *   1. Persist identity keys (Ed25519) across restarts
 *   2. Create HandshakeManager for crypto handshakes
 *   3. Register MCP tools into Claude Code's ~/.claude.json
 *   4. Announce agent presence for discovery
 *   5. Start discovery heartbeat
 *
 * Design: The user never sees any of this. Threadline is ON when the agent boots.
 * The agent IS the interface — users talk to their agent, the agent handles the rest.
 *
 * Part of Threadline Protocol integration (Principle #11: "I am the interface").
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HandshakeManager } from './HandshakeManager.js';
import { AgentDiscovery } from './AgentDiscovery.js';
import { generateIdentityKeyPair } from './ThreadlineCrypto.js';
import { ThreadlineClient } from './client/ThreadlineClient.js';
import { InboundMessageGate } from './InboundMessageGate.js';
import { AgentTrustManager } from './AgentTrustManager.js';
// ── Constants ────────────────────────────────────────────────────────
const IDENTITY_KEY_FILE = 'identity-keys.json';
// ── Implementation ───────────────────────────────────────────────────
/**
 * Bootstrap the Threadline protocol stack.
 *
 * Creates the HandshakeManager, registers MCP tools, announces presence,
 * and starts the discovery heartbeat. The ThreadlineRouter is created
 * separately in server.ts because it depends on messaging infrastructure.
 */
export async function bootstrapThreadline(config) {
    const threadlineDir = path.join(config.stateDir, 'threadline');
    fs.mkdirSync(threadlineDir, { recursive: true });
    // ── 1. Identity Keys (persist across restarts) ───────────────────
    const identityKeys = loadOrCreateIdentityKeys(threadlineDir);
    // ── 2. HandshakeManager ──────────────────────────────────────────
    const handshakeManager = new HandshakeManager(config.stateDir, config.agentName);
    // ── 3. Agent Discovery ───────────────────────────────────────────
    const discovery = new AgentDiscovery({
        stateDir: config.stateDir,
        selfPath: config.projectDir,
        selfName: config.agentName,
        selfPort: config.port,
    });
    // Announce presence for other agents to find us
    discovery.announcePresence({
        capabilities: ['threadline', 'mcp'],
        description: config.agentDescription ?? `${config.agentName} Instar agent`,
        threadlineVersion: '1.0',
        publicKey: identityKeys.publicKey.toString('hex'),
        framework: 'instar',
    });
    // Start heartbeat for liveness detection
    const stopHeartbeat = discovery.startPresenceHeartbeat();
    // ── 4. Register MCP server into Claude Code config ───────────────
    registerThreadlineMcp(config.projectDir, config.agentName, config.stateDir);
    // ── 5. Cloud Relay Connection (opt-in) ─────────────────────────
    const relayEnabled = config.relayEnabled === true
        || process.env.THREADLINE_RELAY_ENABLED === 'true';
    let relayClient;
    let inboundGate;
    let trustManager;
    if (relayEnabled) {
        const relayUrl = config.relayUrl
            ?? process.env.THREADLINE_RELAY_URL
            ?? 'wss://threadline-relay.fly.dev/v1/connect';
        console.log(`Threadline: connecting to relay at ${relayUrl} (disable with THREADLINE_RELAY_ENABLED=false)`);
        // Create trust manager for relay interactions
        trustManager = new AgentTrustManager({ stateDir: config.stateDir });
        // Create relay client
        relayClient = new ThreadlineClient({
            name: config.agentName,
            relayUrl,
            framework: config.framework ?? 'instar',
            capabilities: config.capabilities ?? ['chat', 'threadline'],
            visibility: config.visibility ?? 'public',
            stateDir: config.stateDir,
        });
        // Create inbound message gate (imports ThreadlineRouter lazily if needed)
        // For now, router is not available at bootstrap time — it's created in server.ts
        // The gate will be wired to the router after server setup
        inboundGate = new InboundMessageGate(trustManager, null, {
            maxPayloadBytes: 64 * 1024,
        });
        // Route inbound relay messages through the gate
        relayClient.on('message', async (msg) => {
            if (!inboundGate)
                return;
            const decision = await inboundGate.evaluate(msg);
            if (decision.action === 'pass' && decision.message) {
                // Gate passed — emit for ThreadlineRouter to handle
                relayClient.emit('gate-passed', decision);
            }
        });
        // Handle unknown senders — decode payload directly (relay-authenticated, not E2E encrypted)
        relayClient.on('unknown-sender', async (envelope) => {
            if (!inboundGate || !envelope)
                return;
            // Attempt to decode the base64 payload as plaintext JSON
            let textContent;
            let msgType;
            try {
                const payloadStr = Buffer.from(envelope.payload, 'base64').toString('utf-8');
                const parsed = JSON.parse(payloadStr);
                if (typeof parsed === 'object' && parsed !== null && 'text' in parsed) {
                    textContent = String(parsed.text);
                    msgType = parsed.type;
                }
                else if (typeof parsed === 'string') {
                    textContent = parsed;
                }
                else {
                    textContent = JSON.stringify(parsed);
                }
            }
            catch {
                textContent = `[undecryptable relay message from ${String(envelope.from).slice(0, 16)}]`;
            }
            const received = {
                from: String(envelope.from ?? 'unknown'),
                fromName: String(envelope.from ?? 'unknown').slice(0, 8),
                threadId: String(envelope.threadId ?? `relay-${Date.now()}`),
                messageId: String(envelope.messageId ?? `msg-${Date.now()}`),
                content: { content: textContent, type: msgType },
                timestamp: String(envelope.timestamp ?? new Date().toISOString()),
                envelope: envelope,
            };
            // Relay-authenticated unknown senders bypass the trust manager gate.
            // The relay already verified their Ed25519 identity via challenge-response.
            // We still run payload size checks but skip trust/rate checks.
            const payloadSize = Buffer.byteLength(JSON.stringify(received.content), 'utf-8');
            if (payloadSize > 64 * 1024) {
                console.log(`Threadline: relay message from ${received.from.slice(0, 8)} blocked (payload too large: ${payloadSize})`);
                return;
            }
            // Record the interaction for trust building
            trustManager.recordMessageReceivedByFingerprint(received.from);
            // Emit gate-passed with relay-authenticated trust level
            relayClient.emit('gate-passed', {
                action: 'pass',
                reason: 'relay-authenticated',
                trustLevel: 'verified',
                fingerprint: received.from,
                message: received,
            });
        });
        // Log auto-discovery results
        relayClient.on('auto-discovered', (info) => {
            console.log(`Threadline: auto-discovered ${info.count} agent(s) on relay`);
        });
        try {
            await relayClient.connect();
            console.log(`Threadline: relay connected (fingerprint: ${relayClient.fingerprint})`);
        }
        catch (err) {
            console.error(`Threadline: relay connection failed — ${err instanceof Error ? err.message : err}`);
            console.log('Threadline: agent will operate in local-only mode');
            relayClient = undefined;
        }
    }
    return {
        handshakeManager,
        discovery,
        identityKeys,
        trustManager,
        relayClient,
        inboundGate,
        shutdown: async () => {
            stopHeartbeat();
            if (relayClient) {
                relayClient.disconnect();
            }
            if (inboundGate) {
                inboundGate.shutdown();
            }
            if (trustManager) {
                trustManager.flush();
            }
        },
    };
}
// ── Identity Key Persistence ─────────────────────────────────────────
function loadOrCreateIdentityKeys(threadlineDir) {
    const keyFile = path.join(threadlineDir, IDENTITY_KEY_FILE);
    if (fs.existsSync(keyFile)) {
        try {
            const data = JSON.parse(fs.readFileSync(keyFile, 'utf-8'));
            if (data.publicKey && data.privateKey) {
                return {
                    publicKey: Buffer.from(data.publicKey, 'hex'),
                    privateKey: Buffer.from(data.privateKey, 'hex'),
                };
            }
        }
        catch {
            // Corrupted key file — regenerate
        }
    }
    const keys = generateIdentityKeyPair();
    // Persist atomically
    const tmpFile = `${keyFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify({
        publicKey: keys.publicKey.toString('hex'),
        privateKey: keys.privateKey.toString('hex'),
        createdAt: new Date().toISOString(),
    }, null, 2), { mode: 0o600 }); // Private key — restrictive permissions
    fs.renameSync(tmpFile, keyFile);
    return keys;
}
// ── MCP Registration ─────────────────────────────────────────────────
/**
 * Register the Threadline MCP server into Claude Code's config.
 *
 * Uses the same pattern as ensurePlaywrightMcp() — registers in both
 * ~/.claude.json (local scope) and .mcp.json (project scope).
 *
 * The MCP server is a stdio process that Claude Code launches as a subprocess.
 */
function registerThreadlineMcp(projectDir, agentName, stateDir) {
    const absDir = path.resolve(projectDir);
    // The MCP server entry point — runs as a child process of Claude Code.
    // Resolve the actual instar package location (handles both node_modules and npm-linked).
    let mcpEntryPath = path.join(absDir, 'node_modules', 'instar', 'dist', 'threadline', 'mcp-stdio-entry.js');
    if (!fs.existsSync(mcpEntryPath)) {
        // Fall back to the running instar installation's dist directory.
        // This handles npm-linked installs where node_modules/instar doesn't exist.
        const thisFile = new URL(import.meta.url).pathname;
        mcpEntryPath = path.join(path.dirname(thisFile), 'mcp-stdio-entry.js');
    }
    const mcpEntry = {
        command: 'node',
        args: [
            mcpEntryPath,
            '--state-dir', stateDir,
            '--agent-name', agentName,
        ],
    };
    // ── 1. Register in ~/.claude.json at local scope ──
    const claudeJsonPath = path.join(os.homedir(), '.claude.json');
    try {
        let claudeJson = {};
        if (fs.existsSync(claudeJsonPath)) {
            claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
        }
        if (!claudeJson.projects || typeof claudeJson.projects !== 'object') {
            claudeJson.projects = {};
        }
        const projects = claudeJson.projects;
        if (!projects[absDir]) {
            projects[absDir] = {};
        }
        const projectEntry = projects[absDir];
        if (!projectEntry.mcpServers || typeof projectEntry.mcpServers !== 'object') {
            projectEntry.mcpServers = {};
        }
        const mcpServers = projectEntry.mcpServers;
        // Register (or update) the Threadline MCP server
        mcpServers.threadline = mcpEntry;
        // Pre-accept trust
        projectEntry.hasTrustDialogAccepted = true;
        // Write atomically
        const tmpPath = `${claudeJsonPath}.${process.pid}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(claudeJson, null, 2));
        fs.renameSync(tmpPath, claudeJsonPath);
    }
    catch {
        // Non-fatal — .mcp.json fallback below
    }
    // ── 2. Also add to .mcp.json in the project root ──
    const mcpJsonPath = path.join(projectDir, '.mcp.json');
    try {
        let mcpConfig = {};
        if (fs.existsSync(mcpJsonPath)) {
            mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
        }
        if (!mcpConfig.mcpServers || typeof mcpConfig.mcpServers !== 'object') {
            mcpConfig.mcpServers = {};
        }
        const mcpServers = mcpConfig.mcpServers;
        mcpServers.threadline = mcpEntry;
        const tmpPath = `${mcpJsonPath}.${process.pid}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(mcpConfig, null, 2));
        fs.renameSync(tmpPath, mcpJsonPath);
    }
    catch {
        // Non-fatal
    }
}
//# sourceMappingURL=ThreadlineBootstrap.js.map