/**
 * Agent Registry — unified agent tracking and port allocation.
 *
 * Maintains a machine-wide registry at ~/.instar/registry.json tracking
 * ALL agents on the machine (both standalone and project-bound).
 *
 * Replaces the older PortRegistry with:
 *   - Agent type awareness (standalone vs project-bound)
 *   - Status tracking with heartbeat
 *   - File locking for safe concurrent access
 *   - Migration from legacy port-registry.json
 *
 * The canonical unique key is `path` (absolute path to the project directory).
 * Agent names are display labels only — NOT unique.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import lockfile from 'proper-lockfile';
import { getInstarVersion } from './Config.js';
// Paths are computed lazily from os.homedir() so they pick up mocks in tests
function registryDir() { return path.join(os.homedir(), '.instar'); }
function registryPath() { return path.join(registryDir(), 'registry.json'); }
function legacyRegistryPath() { return path.join(registryDir(), 'port-registry.json'); }
const DEFAULT_PORT_RANGE_START = 4040;
const DEFAULT_PORT_RANGE_END = 4099;
/** Agent name validation: alphanumeric, underscore, hyphen. Max 64 chars. */
const AGENT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const LOCK_OPTIONS_ASYNC = {
    stale: 10_000,
    retries: { retries: 5, factor: 2, minTimeout: 100 },
};
// lockSync doesn't support retries — use simple stale detection only
const LOCK_OPTIONS_SYNC = {
    stale: 10_000,
};
/**
 * Validate an agent name for use in paths and registration.
 * Rejects names with path separators, null bytes, or `..`.
 */
export function validateAgentName(name) {
    if (!name || name.includes('/') || name.includes('\\') || name.includes('\0') || name.includes('..')) {
        return false;
    }
    return AGENT_NAME_PATTERN.test(name);
}
/**
 * Check if a process with the given PID is running.
 */
function isProcessAlive(pid) {
    if (pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        // @silent-fallback-ok — signal 0 process check
        return false;
    }
}
/**
 * Ensure the registry directory exists.
 */
function ensureRegistryDir() {
    fs.mkdirSync(registryDir(), { recursive: true });
}
/**
 * Load the agent registry from disk.
 * On first load, migrates from legacy port-registry.json if present.
 * Returns an empty registry if no file exists.
 */
export function loadRegistry() {
    ensureRegistryDir();
    // If registry.json doesn't exist, try migrating from legacy
    if (!fs.existsSync(registryPath())) {
        if (fs.existsSync(legacyRegistryPath())) {
            return migrateFromPortRegistry();
        }
        return { version: 1, entries: [] };
    }
    try {
        const data = JSON.parse(fs.readFileSync(registryPath(), 'utf-8'));
        return {
            version: data.version ?? 1,
            entries: Array.isArray(data.entries) ? data.entries : [],
        };
    }
    catch {
        return { version: 1, entries: [] };
    }
}
/**
 * Save the registry to disk (atomic write via temp file + rename).
 */
export function saveRegistry(registry) {
    ensureRegistryDir();
    const tmpPath = `${registryPath()}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(registry, null, 2));
        fs.renameSync(tmpPath, registryPath());
    }
    catch (err) {
        try {
            fs.unlinkSync(tmpPath);
        }
        catch { /* ignore */ }
        throw err;
    }
}
/**
 * Execute a read-modify-write cycle on the registry with file locking.
 * Uses proper-lockfile with stale detection to prevent deadlocks.
 */
async function withLock(fn) {
    ensureRegistryDir();
    // Ensure the registry file exists before locking (proper-lockfile needs it)
    if (!fs.existsSync(registryPath())) {
        const initial = loadRegistry();
        saveRegistry(initial);
    }
    let release;
    try {
        release = await lockfile.lock(registryPath(), LOCK_OPTIONS_ASYNC);
        const registry = loadRegistry();
        const result = fn(registry);
        saveRegistry(registry);
        return result;
    }
    catch (err) {
        // If lock acquisition fails after retries, provide actionable error
        if (err instanceof Error && err.message.includes('ELOCKED')) {
            throw new Error('Registry is locked by another process. If no other instar process is running, ' +
                'delete ~/.instar/registry.json.lock and retry.');
        }
        throw err;
    }
    finally {
        if (release) {
            try {
                await release();
            }
            catch { /* ignore unlock errors */ }
        }
    }
}
/**
 * Synchronous read-modify-write (for use in sync contexts like CLI commands).
 * Uses lockfileSync variant.
 */
function withLockSync(fn) {
    ensureRegistryDir();
    // Ensure the registry file exists
    if (!fs.existsSync(registryPath())) {
        const initial = loadRegistry();
        saveRegistry(initial);
    }
    let release;
    try {
        release = lockfile.lockSync(registryPath(), LOCK_OPTIONS_SYNC);
        const registry = loadRegistry();
        const result = fn(registry);
        saveRegistry(registry);
        return result;
    }
    catch (err) {
        if (err instanceof Error && err.message.includes('ELOCKED')) {
            throw new Error('Registry is locked by another process. If no other instar process is running, ' +
                'delete ~/.instar/registry.json.lock and retry.');
        }
        throw err;
    }
    finally {
        if (release) {
            try {
                release();
            }
            catch { /* ignore */ }
        }
    }
}
/**
 * Migrate from legacy port-registry.json to the new agent registry.
 */
function migrateFromPortRegistry() {
    try {
        const legacyData = JSON.parse(fs.readFileSync(legacyRegistryPath(), 'utf-8'));
        const legacyEntries = Array.isArray(legacyData.entries) ? legacyData.entries : [];
        const registry = {
            version: 1,
            entries: legacyEntries.map(e => ({
                name: e.projectName,
                type: 'project-bound',
                path: e.projectDir,
                port: e.port,
                pid: e.pid,
                status: 'stopped',
                createdAt: e.registeredAt,
                lastHeartbeat: e.lastHeartbeat,
            })),
        };
        saveRegistry(registry);
        // Rename legacy file to mark migration complete
        fs.renameSync(legacyRegistryPath(), legacyRegistryPath() + '.migrated');
        console.log('[AgentRegistry] Migrated from port-registry.json');
        return registry;
    }
    catch {
        return { version: 1, entries: [] };
    }
}
/**
 * Check if a path is in a temporary/ephemeral directory.
 */
function isEphemeralPath(p) {
    const normalized = path.resolve(p);
    const tmpDir = os.tmpdir();
    return normalized.startsWith(tmpDir) ||
        normalized.startsWith('/tmp/') ||
        normalized.startsWith('/var/folders/') ||
        normalized.startsWith('/private/tmp/') ||
        normalized.startsWith('/private/var/folders/');
}
const STALE_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
/**
 * Remove stale entries where the process is no longer running.
 * Prunes entries that are stale AND either from ephemeral paths or expired (>1 hour).
 * Returns the cleaned registry (mutates in-place for efficiency).
 */
export function cleanStaleEntries(registry) {
    const now = Date.now();
    registry.entries = registry.entries.filter(entry => {
        // Mark running entries with dead processes as stale
        if (entry.status === 'running' && !isProcessAlive(entry.pid)) {
            console.log(`[AgentRegistry] Marking stale: ${entry.name} (port ${entry.port}, pid ${entry.pid} dead)`);
            entry.status = 'stale';
        }
        // Remove stale entries from ephemeral paths (test runs, temp dirs)
        if (entry.status === 'stale' && isEphemeralPath(entry.path)) {
            console.log(`[AgentRegistry] Pruning ephemeral: ${entry.name} (${entry.path})`);
            return false;
        }
        // Remove stale entries that have been dead for over 1 hour
        if (entry.status === 'stale') {
            const heartbeat = entry.lastHeartbeat ? new Date(entry.lastHeartbeat).getTime() : 0;
            if (now - heartbeat > STALE_EXPIRY_MS) {
                console.log(`[AgentRegistry] Pruning expired: ${entry.name} (stale for ${Math.round((now - heartbeat) / 60_000)}m)`);
                return false;
            }
        }
        return true;
    });
    return registry;
}
/**
 * Register an agent (add or update by canonical path).
 */
export function registerAgent(agentPath, name, port, type = 'project-bound', pid) {
    withLockSync(registry => {
        cleanStaleEntries(registry);
        const canonicalPath = path.resolve(agentPath);
        // Check for port conflicts with other RUNNING agents (stale entries can't own ports)
        const conflict = registry.entries.find(e => e.port === port && e.path !== canonicalPath && e.status === 'running');
        if (conflict) {
            throw new Error(`Port ${port} is already in use by "${conflict.name}" (pid ${conflict.pid}). ` +
                `Change the port in .instar/config.json or use a different port.`);
        }
        // Find existing entry by canonical path
        const existingIdx = registry.entries.findIndex(e => e.path === canonicalPath);
        const now = new Date().toISOString();
        if (existingIdx >= 0) {
            // Update existing
            const existing = registry.entries[existingIdx];
            existing.name = name;
            existing.port = port;
            existing.pid = pid ?? process.pid;
            existing.status = 'running';
            existing.lastHeartbeat = now;
            existing.type = type;
            existing.instarVersion = getInstarVersion();
        }
        else {
            // New entry
            registry.entries.push({
                name,
                type,
                path: canonicalPath,
                port,
                pid: pid ?? process.pid,
                status: 'running',
                createdAt: now,
                lastHeartbeat: now,
                instarVersion: getInstarVersion(),
            });
        }
    });
}
/**
 * Unregister an agent by its canonical path.
 */
export function unregisterAgent(agentPath) {
    const canonicalPath = path.resolve(agentPath);
    withLockSync(registry => {
        registry.entries = registry.entries.filter(e => e.path !== canonicalPath);
    });
}
/**
 * Update an agent's status and optionally its PID.
 */
export function updateStatus(agentPath, status, pid) {
    const canonicalPath = path.resolve(agentPath);
    withLockSync(registry => {
        const entry = registry.entries.find(e => e.path === canonicalPath);
        if (entry) {
            entry.status = status;
            if (pid !== undefined)
                entry.pid = pid;
            entry.lastHeartbeat = new Date().toISOString();
        }
    });
}
/**
 * Update the heartbeat for an agent by canonical path.
 */
export function heartbeat(agentPath) {
    const canonicalPath = path.resolve(agentPath);
    withLockSync(registry => {
        const entry = registry.entries.find(e => e.path === canonicalPath);
        if (entry) {
            entry.lastHeartbeat = new Date().toISOString();
            entry.pid = process.pid;
        }
    });
}
/**
 * Force-remove a stale registry lock file.
 * Used as a recovery mechanism when proper-lockfile's stale detection fails
 * (e.g., after a mutex crash leaves the lock in an inconsistent state).
 */
export function forceRemoveRegistryLock() {
    const lockPath = registryPath() + '.lock';
    try {
        if (fs.existsSync(lockPath)) {
            fs.rmSync(lockPath, { recursive: true, force: true });
            console.log(`[AgentRegistry] Force-removed stale lock: ${lockPath}`);
            return true;
        }
    }
    catch (err) { // @silent-fallback-ok — best-effort recovery, retried on next heartbeat
        console.error(`[AgentRegistry] Failed to force-remove lock: ${err}`);
    }
    return false;
}
/**
 * Start a periodic heartbeat. Returns a cleanup function.
 * Tracks consecutive failures and force-removes the registry lock after
 * repeated failures — recovers from crash-induced stale locks.
 */
export function startHeartbeat(agentPath, intervalMs = 60_000) {
    const canonicalPath = path.resolve(agentPath);
    let consecutiveFailures = 0;
    const MAX_FAILURES_BEFORE_RECOVERY = 3;
    const interval = setInterval(() => {
        try {
            heartbeat(canonicalPath);
            consecutiveFailures = 0;
        }
        catch (err) {
            consecutiveFailures++;
            if (consecutiveFailures >= MAX_FAILURES_BEFORE_RECOVERY) {
                console.warn(`[AgentRegistry] ${consecutiveFailures} consecutive heartbeat failures — forcing lock recovery`);
                forceRemoveRegistryLock();
                try {
                    heartbeat(canonicalPath);
                    consecutiveFailures = 0;
                    console.log('[AgentRegistry] Heartbeat recovered after lock cleanup');
                }
                catch (retryErr) {
                    console.error(`[AgentRegistry] Heartbeat still failing after recovery: ${retryErr}`);
                }
            }
            else {
                console.error(`[AgentRegistry] Heartbeat failed (${consecutiveFailures}/${MAX_FAILURES_BEFORE_RECOVERY}): ${err}`);
            }
        }
    }, intervalMs);
    // Initial heartbeat
    try {
        heartbeat(canonicalPath);
    }
    catch { /* ignore */ }
    return () => clearInterval(interval);
}
/**
 * List all agents, optionally filtered by type and/or status.
 * Cleans stale entries before returning.
 */
export function listAgents(filter) {
    return withLockSync(registry => {
        cleanStaleEntries(registry);
        let entries = [...registry.entries];
        if (filter?.type) {
            entries = entries.filter(e => e.type === filter.type);
        }
        if (filter?.status) {
            entries = entries.filter(e => e.status === filter.status);
        }
        return entries;
    });
}
/**
 * Get a specific agent by canonical path.
 */
export function getAgent(agentPath) {
    const canonicalPath = path.resolve(agentPath);
    const registry = loadRegistry();
    return registry.entries.find(e => e.path === canonicalPath) ?? null;
}
/**
 * Synchronously check if a TCP port is free by probing for listeners.
 * Uses lsof on macOS/Linux to detect if any process is bound to the port.
 * Returns true if the port is available, false if it's in use.
 */
function isPortFreeSync(port) {
    try {
        // lsof exits 0 if a listener is found, 1 if not
        execSync(`lsof -iTCP:${port} -sTCP:LISTEN -P -n`, { stdio: 'ignore' });
        return false; // lsof found a listener → port is in use
    }
    catch {
        return true; // lsof found nothing → port is free
    }
}
/**
 * Allocate a free port from the range, avoiding conflicts.
 * If the agent already has a port, return that port.
 */
export function allocatePort(agentPath, rangeStart = DEFAULT_PORT_RANGE_START, rangeEnd = DEFAULT_PORT_RANGE_END) {
    const canonicalPath = path.resolve(agentPath);
    return withLockSync(registry => {
        cleanStaleEntries(registry);
        // Check if this agent already has a port
        const existing = registry.entries.find(e => e.path === canonicalPath);
        if (existing) {
            return existing.port;
        }
        // Collect ALL registered ports (any status) to avoid conflicts with
        // agents that may still be running but have stale registry entries
        const usedPorts = new Set(registry.entries.map(e => e.port));
        for (let port = rangeStart; port <= rangeEnd; port++) {
            if (!usedPorts.has(port) && isPortFreeSync(port)) {
                return port;
            }
        }
        throw new Error(`No free ports available in range ${rangeStart}-${rangeEnd}. ` +
            `${registry.entries.length} Instar instances are registered.`);
    });
}
// ── Backward Compatibility Wrappers ───────────────────────────────
// These functions provide the PortRegistry API using AgentRegistry internals,
// allowing a smooth migration where callers use projectName-based lookups.
/**
 * Register a port for a project (PortRegistry compatibility).
 * Uses projectDir as the canonical path key.
 */
export function registerPort(projectName, port, projectDir, pid) {
    registerAgent(projectDir, projectName, port, 'project-bound', pid);
}
/**
 * Unregister a port by project name (PortRegistry compatibility).
 * Looks up the agent by name and removes it.
 */
export function unregisterPort(projectName) {
    withLockSync(registry => {
        registry.entries = registry.entries.filter(e => e.name !== projectName);
    });
}
/**
 * Start a heartbeat by project name (PortRegistry compatibility).
 * Looks up the agent's path by name.
 */
export function startHeartbeatByName(projectName, intervalMs = 60_000) {
    const registry = loadRegistry();
    const entry = registry.entries.find(e => e.name === projectName);
    if (!entry) {
        // Fall back: just do a name-based heartbeat update with recovery
        let consecutiveFailures = 0;
        const MAX_FAILURES_BEFORE_RECOVERY = 3;
        const interval = setInterval(() => {
            try {
                withLockSync(reg => {
                    const e = reg.entries.find(en => en.name === projectName);
                    if (e) {
                        e.lastHeartbeat = new Date().toISOString();
                        e.pid = process.pid;
                    }
                });
                consecutiveFailures = 0;
            }
            catch (err) {
                consecutiveFailures++;
                if (consecutiveFailures >= MAX_FAILURES_BEFORE_RECOVERY) {
                    console.warn(`[AgentRegistry] ${consecutiveFailures} consecutive heartbeat failures — forcing lock recovery`);
                    forceRemoveRegistryLock();
                    consecutiveFailures = 0;
                }
                else {
                    console.error(`[AgentRegistry] Heartbeat failed (${consecutiveFailures}/${MAX_FAILURES_BEFORE_RECOVERY}): ${err}`);
                }
            }
        }, intervalMs);
        return () => clearInterval(interval);
    }
    return startHeartbeat(entry.path, intervalMs);
}
/**
 * List all instances (PortRegistry compatibility).
 * Returns entries in the legacy PortEntry-compatible shape.
 */
export function listInstances() {
    return listAgents();
}
/**
 * Allocate a port by project name (PortRegistry compatibility).
 */
export function allocatePortByName(projectName, rangeStart = DEFAULT_PORT_RANGE_START, rangeEnd = DEFAULT_PORT_RANGE_END) {
    return withLockSync(registry => {
        cleanStaleEntries(registry);
        // Check if this project already has a port
        const existing = registry.entries.find(e => e.name === projectName);
        if (existing) {
            return existing.port;
        }
        // Collect ALL registered ports (any status) to avoid conflicts with
        // agents that may still be running but have stale registry entries
        const usedPorts = new Set(registry.entries.map(e => e.port));
        for (let port = rangeStart; port <= rangeEnd; port++) {
            if (!usedPorts.has(port) && isPortFreeSync(port)) {
                return port;
            }
        }
        throw new Error(`No free ports available in range ${rangeStart}-${rangeEnd}. ` +
            `${registry.entries.length} Instar instances are registered.`);
    });
}
//# sourceMappingURL=AgentRegistry.js.map