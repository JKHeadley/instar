/**
 * GitSyncTransport — offline cross-machine messaging via git-sync.
 *
 * Per Phase 4 of INTER-AGENT-MESSAGING-SPEC v3.1:
 * - Picks up inbound messages from git-synced outbound directories
 * - Manages outbound queue cleanup after successful relay
 * - Verifies Ed25519 signatures on inbound cross-machine messages
 * - Deduplicates against already-received messages
 * - Provides outbound queue status for monitoring
 *
 * Directory layout:
 *   ~/.instar/messages/outbound/{targetMachineId}/{messageId}.json  — outgoing
 *   .instar/messages/outbound/{localMachineId}/{messageId}.json     — incoming (via git-sync)
 *
 * After git-sync, a remote machine's outbound/{localMachineId}/ directory
 * appears in our local repo. We scan it, verify signatures, ingest valid
 * messages, and remove processed files.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// ── Implementation ──────────────────────────────────────────────
/**
 * Scan the git-synced outbound directory for inbound messages and ingest them.
 *
 * After git-sync, remote machines' outbound/{localMachineId}/ directories
 * appear in our local project repo. We scan each one, verify signatures,
 * dedup against existing store, and ingest valid messages.
 *
 * The outbound directories in the PROJECT (not home dir) are the inbound path
 * after git-sync. The home dir outbound is for messages WE are sending.
 */
export async function pickupGitSyncMessages(config) {
    // Inbound path: {stateDir}/messages/outbound/{localMachineId}/
    const inboundDir = path.join(config.stateDir, 'messages', 'outbound', config.localMachineId);
    const result = {
        ingested: 0,
        rejected: 0,
        duplicates: 0,
        rejections: [],
    };
    if (!fs.existsSync(inboundDir)) {
        return result;
    }
    let files;
    try {
        files = fs.readdirSync(inboundDir).filter(f => f.endsWith('.json'));
    }
    catch {
        // @silent-fallback-ok — directory not readable, nothing to process
        return result;
    }
    for (const file of files) {
        const filePath = path.join(inboundDir, file);
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const envelope = JSON.parse(raw);
            // Validate envelope structure
            if (!envelope?.message?.id || !envelope?.transport || !envelope?.delivery) {
                result.rejected++;
                result.rejections.push({ file, reason: 'invalid envelope structure' });
                unlinkSafe(filePath);
                continue;
            }
            // Deduplication: skip if already in store (may have arrived via real-time relay first)
            if (await config.store.exists(envelope.message.id)) {
                result.duplicates++;
                unlinkSafe(filePath);
                continue;
            }
            // Verify Ed25519 signature if verifier is provided
            if (config.verifySignature) {
                const sigResult = config.verifySignature(envelope);
                if (!sigResult.valid) {
                    result.rejected++;
                    result.rejections.push({ file, reason: `invalid signature: ${sigResult.reason}` });
                    unlinkSafe(filePath);
                    continue;
                }
            }
            else if (!envelope.transport.signature) {
                // No verifier and no signature — reject (cross-machine messages must be signed)
                result.rejected++;
                result.rejections.push({ file, reason: 'missing signature (cross-machine messages require Ed25519)' });
                unlinkSafe(filePath);
                continue;
            }
            // Check TTL — don't ingest expired messages
            if (envelope.message.ttlMinutes) {
                const sentAt = new Date(envelope.delivery.transitions[0]?.at || envelope.transport.timestamp).getTime();
                const ttlMs = envelope.message.ttlMinutes * 60_000;
                if (Date.now() - sentAt > ttlMs) {
                    result.rejected++;
                    result.rejections.push({ file, reason: `TTL expired (${envelope.message.ttlMinutes}min)` });
                    unlinkSafe(filePath);
                    continue;
                }
            }
            // Update delivery phase to 'received'
            const now = new Date().toISOString();
            envelope.delivery = {
                ...envelope.delivery,
                phase: 'received',
                transitions: [
                    ...envelope.delivery.transitions,
                    { from: envelope.delivery.phase, to: 'received', at: now, reason: 'picked up from git-sync' },
                ],
            };
            // Ingest into store
            await config.store.save(envelope);
            result.ingested++;
            // Clean up processed file
            unlinkSafe(filePath);
        }
        catch {
            // @silent-fallback-ok — malformed file, skip it
            result.rejected++;
            result.rejections.push({ file, reason: 'parse error or I/O failure' });
            unlinkSafe(filePath);
        }
    }
    return result;
}
/**
 * Get the status of the outbound queue (messages waiting for relay/git-sync).
 *
 * Scans ~/.instar/messages/outbound/ for per-machine subdirectories.
 */
export function getOutboundQueueStatus() {
    const outboundBase = path.join(os.homedir(), '.instar', 'messages', 'outbound');
    const queues = [];
    let totalPending = 0;
    if (!fs.existsSync(outboundBase)) {
        return { queues, totalPending };
    }
    let dirs;
    try {
        dirs = fs.readdirSync(outboundBase, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);
    }
    catch {
        // @silent-fallback-ok — outbound dir not readable
        return { queues, totalPending };
    }
    for (const machineDir of dirs) {
        const machinePath = path.join(outboundBase, machineDir);
        try {
            const files = fs.readdirSync(machinePath).filter(f => f.endsWith('.json'));
            if (files.length === 0)
                continue;
            let oldest = null;
            let newest = null;
            for (const file of files) {
                try {
                    const stat = fs.statSync(path.join(machinePath, file));
                    const mtime = stat.mtime.toISOString();
                    if (!oldest || mtime < oldest)
                        oldest = mtime;
                    if (!newest || mtime > newest)
                        newest = mtime;
                }
                catch {
                    // @silent-fallback-ok — stat failure on single file
                }
            }
            queues.push({
                targetMachine: machineDir,
                messageCount: files.length,
                oldestAt: oldest,
                newestAt: newest,
            });
            totalPending += files.length;
        }
        catch {
            // @silent-fallback-ok — machine dir not readable
        }
    }
    return { queues, totalPending };
}
/**
 * Clean up delivered messages from the outbound queue.
 *
 * After a successful real-time relay, the outbound copy should be removed
 * to prevent re-delivery on the next git-sync.
 */
export function cleanupDeliveredOutbound(targetMachine, messageId) {
    const outboundPath = path.join(os.homedir(), '.instar', 'messages', 'outbound', targetMachine, `${messageId}.json`);
    try {
        if (fs.existsSync(outboundPath)) {
            fs.unlinkSync(outboundPath);
            return true;
        }
        return false;
    }
    catch {
        // @silent-fallback-ok — cleanup failure is non-critical
        return false;
    }
}
/**
 * Scan all outbound directories and clean up messages that have been
 * successfully delivered (exist in the local store with phase 'delivered' or 'acknowledged').
 */
export async function cleanupAllDelivered(store) {
    const outboundBase = path.join(os.homedir(), '.instar', 'messages', 'outbound');
    let cleaned = 0;
    if (!fs.existsSync(outboundBase))
        return 0;
    let dirs;
    try {
        dirs = fs.readdirSync(outboundBase, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);
    }
    catch {
        // @silent-fallback-ok — outbound dir not readable
        return 0;
    }
    for (const machineDir of dirs) {
        const machinePath = path.join(outboundBase, machineDir);
        try {
            const files = fs.readdirSync(machinePath).filter(f => f.endsWith('.json'));
            for (const file of files) {
                const messageId = file.replace('.json', '');
                try {
                    const envelope = await store.get(messageId);
                    if (envelope && (envelope.delivery.phase === 'delivered' || envelope.delivery.phase === 'read')) {
                        fs.unlinkSync(path.join(machinePath, file));
                        cleaned++;
                    }
                }
                catch {
                    // @silent-fallback-ok — individual file cleanup failure
                }
            }
        }
        catch {
            // @silent-fallback-ok — directory read failure
        }
    }
    return cleaned;
}
/**
 * Build the agent list for heartbeat extensions.
 * Reads from the machine-wide agent registry.
 */
export function buildAgentList() {
    const registryPath = path.join(os.homedir(), '.instar', 'registry.json');
    try {
        if (!fs.existsSync(registryPath))
            return [];
        const raw = fs.readFileSync(registryPath, 'utf-8');
        const registry = JSON.parse(raw);
        if (!registry?.agents || !Array.isArray(registry.agents))
            return [];
        return registry.agents
            .filter((a) => a.status === 'running' || a.status === 'registered')
            .map((a) => ({
            name: a.name,
            port: a.port ?? 0,
            status: a.status === 'running' ? 'running' : 'stale',
        }));
    }
    catch {
        // @silent-fallback-ok — registry read failure
        return [];
    }
}
/**
 * Resolve which machine an agent is on by scanning received heartbeat data.
 *
 * Returns the machine ID and URL if the agent is found in any heartbeat's agent list,
 * or null if not found.
 */
export function resolveAgentMachine(agentName, heartbeats) {
    for (const [machineId, hb] of heartbeats) {
        if (!hb.agents)
            continue;
        const agent = hb.agents.find(a => a.name === agentName && a.status === 'running');
        if (agent && hb.url) {
            return { machineId, url: hb.url, port: agent.port };
        }
    }
    return null;
}
// ── Helpers ─────────────────────────────────────────────────────
function unlinkSafe(filePath) {
    try {
        fs.unlinkSync(filePath);
    }
    catch {
        // @silent-fallback-ok — cleanup failure is non-critical
    }
}
//# sourceMappingURL=GitSyncTransport.js.map