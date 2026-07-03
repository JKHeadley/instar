// class-closure-grader.mjs — the SELF-CONTAINED deterministic guard grader used
// by the class-closure gate's CI lint (scripts/class-closure-lint.mjs).
//
// WHY self-contained: PR-gate lints run on a fresh checkout with NO build step
// (decision-audit-gate.yml precedent), so the lint cannot import the TS grader
// from dist/. This mirrors the EXACT classification rules of
// src/core/StandardsEnforcementAuditor.ts::classifyFileGuard/gradeGuardCitation;
// tests/unit/class-closure-grader-parity.test.ts pins the two implementations
// equivalent so they cannot drift (Structure > Willpower).
//
// The spec's rule (docs/specs/class-closure-gate.md → Piece 1 guardEvidence):
// a citation that does not RESOLVE to a live enforcing guard — resolved:false,
// or a resolved kind of `spec-only` — downgrades the closure declaration to
// `gap` (G3: a dark/spec-only artifact guards nothing). Only ratchet/gate/lint
// count as a live enforcing guard. Grader erroring ⇒ downgrade to gap
// (fail-closed).

import fs from 'node:fs';
import path from 'node:path';

/** Classify a VERIFIED file ref into its guard weight (mirror of classifyFileGuard). */
export function classifyFileGuard(ref) {
  const base = ref.split('/').pop() ?? ref;
  if (/\.test\.(ts|js|mjs)$/.test(base) || base.startsWith('no-') || /-coverage\.(mjs|js)$/.test(base)) {
    return 'ratchet';
  }
  if (ref.startsWith('scripts/') && base.startsWith('lint-')) return 'lint';
  if (ref.startsWith('.husky/') || /precommit/i.test(base)) return 'gate';
  if (ref.startsWith('scripts/')) return 'lint';
  if (ref.startsWith('docs/specs/')) return 'spec-only';
  if (ref.startsWith('docs/')) return 'spec-only';
  if (ref.startsWith('src/')) return 'gate';
  return 'spec-only';
}

/** Scan src/server/*.ts for router.<verb>('...') tokens (mirror of loadRouteTable). */
function loadRouteTable(projectDir) {
  const serverDir = path.join(projectDir, 'src', 'server');
  const out = new Set();
  let files;
  try {
    files = fs.readdirSync(serverDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  } catch {
    return out;
  }
  const re = /router\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  for (const f of files) {
    let content;
    try { content = fs.readFileSync(path.join(serverDir, f), 'utf-8'); } catch { continue; }
    for (const m of content.matchAll(re)) out.add(`${m[1].toUpperCase()} ${m[2]}`);
  }
  return out;
}

/** Bounded grep for a single symbol across src/** (mirror of buildSymbolIndex, size 1). */
function symbolExists(projectDir, symbol) {
  const srcDir = path.join(projectDir, 'src');
  try { if (!fs.statSync(srcDir).isDirectory()) return false; } catch { return false; }
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\b`);
  const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
  let readBytes = 0;
  let found = false;
  const walk = (dir) => {
    if (found) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (found) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        walk(full);
      } else if (/\.(ts|js|mjs|cjs)$/.test(e.name)) {
        if (readBytes > MAX_TOTAL_BYTES) return;
        let content;
        try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
        readBytes += content.length;
        if (re.test(content)) { found = true; return; }
      }
    }
  };
  walk(srcDir);
  return found;
}

/**
 * Grade a single guard citation against a repo checkout. Mirror of
 * StandardsEnforcementAuditor.gradeGuardCitation.
 * @returns {{ resolved: boolean, kind: string|null, citation: string }}
 */
export function gradeGuardCitation(projectDir, citation) {
  const raw = (citation ?? '').trim();
  if (!raw) return { resolved: false, kind: null, citation: raw };

  const routeMatch = /^(GET|POST|PUT|DELETE|PATCH)\s+(\/\S+)$/i.exec(raw);
  if (routeMatch) {
    const token = `${routeMatch[1].toUpperCase()} ${routeMatch[2]}`;
    const resolved = loadRouteTable(projectDir).has(token);
    return { resolved, kind: resolved ? 'gate' : null, citation: raw };
  }

  if (raw.includes('/')) {
    const filePart = raw.split('#')[0].split(':')[0];
    let resolved = false;
    try { resolved = fs.existsSync(path.join(projectDir, filePart)); } catch { resolved = false; }
    return { resolved, kind: resolved ? classifyFileGuard(filePart) : null, citation: raw };
  }

  const resolved = symbolExists(projectDir, raw);
  return { resolved, kind: resolved ? 'gate' : null, citation: raw };
}

/**
 * The closure verdict for a `guard` declaration: does the cited guard actually
 * enforce (ratchet/gate/lint + resolved)? Otherwise the declaration downgrades
 * to `gap`. Any thrown error ⇒ downgrade to gap (fail-closed).
 * @returns {{ effectiveClosure: 'guard'|'gap', gradedKind: string|null, resolved: boolean, downgradeReason: string|null }}
 */
export function evaluateGuardClosure(projectDir, citation) {
  try {
    const g = gradeGuardCitation(projectDir, citation);
    const enforcing = g.resolved && (g.kind === 'ratchet' || g.kind === 'gate' || g.kind === 'lint');
    if (enforcing) {
      return { effectiveClosure: 'guard', gradedKind: g.kind, resolved: true, downgradeReason: null };
    }
    const reason = !g.resolved
      ? `guard citation "${citation}" does not resolve to a live guard on disk`
      : `guard citation "${citation}" graded ${g.kind} — not a live enforcing guard (ratchet/gate/lint required)`;
    return { effectiveClosure: 'gap', gradedKind: g.kind, resolved: g.resolved, downgradeReason: reason };
  } catch (err) {
    return {
      effectiveClosure: 'gap',
      gradedKind: null,
      resolved: false,
      downgradeReason: `grader error (fail-closed): ${err && err.message ? err.message : String(err)}`,
    };
  }
}
