/**
 * Shared directory skip-set for repo-structure walkers (ProjectMapper, the
 * Cartographer doc-tree, …). Extracted to one exported source of truth so the
 * walkers cannot drift apart (cartographer-doc-tree-schema spec, round-1
 * integration finding). `.instar` / `.claude` are mandatory members: a walker
 * that does not skip them maps its own state and never terminates cleanly.
 */
export const DEFAULT_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.vercel',
  '.turbo', '.cache', 'coverage', '.nyc_output', '__pycache__',
  '.instar', '.claude', '.agent-kit',
]);
