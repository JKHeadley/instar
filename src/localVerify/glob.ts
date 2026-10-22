/**
 * Minimal, deterministic path-glob matcher for local-verify (spec
 * docs/specs/local-verify-merge-authority.md §2). Supports `**` (zero or more
 * path segments), `*` (anything but `/`) and `?` (one non-`/` character).
 * Paths are repo-relative with forward slashes. No dependency, so the trusted
 * side never loads a matcher from the PR's node_modules.
 */

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const hit = cache.get(glob);
  if (hit) return hit;
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more whole segments; a trailing `**` matches the rest.
        if (glob[i + 2] === '/') {
          re += '(?:[^/]+/)*';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  re += '$';
  const out = new RegExp(re);
  cache.set(glob, out);
  return out;
}

/** Normalise a path to the repo-relative forward-slash form the globs expect. */
export function normalizePath(p: string): string {
  let out = p.replace(/\\/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  return out;
}

export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(normalizePath(path));
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => matchesGlob(path, g));
}
