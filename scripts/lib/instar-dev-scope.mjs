// Governed by: Observable Intelligence — No Autonomous LLM Action Is Unauditable (its Decision Provenance & Outcome Review subsection).
/**
 * instar-dev-scope.mjs — the one definition of which staged paths the
 * instar-dev pre-commit gate reviews (moved out of scripts/instar-dev-precommit.js
 * so the judgment-call grader judges landings by the same rule;
 * docs/specs/judgment-call-rating.md). The CI presence check
 * (scripts/decision-audit-presence-check.mjs) keeps its own copy for now; the
 * spec names that drift and the grader measures it.
 */
import { isUserFacingSurfaceFile } from './delight-the-user.mjs';

export function isInstarDevInScope(file) {
  // Files that require review: anything that ships behavior.
  if (file.startsWith('src/')) return true;
  if (file.startsWith('scripts/')) return true;
  if (file.startsWith('.husky/')) return true;
  if (file.startsWith('skills/') && file.endsWith('SKILL.md')) return true;
  if (file.startsWith('skills/') && (file.endsWith('.sh') || file.endsWith('.mjs') || file.endsWith('.js'))) return true;
  // A screen a person sees (dashboard, pairing pages, the public site's pages
  // and styles, approval / secret-drop pages) ships behavior too: what the
  // person sees IS the behavior. Without this a dashboard-only commit passed
  // straight through, so the Operator-Surface Quality and Delight the User
  // questions never ran on exactly the commits they exist for.
  // (Standard: docs/STANDARDS-REGISTRY.md → "Delight the User".)
  if (isUserFacingSurfaceFile(file)) return true;
  return false;
}
