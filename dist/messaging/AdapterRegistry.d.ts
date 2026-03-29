/**
 * AdapterRegistry — Factory pattern for messaging adapters.
 *
 * Replaces hardcoded adapter creation in server.ts with a registry that
 * any adapter type can register into. Future-proofs for community-contributed
 * adapters (Discord, Slack, etc.)
 */
import type { MessagingAdapter } from '../core/types.js';
type AdapterConstructor = new (config: Record<string, unknown>, stateDir: string) => MessagingAdapter;
/** Register an adapter type. Call at module load time. */
export declare function registerAdapter(type: string, ctor: AdapterConstructor): void;
/** Create an adapter instance from config. Throws if type is unknown. */
export declare function createAdapter(config: {
    type: string;
    enabled: boolean;
    config: Record<string, unknown>;
}, stateDir: string): MessagingAdapter;
/** Check if an adapter type is registered. */
export declare function hasAdapter(type: string): boolean;
/** Get all registered adapter type names. */
export declare function getRegisteredAdapters(): string[];
/** Remove an adapter registration (mainly for testing). */
export declare function unregisterAdapter(type: string): boolean;
/** Clear all registrations (mainly for testing). */
export declare function clearRegistry(): void;
export {};
//# sourceMappingURL=AdapterRegistry.d.ts.map