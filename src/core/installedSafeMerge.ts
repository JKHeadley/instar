/**
 * installedSafeMerge — where the running server's OWN safe-merge lives.
 *
 * The trusted side of a merge (the green-PR watcher's spawn, the local-verify
 * reconciler's floor) always comes from the installed package
 * (`<package>/scripts/safe-merge.mjs`, beside `dist/`), never from a working
 * checkout: the agent's home checkout can sit on any branch with uncommitted
 * edits (2026-10-22: it held 279 uncommitted changes and a pre-local-verify
 * safe-merge, which the watcher then ran). Spec:
 * docs/specs/local-verify-merge-authority.md §2 "Where the verifier's own code
 * comes from".
 *
 * This file sits at `src/core/` (compiled to `dist/core/`), so the package root
 * is two levels up in both layouts.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The package root of the running server (the directory holding `dist/` and `scripts/`). */
export function installedPackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** The safe-merge that ships with the running server's own install. */
export function installedSafeMergePath(): string {
  return path.join(installedPackageRoot(), 'scripts', 'safe-merge.mjs');
}
