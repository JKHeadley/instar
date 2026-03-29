/**
 * FeatureDefinitions — Static definitions for all opt-in features in instar.
 *
 * Each feature registers itself with the FeatureRegistry at startup.
 * Definitions are immutable at runtime — only FeatureState changes.
 *
 * To add a new opt-in feature:
 * 1. Add a FeatureDefinition to this file
 * 2. Export it from BUILTIN_FEATURES
 * 3. Ensure configPath maps to the correct InstarConfig field
 */
import type { FeatureDefinition } from './FeatureRegistry.js';
export declare const BUILTIN_FEATURES: FeatureDefinition[];
//# sourceMappingURL=FeatureDefinitions.d.ts.map