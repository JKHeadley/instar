#!/usr/bin/env node
/**
 * lint-emit-without-admit.js — the SelfActionGovernor usage-scan lint
 * (unified-self-action-backpressure companion §9; spec SEC5-1/ADV5-8,
 * SEC6-4/ADV6-4, SEC8-1/ADV8-3, SEC9-1, INT9-2).
 *
 * Scan scope is CODEBASE-WIDE HANDLE USAGE over src/: `governor.for()` AND
 * `admit()`/`admitSync()` usage of the minted handle — in EVERY file. The
 * controller id is the runtime POLICY SELECTOR (including the privileged
 * lanes), so it is bound at registration + sink, never caller-chosen.
 *
 * RULES (each violation fails the build — this lint is FAIL-CLOSED):
 *  1. `governor.for(<arg>)` requires a STRING-LITERAL id; a variable/dynamic
 *     id is forbidden (a raw string-keyed policy selector at an emit site).
 *  2. A file calling `governor.for('<id>')` must carry a matching
 *     `@self-action-controller: <id>` marker AND be LICENSED for <id> — the
 *     registry-named file (the parseable `modelsPath:` field) or the explicit
 *     per-controller file allowlist for legitimately multi-file controllers.
 *  3. EVERY `@self-action-controller: <id>` marker must sit in a licensed
 *     file (a copy-pasted second file declaring an existing marker fails) and
 *     an id may not be declared twice in one file.
 *  4. A file importing the `governor` handle surface without any marker fails
 *     (rogue helper-file import) unless it rides the SELF-SCOPE allowlist
 *     (the governor module itself, the enumerated principalAdmit entry
 *     surfaces, and the test registry — companion INT9-2).
 *  5. `principalAdmit` / the `origin: 'principal'` literal are build-forbidden
 *     outside the enumerated principal entry-surface modules (FD13).
 *  6. A minted handle may only be USED as `<handle>.admit(...)` /
 *     `<handle>.admitSync(...)` / `<handle>.isDead()` — it may never be
 *     EXPORTED or PASSED AS A VALUE beyond the controller's licensed files
 *     (SEC9-1 widening).
 *  7. The first argument of `.admit()`/`.admitSync()` on a minted handle must
 *     be the controller's canonical `deriveTargetKey(...)` derivation (or an
 *     identifier assigned from one) — never a raw inline expression
 *     (target-granularity invariant, spec LA4-M1).
 *
 * Usage:
 *   node scripts/lint-emit-without-admit.js            # full repo
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

const GOVERNOR_MODULE_RE = /from\s+['"][^'"]*selfaction\/(?:governor|index)(?:\.js)?['"]/;
const IMPORTS_GOVERNOR_HANDLE_RE = /import\s*\{[^}]*\bgovernor\b[^}]*\}\s*from\s+['"][^'"]*selfaction\/(?:governor|index)(?:\.js)?['"]/;
const MARKER_RE = /@self-action-controller\s*:\s*([A-Za-z0-9_-]+)/g;
const FOR_CALL_RE = /\bgovernor\s*\.\s*for\s*\(\s*([^)]*?)\s*\)/g;
const HANDLE_DECL_RE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*governor\s*\.\s*for\s*\(/g;
const PRINCIPAL_TOKEN_RE = /\bprincipalAdmit\b|origin\s*:\s*['"`]principal['"`]/;

/** The usage-scan lint's SELF-SCOPE (companion INT9-2): the governor module,
 *  the enumerated principalAdmit entry surfaces, and the test registry. */
export const SELF_SCOPE_ALLOWLIST = new Set([
  'src/monitoring/selfaction/governor.ts',
  'src/monitoring/selfaction/anchor.ts',
  'src/monitoring/selfaction/policies.ts',
  'src/monitoring/selfaction/types.ts',
  'src/testing/selfActionRegistry.ts',
]);

/** The enumerated principal entry-surface modules (FD13): the dual-use sink
 *  entry surfaces + the MessageSentinel interceptor. The Tier-3 inventory
 *  asserts this enumeration matches the dual-use sink list. */
export const PRINCIPAL_SURFACE_ALLOWLIST = new Set([
  'src/monitoring/selfaction/governor.ts',
  'src/monitoring/selfaction/types.ts',
  'src/server/routes.ts', // DELETE /sessions/:id + POST /sessions/:name/remote-close (PIN-distinguishable)
]);

/** Per-controller file allowlist for legitimately MULTI-FILE controllers
 *  (mint ONCE, import the handle; the allowlist licenses declaration, not
 *  duplicate minting). Every controller's registry-named file (modelsPath)
 *  is implicitly licensed. */
export const CONTROLLER_FILE_ALLOWLIST = {
  'external-hog-kill-breaker': [
    'src/monitoring/ExternalHogSentinel.ts',
    'src/monitoring/ExternalHogScanTick.ts',
  ],
};

/** Parse `id:` + `modelsPath:` pairs out of the registry source. */
export function loadRegistryBindings(registrySource) {
  const bindings = new Map();
  if (typeof registrySource !== 'string') return bindings;
  // Entries are object literals with id + modelsPath fields; pair them by
  // proximity (modelsPath follows its id within the same literal).
  const re = /\bid:\s*['"`]([A-Za-z0-9_-]+)['"`][\s\S]*?\bmodelsPath:\s*['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = re.exec(registrySource)) !== null) bindings.set(m[1], m[2]);
  return bindings;
}

function licensedFilesFor(id, bindings, allowlist) {
  const files = new Set(allowlist[id] ?? []);
  const modelsPath = bindings.get(id);
  if (modelsPath) files.add(modelsPath);
  return files;
}

function stripCommentsKeepMarkers(content) {
  // The marker lives in comments, so parse markers BEFORE stripping; the
  // usage checks run on comment-stripped content to avoid prose hits.
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (s, p1) => p1 + ' '.repeat(s.length - p1.length));
}

/**
 * Pure evaluation over a prepared file set — exported for tests.
 * @param {{ files: string[], registrySource: string, readFile: (rel:string)=>string|null,
 *           selfScope?: Set<string>, principalScope?: Set<string>,
 *           controllerAllowlist?: Record<string,string[]> }} input
 */
export function evaluateEmitWithoutAdmit({
  files,
  registrySource,
  readFile,
  selfScope = SELF_SCOPE_ALLOWLIST,
  principalScope = PRINCIPAL_SURFACE_ALLOWLIST,
  controllerAllowlist = CONTROLLER_FILE_ALLOWLIST,
}) {
  const bindings = loadRegistryBindings(registrySource);
  const violations = [];
  const markerFilesById = new Map();
  let considered = 0;

  for (const rel of files) {
    const norm = rel.split(path.sep).join('/');
    if (!norm.endsWith('.ts')) continue;
    if (/(^|\/)tests\//.test(norm) || /\.test\.ts$/.test(norm) || /\.d\.ts$/.test(norm)) continue;
    const content = readFile(norm);
    if (content == null) continue;
    considered += 1;

    // Collect markers (from the raw content — they live in comments).
    const markers = [];
    let mm;
    MARKER_RE.lastIndex = 0;
    while ((mm = MARKER_RE.exec(content)) !== null) markers.push(mm[1]);
    const markerSet = new Set(markers);
    if (markers.length !== markerSet.size) {
      violations.push({ file: norm, rule: 'duplicate-marker', detail: 'the same @self-action-controller id is declared twice in one file' });
    }
    for (const id of markerSet) {
      const prior = markerFilesById.get(id) ?? [];
      prior.push(norm);
      markerFilesById.set(id, prior);
      const licensed = licensedFilesFor(id, bindings, controllerAllowlist);
      if (!selfScope.has(norm) && licensed.size > 0 && !licensed.has(norm)) {
        violations.push({
          file: norm,
          rule: 'unlicensed-marker',
          detail: `marker '${id}' declared in a file that is neither the registry-named file (${bindings.get(id) ?? 'none'}) nor on the per-controller allowlist`,
        });
      }
    }

    const code = stripCommentsKeepMarkers(content);
    const isSelfScope = selfScope.has(norm);

    // Rule 5 — principal lane scope.
    if (PRINCIPAL_TOKEN_RE.test(code) && !principalScope.has(norm)) {
      violations.push({
        file: norm,
        rule: 'principal-outside-allowlist',
        detail: 'principalAdmit / the origin:\'principal\' literal is build-forbidden outside the enumerated principal entry surfaces (FD13)',
      });
    }

    // Rule 4 — importing the handle surface requires a marker (or self-scope /
    // an enumerated principal entry surface, which imports `governor` for the
    // separate privileged principalAdmit API).
    if (IMPORTS_GOVERNOR_HANDLE_RE.test(code) && !isSelfScope && !principalScope.has(norm) && markerSet.size === 0) {
      violations.push({
        file: norm,
        rule: 'handle-import-without-marker',
        detail: 'file imports the governor handle surface with no @self-action-controller marker (rogue helper-file import — SEC8-1/ADV8-3)',
      });
    }

    // Rules 1 + 2 — governor.for() usage.
    const handleVars = new Set();
    let hd;
    HANDLE_DECL_RE.lastIndex = 0;
    while ((hd = HANDLE_DECL_RE.exec(code)) !== null) handleVars.add(hd[1]);
    let fc;
    FOR_CALL_RE.lastIndex = 0;
    while ((fc = FOR_CALL_RE.exec(code)) !== null) {
      if (isSelfScope) continue; // the governor module + test registry mint internally
      const arg = fc[1].trim();
      const lit = /^['"`]([A-Za-z0-9_-]+)['"`]$/.exec(arg);
      if (!lit) {
        violations.push({ file: norm, rule: 'dynamic-controller-id', detail: `governor.for(${arg}) — the controller id must be a string literal` });
        continue;
      }
      const id = lit[1];
      if (!markerSet.has(id)) {
        violations.push({ file: norm, rule: 'mint-without-marker', detail: `governor.for('${id}') in a file with no matching @self-action-controller marker` });
      }
      const licensed = licensedFilesFor(id, bindings, controllerAllowlist);
      if (licensed.size > 0 && !licensed.has(norm)) {
        violations.push({ file: norm, rule: 'unlicensed-mint', detail: `governor.for('${id}') in a file that is not the registry-named file for '${id}' (${bindings.get(id) ?? 'none'}) nor allowlisted` });
      }
      if (!bindings.has(id) && !(controllerAllowlist[id]?.length > 0)) {
        violations.push({ file: norm, rule: 'unbound-controller', detail: `controller '${id}' has no registry modelsPath binding and no file allowlist — promote the models: pointer to a parseable modelsPath` });
      }
    }

    // Rule 6 — handle leak (export / passed as a value) + Rule 7 — the
    // deriveTargetKey binding on admit call sites.
    for (const v of handleVars) {
      const usageRe = new RegExp(String.raw`\b${v}\b`, 'g');
      let um;
      while ((um = usageRe.exec(code)) !== null) {
        const rest = code.slice(um.index + v.length);
        const before = code.slice(Math.max(0, um.index - 40), um.index);
        const isDecl = new RegExp(String.raw`(?:const|let|var)\s+$`).test(before);
        const isMemberUse = /^\s*\.\s*(admit|admitSync|isDead)\s*\(/.test(rest) || /^\s*\.\s*controllerId\b/.test(rest);
        if (isDecl || isMemberUse) continue;
        violations.push({
          file: norm,
          rule: 'handle-leak',
          detail: `handle '${v}' used outside <handle>.admit/.admitSync/.isDead — a handle may never be exported or passed as a value (SEC9-1)`,
        });
        break; // one leak violation per handle var
      }
      // Rule 7: every admit first-arg must be a deriveTargetKey derivation.
      const admitRe = new RegExp(String.raw`\b${v}\s*\.\s*admit(?:Sync)?\s*\(`, 'g');
      let am;
      while ((am = admitRe.exec(code)) !== null) {
        const argStart = am.index + am[0].length;
        const argText = code.slice(argStart, argStart + 220);
        const firstArg = argText.split(/[,)]/)[0]?.trim() ?? '';
        const containsDerivation = /deriveTargetKey\s*\(/.test(firstArg);
        const isIdentifier = /^[A-Za-z_$][\w$]*$/.test(firstArg);
        const identifierBoundToDerivation =
          isIdentifier && new RegExp(String.raw`\b${firstArg}\b\s*=[^=][\s\S]{0,160}?deriveTargetKey\s*\(`).test(code);
        if (!containsDerivation && !identifierBoundToDerivation) {
          violations.push({
            file: norm,
            rule: 'raw-target-expression',
            detail: `admit() target must be the controller's canonical deriveTargetKey(...) (or an identifier assigned from it) — raw inline target expressions defeat the granularity invariant`,
          });
        }
      }
    }

    // Raw string-keyed admit at an emit site (`governor.admit(...)`).
    if (/\bgovernor\s*\.\s*admit(?:Sync)?\s*\(/.test(code) && !isSelfScope) {
      violations.push({ file: norm, rule: 'raw-string-admit', detail: 'raw string-keyed governor.admit() at an emit site is forbidden — use the per-controller handle' });
    }
  }

  return { violations, considered };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function listSrcFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      listSrcFiles(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(path.relative(ROOT, full));
    }
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const files = listSrcFiles(path.join(ROOT, 'src'));
  let registrySource = '';
  try {
    registrySource = fs.readFileSync(path.join(ROOT, 'src', 'testing', 'selfActionRegistry.ts'), 'utf-8');
  } catch {
    registrySource = '';
  }
  const { violations, considered } = evaluateEmitWithoutAdmit({
    files,
    registrySource,
    readFile: (rel) => {
      try {
        return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      } catch {
        return null;
      }
    },
  });
  if (violations.length > 0) {
    console.error(`[lint-emit-without-admit] ${violations.length} violation(s) over ${considered} file(s):`);
    for (const v of violations) console.error(`  ${v.file} [${v.rule}]: ${v.detail}`);
    console.error('\nSee docs/specs/unified-self-action-backpressure.companion.md §9 (enforcement tooling).');
    process.exit(1);
  }
  console.log(`[lint-emit-without-admit] OK — ${considered} file(s) scanned, 0 violations.`);
}
