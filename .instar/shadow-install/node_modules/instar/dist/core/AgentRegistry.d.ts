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
import type { AgentRegistry, AgentRegistryEntry, AgentType, AgentStatus } from './types.js';
/**
 * Validate an agent name for use in paths and registration.
 * Rejects names with path separators, null bytes, or `..`.
 */
export declare function validateAgentName(name: string): boolean;
/**
 * Load the agent registry from disk.
 * On first load, migrates from legacy port-registry.json if present.
 * Returns an empty registry if no file exists.
 */
export declare function loadRegistry(): AgentRegistry;
/**
 * Save the registry to disk (atomic write via temp file + rename).
 */
export declare function saveRegistry(registry: AgentRegistry): void;
/**
 * Remove stale entries where the process is no longer running.
 * Prunes entries that are stale AND either from ephemeral paths or expired (>1 hour).
 * Returns the cleaned registry (mutates in-place for efficiency).
 */
export declare function cleanStaleEntries(registry: AgentRegistry): AgentRegistry;
/**
 * Register an agent (add or update by canonical path).
 */
export declare function registerAgent(agentPath: string, name: string, port: number, type?: AgentType, pid?: number): void;
/**
 * Unregister an agent by its canonical path.
 */
export declare function unregisterAgent(agentPath: string): void;
/**
 * Update an agent's status and optionally its PID.
 */
export declare function updateStatus(agentPath: string, status: AgentStatus, pid?: number): void;
/**
 * Update the heartbeat for an agent by canonical path.
 */
export declare function heartbeat(agentPath: string): void;
/**
 * Force-remove a stale registry lock file.
 * Used as a recovery mechanism when proper-lockfile's stale detection fails
 * (e.g., after a mutex crash leaves the lock in an inconsistent state).
 */
export declare function forceRemoveRegistryLock(): boolean;
/**
 * Start a periodic heartbeat. Returns a cleanup function.
 * Tracks consecutive failures and force-removes the registry lock after
 * repeated failures — recovers from crash-induced stale locks.
 */
export declare function startHeartbeat(agentPath: string, intervalMs?: number): () => void;
/**
 * List all agents, optionally filtered by type and/or status.
 * Cleans stale entries before returning.
 */
export declare function listAgents(filter?: {
    type?: AgentType;
    status?: AgentStatus;
}): AgentRegistryEntry[];
/**
 * Get a specific agent by canonical path.
 */
export declare function getAgent(agentPath: string): AgentRegistryEntry | null;
/**
 * Allocate a free port from the range, avoiding conflicts.
 * If the agent already has a port, return that port.
 */
export declare function allocatePort(agentPath: string, rangeStart?: number, rangeEnd?: number): number;
/**
 * Register a port for a project (PortRegistry compatibility).
 * Uses projectDir as the canonical path key.
 */
export declare function registerPort(projectName: string, port: number, projectDir: string, pid?: number): void;
/**
 * Unregister a port by project name (PortRegistry compatibility).
 * Looks up the agent by name and removes it.
 */
export declare function unregisterPort(projectName: string): void;
/**
 * Start a heartbeat by project name (PortRegistry compatibility).
 * Looks up the agent's path by name.
 */
export declare function startHeartbeatByName(projectName: string, intervalMs?: number): () => void;
/**
 * List all instances (PortRegistry compatibility).
 * Returns entries in the legacy PortEntry-compatible shape.
 */
export declare function listInstances(): AgentRegistryEntry[];
/**
 * Allocate a port by project name (PortRegistry compatibility).
 */
export declare function allocatePortByName(projectName: string, rangeStart?: number, rangeEnd?: number): number;
//# sourceMappingURL=AgentRegistry.d.ts.map