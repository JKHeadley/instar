/**
 * The vitest config that collects a test file, for scripts that run before
 * TypeScript is compiled. Mirrors LANES in src/localVerify/inventory.ts;
 * tests/unit/vitest-lane-callers.test.ts keeps the two in agreement.
 *
 * `npm test` (vitest.config.ts) is the unit lane only, so naming an integration
 * or e2e file without its lane config runs nothing ("No test files found").
 */
export const LANE_CONFIGS = Object.freeze([
  { prefix: 'tests/integration/', config: 'vitest.integration.config.ts' },
  { prefix: 'tests/e2e/', config: 'vitest.e2e.config.ts' },
]);

export function vitestConfigForTestPath(file) {
  const p = String(file).replace(/\\/g, '/').replace(/^\.\//, '');
  const hit = LANE_CONFIGS.find((l) => p.startsWith(l.prefix));
  return hit ? hit.config : 'vitest.config.ts';
}
