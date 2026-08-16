/**
 * eli16-overview-check.mjs — shared check for ELI16 spec companion files.
 *
 * Used by both instar-dev-precommit.js (commit-time gate) and
 * skills/spec-converge/scripts/write-convergence-tag.mjs (convergence-time gate)
 * to enforce that every approved spec ships with a plain-English ELI16
 * overview alongside the technical spec.
 *
 * Resolution:
 *   1. Frontmatter `eli16-overview: <relative-path>` (relative to spec dir) wins.
 *   2. Default sibling `<spec-basename>.eli16.md` next to the spec.
 *
 * The companion must be at least MIN_ELI16_CHARS of trimmed content (a stub
 * isn't an overview).
 */

import fs from 'node:fs';
import path from 'node:path';

export const MIN_ELI16_CHARS = 800;

/**
 * Resolve the ELI16 companion for a spec.
 *
 * @param {string} specPath  Absolute path to the spec file.
 * @param {string} specFm    Spec frontmatter body (between the `---` lines).
 * @returns {{ resolvedPath: string|null, source: 'frontmatter'|'sibling'|null, siblingPath: string }}
 */
export function resolveEli16Path(specPath, specFm) {
  const specDir = path.dirname(specPath);
  const specBase = path.basename(specPath, '.md');
  const siblingPath = path.join(specDir, `${specBase}.eli16.md`);
  const fmMatch = specFm.match(/^\s*eli16-overview\s*:\s*["']?([^"'\n]+)/m);
  if (fmMatch) {
    const declared = fmMatch[1].trim().replace(/["']/g, '');
    return {
      resolvedPath: path.resolve(specDir, declared),
      source: 'frontmatter',
      siblingPath,
    };
  }
  if (fs.existsSync(siblingPath)) {
    return { resolvedPath: siblingPath, source: 'sibling', siblingPath };
  }
  return { resolvedPath: null, source: null, siblingPath };
}

/**
 * Verify a spec's ELI16 companion exists and is non-stub.
 *
 * @param {string} specPath  Absolute path to the spec file.
 * @param {string} specFm    Spec frontmatter body (between the `---` lines).
 * @returns {{ ok: true, eli16Path: string, charCount: number } |
 *           { ok: false, reason: 'missing'|'declared-not-found'|'too-short',
 *             siblingPath: string, declaredPath?: string, charCount?: number,
 *             minChars: number }}
 */
export function checkEli16Overview(specPath, specFm) {
  const { resolvedPath, source, siblingPath } = resolveEli16Path(specPath, specFm);
  if (!resolvedPath) {
    return { ok: false, reason: 'missing', siblingPath, minChars: MIN_ELI16_CHARS };
  }
  if (!fs.existsSync(resolvedPath)) {
    return {
      ok: false,
      reason: 'declared-not-found',
      siblingPath,
      declaredPath: resolvedPath,
      minChars: MIN_ELI16_CHARS,
    };
  }
  const content = fs.readFileSync(resolvedPath, 'utf8');
  const charCount = content.trim().length;
  if (charCount < MIN_ELI16_CHARS) {
    return {
      ok: false,
      reason: 'too-short',
      siblingPath,
      declaredPath: resolvedPath,
      charCount,
      minChars: MIN_ELI16_CHARS,
    };
  }
  return { ok: true, eli16Path: resolvedPath, charCount, source };
}
