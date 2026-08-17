#!/usr/bin/env node
// safe-git-allow: CI lint bootstrap uses read-only git archive/rev-parse and removes only mkdtempSync directories; compiled SafeGit/SafeFs funnels are unavailable to this direct Node entry point.

// Executable proxy for docs/specs/TESTING-INTEGRITY-SPEC.md and
// docs/E2E-TESTING-STANDARD.md: direct Express route changes require executed
// Tier-3 evidence through the production AgentServer pipeline.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);
const PROTECTED_FLEET_MAIN_URL = 'https://github.com/JKHeadley/instar.git';

function sourceFilesBelow(directory, options = {}) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Testing Integrity could not enumerate ${directory}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFilesBelow(entryPath, options));
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`Testing Integrity refuses a symbolic-link source entry: ${entryPath}`);
    }
    if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      (options.includeTests || !entry.name.endsWith('.test.ts')) &&
      !entry.name.endsWith('.d.ts')
    ) {
      files.push(entryPath);
    }
  }
  return files;
}

function literalRoutePath(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function parseRouteDeclarations({ root, filename, contents }) {
  const sourceFile = ts.createSourceFile(filename, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const parseDiagnostics = sourceFile.parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    const diagnostic = parseDiagnostics[0];
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    throw new Error(`Testing Integrity could not parse ${filename}: ${message}`);
  }

  const declarations = [];
  const expressReceivers = new Set(['app', 'router']);
  const collectExpressReceivers = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const constructorText = node.initializer.expression.getText(sourceFile);
      if (constructorText === 'Router' || constructorText === 'express' || constructorText.endsWith('.Router')) {
        expressReceivers.add(node.name.text);
      }
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.type) {
      const typeText = node.type.getText(sourceFile);
      if (/\b(?:Router|Application|Express)\b/.test(typeText)) expressReceivers.add(node.name.text);
    }
    ts.forEachChild(node, collectExpressReceivers);
  };
  collectExpressReceivers(sourceFile);

  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const methodName = node.expression.name.text.toLowerCase();
      if (HTTP_METHODS.has(methodName) && node.arguments.length > 0) {
        const receiver = node.expression.expression.getText(sourceFile);
        const isExpressReceiver = expressReceivers.has(receiver) || /(?:^|\.)(?:app|router)$/i.test(receiver);
        if (!isExpressReceiver) {
          ts.forEachChild(node, visit);
          return;
        }
        const routePath = literalRoutePath(node.arguments[0]);
        if (routePath?.startsWith('/')) {
          const relativeFile = path.relative(root, filename).split(path.sep).join('/');
          const method = methodName.toUpperCase();
          declarations.push({
            method,
            path: routePath,
            file: relativeFile,
            fingerprint: declarationFingerprint(relativeFile, method, routePath, node.getText(sourceFile)),
          });
        } else {
          const relativeFile = path.relative(root, filename).split(path.sep).join('/');
          const method = methodName.toUpperCase();
          const expression = node.arguments[0].getText(sourceFile).replace(/\s+/g, ' ').trim();
          const dynamicPath = `<dynamic:${relativeFile}:${expression}>`;
          declarations.push({
            method,
            path: dynamicPath,
            file: relativeFile,
            unverifiable: true,
            fingerprint: declarationFingerprint(relativeFile, method, dynamicPath, node.getText(sourceFile)),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return declarations;
}

function declarationFingerprint(relativeFile, method, routePath, callText) {
  return crypto
    .createHash('sha256')
    .update(`${relativeFile}\0${method}\0${routePath}\0${callText.replace(/\s+/g, ' ').trim()}`)
    .digest('hex');
}

export function enumerateHttpRoutes({ root }) {
  const sourceRoot = path.join(root, 'src');
  const files = sourceFilesBelow(sourceRoot);
  const declarations = [];

  for (const filename of files) {
    let contents;
    try {
      contents = fs.readFileSync(filename, 'utf8');
    } catch (error) {
      throw new Error(`Testing Integrity could not read ${filename}: ${error instanceof Error ? error.message : String(error)}`);
    }

    declarations.push(...parseRouteDeclarations({ root, filename, contents }));
  }

  if (declarations.length === 0) {
    throw new Error(`Testing Integrity derived zero HTTP routes from ${sourceRoot}; result is NOT-PROVEN`);
  }

  const grouped = new Map();
  for (const declaration of declarations) {
    const key = `${declaration.method} ${declaration.path}`;
    const group = grouped.get(key) ?? [];
    group.push(declaration);
    grouped.set(key, group);
  }

  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => {
      const separator = key.indexOf(' ');
      const method = key.slice(0, separator);
      const routePath = key.slice(separator + 1);
      const ordered = group.sort((a, b) => a.file.localeCompare(b.file) || a.fingerprint.localeCompare(b.fingerprint));
      return {
        method,
        path: routePath,
        unverifiable: ordered.some(item => item.unverifiable),
        fingerprint: crypto.createHash('sha256').update(ordered.map(item => item.fingerprint).join('\n')).digest('hex'),
        declarations: [...new Set(ordered.map(item => item.file))],
      };
    });
}

export function evaluateTestingIntegrity({ currentRoutes, baseRoutes, executedEvidence }) {
  if (!Array.isArray(currentRoutes) || currentRoutes.length === 0) {
    throw new Error('Testing Integrity current route population is empty; result is NOT-PROVEN');
  }
  if (!Array.isArray(baseRoutes) || !Array.isArray(executedEvidence)) {
    throw new Error('Testing Integrity inputs are unreadable; result is NOT-PROVEN');
  }

  const base = new Map(baseRoutes.map(route => [`${route.method} ${route.path}`, route]));
  const changed = currentRoutes.filter(route => {
    const previous = base.get(`${route.method} ${route.path}`);
    return !previous || previous.fingerprint !== route.fingerprint;
  });
  const evidence = new Set(executedEvidence.map(record => `${record.method} ${record.path}`));
  const errors = [];
  for (const route of changed) {
    const key = `${route.method} ${route.path}`;
    if (route.unverifiable) {
      errors.push(`${key} is a changed non-literal route declaration; result is NOT-PROVEN`);
    } else if (!evidence.has(key)) errors.push(`${key} has no executed Tier-3 route evidence`);
  }

  return {
    passed: errors.length === 0,
    populationCount: currentRoutes.length,
    changedRoutes: changed.map(route => `${route.method} ${route.path}`),
    errors,
  };
}

function gitOutput(root, args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
      encoding: Object.prototype.hasOwnProperty.call(options, 'encoding') ? options.encoding : 'utf8',
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr ?? '').trim() : '';
    throw new Error(`Testing Integrity git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

function queryProtectedFleetMain() {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (name.startsWith('GIT_CONFIG_') || ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR'].includes(name)) {
      delete environment[name];
    }
  }
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_CONFIG_GLOBAL = '/dev/null';
  let output;
  try {
    output = execFileSync('git', ['ls-remote', '--exit-code', PROTECTED_FLEET_MAIN_URL, 'refs/heads/main'], {
      cwd: os.tmpdir(),
      env: environment,
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr ?? '').trim() : '';
    throw new Error(`Testing Integrity could not query protected fleet main${stderr ? `: ${stderr}` : ''}`);
  }
  const lines = output.trim().split('\n').filter(Boolean);
  const match = lines.length === 1 ? lines[0].match(/^([0-9a-f]{40})\s+refs\/heads\/main$/) : null;
  if (!match) throw new Error('Testing Integrity received malformed protected-main identity; result is NOT-PROVEN');
  return match[1];
}

export function resolveTestingIntegrityBase({ root }) {
  const protectedMain = queryProtectedFleetMain();
  gitOutput(root, ['cat-file', '-e', `${protectedMain}^{commit}`]);
  return gitOutput(root, ['merge-base', 'HEAD', protectedMain]).trim();
}

export function enumerateHttpRoutesAtGitRef({ root, ref }) {
  const archive = gitOutput(root, ['archive', '--format=tar', ref, 'src'], { encoding: null, maxBuffer: 256 * 1024 * 1024 });
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'testing-integrity-base-'));
  try {
    const extracted = spawnSync('tar', ['-xf', '-', '-C', temporaryRoot], {
      input: archive,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    if (extracted.error || extracted.status !== 0) {
      throw new Error(`Testing Integrity could not extract base tree: ${extracted.error?.message ?? extracted.stderr ?? `exit ${extracted.status}`}`);
    }
    return enumerateHttpRoutes({ root: temporaryRoot });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function objectLiteralString(object, propertyName) {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : null;
    if (name !== propertyName) continue;
    return literalRoutePath(property.initializer);
  }
  return null;
}

export function discoverRouteEvidenceFiles({ root }) {
  const evidenceRoot = path.join(root, 'tests', 'e2e');
  const files = sourceFilesBelow(evidenceRoot, { includeTests: true }).filter(file => file.endsWith('.test.ts'));
  const evidence = new Map();

  for (const filename of files) {
    let contents;
    try {
      contents = fs.readFileSync(filename, 'utf8');
    } catch (error) {
      throw new Error(`Testing Integrity could not read evidence candidate ${filename}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const sourceFile = ts.createSourceFile(filename, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const diagnostics = sourceFile.parseDiagnostics ?? [];
    if (diagnostics.length > 0) {
      throw new Error(`Testing Integrity could not parse evidence candidate ${filename}: ${ts.flattenDiagnosticMessageText(diagnostics[0].messageText, '\n')}`);
    }
    let importsCanonicalHelper = false;
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      if (!/helpers\/testingIntegrity(?:\.js)?$/.test(statement.moduleSpecifier.text)) continue;
      const elements = statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
        ? statement.importClause.namedBindings.elements
        : [];
      if (elements.some(element => element.name.text === 'expectRouteAlive' && (element.propertyName?.text ?? 'expectRouteAlive') === 'expectRouteAlive')) {
        importsCanonicalHelper = true;
      }
    }
    if (!importsCanonicalHelper) continue;

    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'expectRouteAlive' &&
        node.arguments.length >= 2 &&
        ts.isObjectLiteralExpression(node.arguments[1])
      ) {
        const method = objectLiteralString(node.arguments[1], 'method')?.toUpperCase();
        const routePath = objectLiteralString(node.arguments[1], 'routePath');
        if (method && HTTP_METHODS.has(method.toLowerCase()) && routePath?.startsWith('/')) {
          const key = `${method} ${routePath}`;
          const list = evidence.get(key) ?? [];
          list.push(path.relative(root, filename).split(path.sep).join('/'));
          evidence.set(key, [...new Set(list)]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return evidence;
}

export function runRouteEvidenceFiles({ root, files }) {
  if (files.length === 0) return [];
  const evidenceFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'testing-integrity-proof-')), 'evidence.jsonl');
  const nonce = crypto.randomBytes(24).toString('hex');
  try {
    const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
    if (!fs.existsSync(vitest)) throw new Error(`Testing Integrity test runner is unavailable: ${vitest}`);
    const run = spawnSync(process.execPath, [vitest, 'run', '--config', 'vitest.e2e.config.ts', ...files], {
      cwd: root,
      env: {
        ...process.env,
        INSTAR_TESTING_INTEGRITY_EVIDENCE_FILE: evidenceFile,
        INSTAR_TESTING_INTEGRITY_NONCE: nonce,
      },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    });
    if (run.error || run.status !== 0) {
      throw new Error(`Testing Integrity evidence tests failed${run.error ? `: ${run.error.message}` : ` (exit ${run.status})`}\n${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim());
    }
    if (!fs.existsSync(evidenceFile)) {
      throw new Error('Testing Integrity evidence tests produced no execution proof; result is NOT-PROVEN');
    }
    return fs.readFileSync(evidenceFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => {
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          throw new Error('Testing Integrity evidence proof is malformed; result is NOT-PROVEN');
        }
        if (record.nonce !== nonce) throw new Error('Testing Integrity evidence proof nonce mismatch; result is NOT-PROVEN');
        return record;
      });
  } finally {
    fs.rmSync(path.dirname(evidenceFile), { recursive: true, force: true });
  }
}

export async function enforceTestingIntegrity(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const currentRoutes = enumerateHttpRoutes({ root });
  const baseRoutes = options.baseRoutes ?? enumerateHttpRoutesAtGitRef({
    root,
    ref: options.baseRef ?? resolveTestingIntegrityBase({ root }),
  });
  let executedEvidence = options.executedEvidence;
  if (!executedEvidence) {
    const preview = evaluateTestingIntegrity({ currentRoutes, baseRoutes, executedEvidence: [] });
    if (preview.changedRoutes.length === 0) executedEvidence = [];
    else {
      const discovered = discoverRouteEvidenceFiles({ root });
      const candidateFiles = [...new Set(preview.changedRoutes.flatMap(route => discovered.get(route) ?? []))].sort();
      executedEvidence = runRouteEvidenceFiles({ root, files: candidateFiles });
    }
  }
  return evaluateTestingIntegrity({ currentRoutes, baseRoutes, executedEvidence });
}

async function main() {
  if (process.argv.length > 2) {
    throw new Error('Testing Integrity does not accept caller-selected arguments; protected main is resolved internally');
  }
  const result = await enforceTestingIntegrity();
  if (!result.passed) {
    for (const error of result.errors) console.error(`[testing-integrity] ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[testing-integrity] PASS — derived ${result.populationCount} HTTP routes; ${result.changedRoutes.length} changed obligation(s)`);
}

const invokedAsScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main().catch(error => {
    console.error(`[testing-integrity] NOT-PROVEN — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
