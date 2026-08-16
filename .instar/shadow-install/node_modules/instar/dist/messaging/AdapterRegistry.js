/**
 * AdapterRegistry — Factory pattern for messaging adapters.
 *
 * Replaces hardcoded adapter creation in server.ts with a registry that
 * any adapter type can register into. Future-proofs for community-contributed
 * adapters (Discord, Slack, etc.)
 */
const registry = new Map();
/** Register an adapter type. Call at module load time. */
export function registerAdapter(type, ctor) {
    if (registry.has(type)) {
        console.warn(`[adapter-registry] Overwriting existing adapter type: ${type}`);
    }
    registry.set(type, ctor);
}
/** Create an adapter instance from config. Throws if type is unknown. */
export function createAdapter(config, stateDir) {
    const Ctor = registry.get(config.type);
    if (!Ctor) {
        throw new Error(`Unknown messaging adapter: "${config.type}". Available: ${[...registry.keys()].join(', ') || 'none'}`);
    }
    return new Ctor(config.config, stateDir);
}
/** Check if an adapter type is registered. */
export function hasAdapter(type) {
    return registry.has(type);
}
/** Get all registered adapter type names. */
export function getRegisteredAdapters() {
    return [...registry.keys()];
}
/** Remove an adapter registration (mainly for testing). */
export function unregisterAdapter(type) {
    return registry.delete(type);
}
/** Clear all registrations (mainly for testing). */
export function clearRegistry() {
    registry.clear();
}
//# sourceMappingURL=AdapterRegistry.js.map