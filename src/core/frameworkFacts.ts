/**
 * The single mapping from a user-typed framework name to a canonical
 * framework id.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Round-21 found two independent resolvers for the same `INSTAR_FRAMEWORK`
 * environment variable that disagreed on exactly the two most recently added
 * frameworks:
 *
 *     Config.resolveConfiguredFramework   'grok' -> 'grok-build'
 *     frameworkFromEnv (provider factory) 'grok' -> null
 *
 * `Config`'s copy carries a comment describing this precise defect — "the
 * agent built to run on grok would silently have run on Claude" — from when
 * it was fixed THERE. The sibling forty files away was never swept, so the
 * same variable meant different things depending on which resolver happened
 * to read it. Config's win is masked on the server boot path, but the factory
 * copy is live in the route and reflect commands.
 *
 * Two resolvers cannot be kept in agreement by intent; this is a leaf module
 * (type-only import, no runtime dependencies) so every resolver can share one
 * table without an import cycle.
 */
import type { IntelligenceFramework } from './intelligenceProviderFactory.js';

/**
 * Accepted spellings, canonical id LAST-resolved from one table.
 *
 * Both the full id and the short alias are accepted for every framework —
 * an asymmetry here (short alias for some, not others) is the same drift in
 * miniature.
 */
export const FRAMEWORK_ALIASES: Readonly<Record<string, IntelligenceFramework>> = {
  'claude': 'claude-code',
  'claude-code': 'claude-code',
  'codex': 'codex-cli',
  'codex-cli': 'codex-cli',
  'gemini': 'gemini-cli',
  'gemini-cli': 'gemini-cli',
  'pi': 'pi-cli',
  'pi-cli': 'pi-cli',
  'grok': 'grok-build',
  'grok-build': 'grok-build',
};

/**
 * Resolve a user-supplied framework name, or null when it is not recognised.
 * Trims and lowercases, matching the historical behaviour of both callers.
 */
export function resolveFrameworkAlias(raw: string | undefined | null): IntelligenceFramework | null {
  const key = raw?.trim().toLowerCase();
  if (!key) return null;
  return FRAMEWORK_ALIASES[key] ?? null;
}

/**
 * Frameworks whose CLI exposes NO usage/quota surface, so no quota reading for
 * them can be genuine.
 *
 * grok-build 1.0.4 has no `usage`-style command and reports nothing about
 * remaining allowance, which is why its quota state is specified as permanently
 * 'unknown' rather than a number. Round-21 found that guarantee resting
 * entirely on one field staying null: a quota snapshot written through an
 * ordinary authenticated update was accepted verbatim, and the headroom
 * calculation downstream then emitted a numeric percentage with
 * `degraded: false`, bypassing the unknown branch completely.
 *
 * Stated once, here, because the fact was previously hardcoded inline at the
 * point of use — which is how a second point of use comes to disagree with it.
 */
const NO_USAGE_SURFACE: ReadonlySet<IntelligenceFramework> = new Set<IntelligenceFramework>([
  'grok-build',
]);

export function frameworkHasNoUsageSurface(framework: string | undefined | null): boolean {
  return framework !== null && framework !== undefined
    && NO_USAGE_SURFACE.has(framework as IntelligenceFramework);
}
