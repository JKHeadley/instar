/**
 * Self-Knowledge Tree Types — Shared type definitions for the tree engine.
 *
 * Defines the tree config schema, search results, source types, and cache
 * structures used across all tree modules.
 *
 * Born from: PROP-XXX (Self-Knowledge Tree for Instar Agents)
 */
export const CACHE_TTL_MS = {
    identity: 4 * 60 * 60 * 1000, // 4 hours
    capabilities: 60 * 60 * 1000, // 1 hour
    state: 5 * 60 * 1000, // 5 minutes
    experience: 30 * 60 * 1000, // 30 minutes
    evolution: 60 * 60 * 1000, // 1 hour
    synthesis: 10 * 60 * 1000, // 10 minutes
};
// ── Layer-to-Tier mapping ──────────────────────────────────────────
export function layerToTier(layerId) {
    switch (layerId) {
        case 'identity': return 'identity';
        case 'capabilities': return 'capabilities';
        case 'state': return 'state';
        case 'experience': return 'experience';
        case 'evolution': return 'evolution';
        default: return 'experience'; // safe default
    }
}
//# sourceMappingURL=types.js.map