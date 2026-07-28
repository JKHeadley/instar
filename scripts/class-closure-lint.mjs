#!/usr/bin/env node
// safe-git-allow: CI-only gate script — single read-only `git diff --name-status`
//   against the Actions checkout; runs on ubuntu runners where the TS
//   SafeGitExecutor is not importable from a standalone .mjs.
/**
 * class-closure-lint — the REPORT-ONLY CI lint for the Class-Closure Gate
 * (docs/specs/class-closure-gate.md → Rollout step 1). Increment 1.
 *
 * A fix for a defect found in an AGENT-AUTHORED artifact (prompts, hooks,
 * configs, skills, standards text) is supposed to declare, in its committed
 * instar-dev decision-audit entry, WHAT CLASS of defect it is an instance of
 * and HOW the class is closed (a live guard, or a tracked gap). This lint
 * VALIDATES those declarations at the PR boundary — it does NOT mutate source
 * (the periodic escalator pass owns mutation) and, in report-only mode (the
 * increment-1 default), it prints findings and ALWAYS exits 0.
 *
 * What it does (all report-only unless enabled && !dryRun):
 *   - repo-gate: no docs/defect-classes.json ⇒ "not an instar class-closure
 *     repo", exit 0.
 *   - load + validate the class registry (a malformed registry is a HARD
 *     structural violation).
 *   - read every classClosure declaration from committed decision-audit entries
 *     (the SINGLE machine-readable counting host — C1: the side-effects mirror
 *     is display-only and NOT summed here).
 *   - grade each `closure:'guard'` citation via the self-contained grader
 *     (evaluateGuardClosure) — a citation that does not resolve to a live
 *     enforcing guard DOWNGRADES the declaration to `gap` (G3), logged.
 *   - validate `defectClass:'novel'`: it must carry a full new class entry with
 *     nearestExistingClass + includes/excludes/severity (a novel class with no
 *     semantics is a HARD structural violation); a novel class enters
 *     `unconfirmed` and CANNOT satisfy `closure:'guard'` (logged downgrade).
 *   - derive per-class counts (deduped by PR) + compute deterministic escalation
 *     crossings — LOGGED only (proposals/attention items are increment 3).
 *   - assert mirror-consistency is trivially satisfiable (the side-effects mirror
 *     is display-only; hosts are never summed).
 *   - for an in-scope PR with NO declaration, LOG "missing class declaration
 *     (report-only)" (the flip criterion measures population rate during dryRun).
 *
 * Exit codes: 0 in report-only ALWAYS. Nonzero ONLY when
 * `prGate.classClosure.enabled && !dryRun` AND a hard structural violation exists
 * (malformed registry, or a novel class with no semantics).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  loadRegistry,
  validateRegistry,
  readDecisionDeclarations,
  deriveClassData,
  computeEscalation,
  REGISTRY_REL_PATH,
} from './lib/defect-class-registry.mjs';
import { evaluateGuardClosure } from './lib/class-closure-grader.mjs';
import { isSelfActionControllerFile } from './lib/self-action-detect.mjs';

const DEFAULT_CONFIG = { enabled: false, dryRun: true, escalatorDrafting: false };

// The self-action class id + the convergence-argument regex (Part E2). A
// `defectClass: unbounded-self-action` + `closure: guard` declaration's
// guardEvidence.howCaught must ADDRESS the convergence argument (control-loop
// edge + steady-state bound + settling brake) — a per-tick-cap-only
// justification does NOT address it.
const SELF_ACTION_CLASS_ID = 'unbounded-self-action';
const CONVERGENCE_ADDRESSED = /converge|steady[- ]?state|bound|dwell|hysteresis|all[- ]?hot|projected.*load|breaker/i;

/** Read a repo file, or null (a deleted/binary path in a diff). */
function readFileMaybe(repoRoot, rel) {
  try {
    return fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
  } catch {
    return null;
  }
}

/**
 * The agent-authored-artifact predicate — a fix touching one of these is
 * IN SCOPE for the class declaration (docs/specs/class-closure-gate.md →
 * Frontloaded Decision 1: prompts, hooks, configs, skills, standards text).
 */
export function isAgentAuthoredArtifact(file) {
  const f = String(file ?? '');
  if (/^research\/llm-pathway-bench\/.*\/tasks\//.test(f)) return true;
  if (f === 'src/core/promptClauses.ts') return true;
  if (f.startsWith('src/core/promptParsers')) return true;
  if (f === 'src/data/llmBenchCoverage.ts') return true;
  if (f === 'docs/STANDARDS-REGISTRY.md') return true;
  if (f.startsWith('.instar/hooks/')) return true;
  if (f.startsWith('.claude/hooks/')) return true;
  if (f.startsWith('skills/')) return true;
  return false;
}

/**
 * The gate's OWN source files — for the bounded, gate-source-ONLY self-wedge
 * exemption (spec: a broken gate can never block its own repair; the exemption
 * applies only when the diff touches EXCLUSIVELY these files).
 */
export function isGateSourceFile(file) {
  const f = String(file ?? '');
  return (
    f === 'scripts/class-closure-lint.mjs' ||
    f === 'scripts/class-closure-declare.mjs' ||
    f === 'scripts/lib/class-closure-grader.mjs' ||
    f === 'scripts/lib/defect-class-registry.mjs' ||
    f === 'src/core/DefectClassRegistry.ts' ||
    f === REGISTRY_REL_PATH ||
    f === 'docs/defect-classes.json' ||
    f === '.github/workflows/class-closure-gate.yml' ||
    f === 'docs/specs/class-closure-gate.md' ||
    /^tests\/(unit|integration)\/class-closure-/.test(f) ||
    // The self-action gate's own source (docs/specs/self-action-convergence.md
    // → Part E5): a broken self-action gate can never block its own repair.
    f === 'scripts/lint-no-unregistered-self-action.js' ||
    f === 'scripts/lib/self-action-detect.mjs' ||
    f === 'src/testing/selfActionRegistry.ts' ||
    f === 'docs/specs/self-action-convergence.md' ||
    /^tests\/(unit|integration)\/self-action-/.test(f)
  );
}

/** Load prGate.classClosure config from a repo checkout, or the report-only default. */
export function loadClassClosureConfig(repoRoot) {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, '.instar', 'config.json'), 'utf-8');
    const cfg = JSON.parse(raw);
    const cc = cfg && cfg.prGate && cfg.prGate.classClosure;
    if (cc && typeof cc === 'object') {
      return {
        enabled: cc.enabled === true,
        dryRun: cc.dryRun !== false, // default true (report-only) unless explicitly false
        escalatorDrafting: cc.escalatorDrafting === true,
      };
    }
  } catch {
    // no config / unreadable → report-only default
  }
  return { ...DEFAULT_CONFIG };
}

/** Validate one classClosure declaration's shape. Returns { findings, hardViolations }. */
function validateDeclaration(repoRoot, decl, knownClassIds) {
  const findings = [];
  const hardViolations = [];
  const where = `declaration in ${decl.source ?? '<unknown>'} (class="${decl.defectClass ?? '?'}")`;

  if (!decl.defectClass || typeof decl.defectClass !== 'string') {
    findings.push(`${where}: missing defectClass`);
    return { findings, hardViolations };
  }

  const isNovel = decl.defectClass === 'novel';
  if (!isNovel && !knownClassIds.has(decl.defectClass)) {
    findings.push(`${where}: defectClass "${decl.defectClass}" is not a registered class id and is not 'novel'`);
  }

  if (decl.closure !== 'guard' && decl.closure !== 'gap') {
    findings.push(`${where}: closure must be 'guard' or 'gap' (got "${decl.closure}")`);
  }

  // Novel class: REQUIRES full semantics (a hard violation if absent).
  if (isNovel) {
    const nc = decl.novelClass;
    const missing = [];
    if (!nc || typeof nc !== 'object') {
      missing.push('novelClass block');
    } else {
      if (!nc.nearestExistingClass || typeof nc.nearestExistingClass !== 'string') missing.push('nearestExistingClass');
      if (!Array.isArray(nc.includes) || nc.includes.length < 1) missing.push('≥1 includes');
      if (!Array.isArray(nc.excludes) || nc.excludes.length < 1) missing.push('≥1 excludes');
      if (nc.severity !== 'critical' && nc.severity !== 'normal') missing.push('severity (critical|normal)');
    }
    if (missing.length > 0) {
      hardViolations.push(`${where}: novel class with no semantics — missing ${missing.join(', ')}`);
    }
    // A novel class enters `unconfirmed` and CANNOT satisfy closure:'guard'.
    if (decl.closure === 'guard') {
      findings.push(`${where}: a novel (unconfirmed) class cannot satisfy closure:'guard' — its fix carries closure:'gap' until operator-confirmed`);
    }
  }

  // Guard closure: grade the citation (downgrade to gap if it does not resolve).
  if (decl.closure === 'guard') {
    const citation = decl.guardEvidence && decl.guardEvidence.citation;
    if (!citation || typeof citation !== 'string') {
      findings.push(`${where}: closure:'guard' requires guardEvidence.citation`);
    } else {
      const verdict = evaluateGuardClosure(repoRoot, citation);
      if (verdict.effectiveClosure === 'gap') {
        findings.push(`${where}: DOWNGRADE guard→gap — ${verdict.downgradeReason}`);
      } else {
        findings.push(`${where}: guard citation resolves (${verdict.gradedKind}) — closure:'guard' upheld`);
      }
    }
    // Class-specific arm (Part E2): for the unbounded-self-action class, the
    // convergence ARGUMENT must be addressed in howCaught — a per-tick-cap-only
    // justification bounds one pass, never the loop. A hard violation when
    // enforcing (returned to the caller so it can gate).
    if (decl.defectClass === SELF_ACTION_CLASS_ID) {
      const howCaught = decl.guardEvidence && decl.guardEvidence.howCaught;
      if (typeof howCaught !== 'string' || !CONVERGENCE_ADDRESSED.test(howCaught)) {
        findings.push(`${where}: unbounded-self-action closure:'guard' howCaught does NOT address convergence (steady-state bound / settling brake / dwell / all-hot / breaker) — a per-tick-cap-only justification is insufficient`);
        hardViolations.push(`${where}: unbounded-self-action guard howCaught fails the convergence-addressed check (E2)`);
      }
    }
  } else if (decl.closure === 'gap') {
    if (!decl.gapItem || typeof decl.gapItem !== 'string') {
      findings.push(`${where}: closure:'gap' should cite a tracked gap item (gapItem) — none provided`);
    }
  }

  return { findings, hardViolations };
}

/**
 * Pure evaluation over a prepared repo checkout — exported for tests.
 * @param {{ repoRoot: string, changedFiles?: string[]|null, config: {enabled:boolean,dryRun:boolean,escalatorDrafting:boolean}, thresholds?: object }} input
 * @returns {{ exitCode: number, repoGated?: boolean, findings: string[], hardViolations: string[], escalations: object[], inScope: boolean, exempt?: string, declarationCount: number }}
 */
export function runClassClosureLint(input) {
  const { repoRoot, config } = input;
  const thresholds = input.thresholds ?? {};
  const changedFiles = Array.isArray(input.changedFiles) ? input.changedFiles : null;
  const findings = [];
  const hardViolations = [];
  const escalations = [];

  // Repo-gate: no registry ⇒ not an instar class-closure repo.
  if (!fs.existsSync(path.join(repoRoot, REGISTRY_REL_PATH))) {
    return { exitCode: 0, repoGated: true, findings, hardViolations, escalations, inScope: false, declarationCount: 0 };
  }

  // Load + validate the registry (malformed = hard structural violation).
  let registry = null;
  const rawParse = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(repoRoot, REGISTRY_REL_PATH), 'utf-8'));
    } catch (err) {
      return { __parseError: err && err.message ? err.message : String(err) };
    }
  })();
  if (rawParse && rawParse.__parseError) {
    hardViolations.push(`registry unparseable: ${rawParse.__parseError}`);
  } else {
    const v = validateRegistry(rawParse);
    if (!v.ok) {
      hardViolations.push(`malformed registry: ${v.errors.join('; ')}`);
    } else {
      registry = rawParse;
    }
  }

  // Read + grade declarations from the decision-audit host.
  const declarations = readDecisionDeclarations(repoRoot);
  const knownClassIds = new Set(registry ? registry.classes.map((c) => c.id) : []);
  for (const decl of declarations) {
    const r = validateDeclaration(repoRoot, decl, knownClassIds);
    findings.push(...r.findings);
    hardViolations.push(...r.hardViolations);
  }

  // Derive per-class counts + compute deterministic escalation crossings (LOG only).
  if (registry) {
    const derived = deriveClassData(declarations);
    for (const cls of registry.classes) {
      const d = derived.get(cls.id);
      if (!d) continue;
      const verdict = computeEscalation(
        { severity: cls.severity, evidenceCountAtLastAck: cls.evidenceCountAtLastAck },
        d,
        thresholds,
      );
      if (verdict.shouldEscalate) {
        escalations.push({ classId: cls.id, arm: verdict.arm, reason: verdict.reason, derivedCount: d.dedupedCount });
        findings.push(`ESCALATION (report-only): class "${cls.id}" crossed threshold [${verdict.arm}] — ${verdict.reason}`);
      }
    }
    // Mirror-consistency: the side-effects artifact mirror is DISPLAY-ONLY; the
    // lint never sums the two hosts (C1). This invariant is satisfied by
    // construction here — we counted the decision-audit host only.
    findings.push('mirror-consistency: counted the decision-audit host only (side-effects mirror is display-only) — trivially satisfied');
  }

  // Diff-scope: does this PR touch an agent-authored artifact OR a self-action
  // controller (Part E2 — the concrete realization of #1347 Frontloaded
  // Decision 1) needing a declaration?
  let inScope = false;
  let exempt;
  if (changedFiles && changedFiles.length > 0) {
    const agentFiles = changedFiles.filter(isAgentAuthoredArtifact);
    // A diff touching a self-action controller file (name-shape or marker) is
    // in scope for the unbounded-self-action declaration.
    const selfActionFiles = changedFiles.filter((f) =>
      isSelfActionControllerFile(f, readFileMaybe(repoRoot, f)),
    );
    inScope = agentFiles.length > 0 || selfActionFiles.length > 0;
    if (inScope) {
      // Gate-source-ONLY self-wedge exemption: applies ONLY when the diff
      // touches EXCLUSIVELY the gate's own source (a mixed PR cannot ride it).
      const allGateSource = changedFiles.every(isGateSourceFile);
      if (allGateSource) {
        exempt = 'gate-source-only';
        findings.push('exempt: diff touches EXCLUSIVELY the gate\'s own source (gate-source-only self-wedge exemption, logged)');
      } else {
        if (declarations.length === 0) {
          findings.push('missing class declaration (report-only) — this PR touches agent-authored artifacts or self-action controllers but carries no classClosure declaration');
        }
        // Enforcement condition (i) (Part E2): an in-scope SELF-ACTION diff with
        // no unbounded-self-action declaration is a hard violation when
        // enforcing (report-only until prGate.classClosure.dryRun:false).
        if (selfActionFiles.length > 0) {
          const hasSelfActionDecl = declarations.some((d) => d.defectClass === SELF_ACTION_CLASS_ID);
          if (!hasSelfActionDecl) {
            const msg = `self-action controller(s) touched (${selfActionFiles.join(', ')}) but no unbounded-self-action classClosure declaration is present`;
            findings.push(`missing unbounded-self-action declaration — ${msg}`);
            hardViolations.push(msg);
          }
        }
      }
    }
  }

  // Exit code: report-only ALWAYS exits 0. Nonzero ONLY when enforcing AND a
  // hard structural violation exists.
  const enforcing = config.enabled && !config.dryRun;
  const exitCode = enforcing && hardViolations.length > 0 ? 1 : 0;

  return {
    exitCode,
    findings,
    hardViolations,
    escalations,
    inScope,
    exempt,
    declarationCount: declarations.length,
  };
}

/** Parse `git diff --name-status base...head` output into changed file paths. */
export function parseNameStatus(text) {
  const files = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split('\t');
    if (parts.length < 2) continue;
    files.push(parts[parts.length - 1]); // renames: take the new path
  }
  return files;
}

// ── CLI entrypoint (CI) ────────────────────────────────────────────────────
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) {
  const repoRoot = process.env.CLASS_CLOSURE_REPO_ROOT || process.cwd();

  // Repo-gate first (before anything else).
  if (!fs.existsSync(path.join(repoRoot, REGISTRY_REL_PATH))) {
    console.log('class-closure gate: not an instar class-closure repo (no docs/defect-classes.json) — skipping.');
    process.exit(0);
  }

  const config = loadClassClosureConfig(repoRoot);

  // Compute changed files from git when the PR SHAs are present; otherwise run
  // scope-blind (still grades all committed declarations — the count host).
  let changedFiles = null;
  const baseSha = process.env.BASE_SHA;
  const headSha = process.env.HEAD_SHA;
  if (baseSha && headSha) {
    try {
      const diffOut = execFileSync('git', ['diff', '--name-status', `${baseSha}...${headSha}`], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      changedFiles = parseNameStatus(diffOut);
    } catch (err) {
      console.warn(`class-closure gate: git diff failed (${err instanceof Error ? err.message : String(err)}) — running scope-blind.`);
      changedFiles = null;
    }
  }

  const res = runClassClosureLint({ repoRoot, changedFiles, config });

  console.log('class-closure gate: report-only lint');
  console.log(`  mode: ${config.enabled ? (config.dryRun ? 'enabled+dryRun (report-only)' : 'ENFORCING') : 'disabled (report-only)'}`);
  console.log(`  declarations scanned: ${res.declarationCount}`);
  if (changedFiles) console.log(`  changed files: ${changedFiles.length} (in-scope: ${res.inScope}${res.exempt ? `, exempt: ${res.exempt}` : ''})`);
  for (const f of res.findings) console.log(`  - ${f}`);
  if (res.hardViolations.length > 0) {
    console.log('  HARD STRUCTURAL VIOLATIONS:');
    for (const h of res.hardViolations) console.log(`    ! ${h}`);
  }
  if (res.exitCode !== 0) {
    console.error('class-closure gate: FAIL (enforcing mode + hard structural violation)');
  } else {
    console.log('class-closure gate: OK (report-only — no build failure)');
  }
  process.exit(res.exitCode);
}
