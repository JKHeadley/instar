#!/usr/bin/env node
/**
 * Structural coverage guard for Canonical Pipeline Operational Completeness.
 *
 * This lint proves declaration coverage and citation integrity only. Runtime
 * liveness, effective idempotency, cadence, and semantic completeness belong to
 * the collected smoke/E2E contracts and review authority.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = 'docs/canonical-pipelines.json';
const REGISTRY_PATH = 'src/core/canonicalPipelineRegistry.ts';
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** @typedef {{rule:string,message:string,path?:string,id?:string}} Finding */

/** @param {unknown} value */
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

/** @param {string} citation */
export function splitCitation(citation) {
  if (!nonEmpty(citation)) return null;
  const separator = citation.lastIndexOf('#');
  if (separator <= 0 || separator === citation.length - 1) return null;
  return { path: citation.slice(0, separator), symbol: citation.slice(separator + 1) };
}

/** @param {unknown} manifest @returns {Finding[]} */
export function validateCanonicalPipelineManifest(manifest) {
  /** @type {Finding[]} */
  const findings = [];
  if (!manifest || typeof manifest !== 'object') {
    return [{ rule: 'CPC0-manifest-shape', message: 'manifest must be an object' }];
  }
  const candidate = /** @type {Record<string, unknown>} */ (manifest);
  if (candidate.schemaVersion !== 1) {
    findings.push({ rule: 'CPC0-manifest-shape', message: 'schemaVersion must equal 1' });
  }
  if (!Array.isArray(candidate.pipelines) || candidate.pipelines.length === 0) {
    findings.push({ rule: 'CPC0-manifest-shape', message: 'pipelines must be a non-empty array' });
    return findings;
  }
  const ids = new Set();
  for (const raw of candidate.pipelines) {
    const pipeline = /** @type {Record<string, any>} */ (raw);
    if (!ID_RE.test(pipeline?.id ?? '') || ids.has(pipeline.id)) {
      findings.push({ rule: 'CPC0-pipeline-id', id: pipeline?.id, message: 'pipeline id must be unique kebab-case' });
      continue;
    }
    ids.add(pipeline.id);
    if (!nonEmpty(pipeline.owner)) {
      findings.push({ rule: 'CPC1-owner-required', id: pipeline.id, message: `${pipeline.id} must declare an owner` });
    }
    if (!Array.isArray(pipeline.stages) || pipeline.stages.length < 2) {
      findings.push({ rule: 'CPC2-stages-required', id: pipeline.id, message: `${pipeline.id} must declare at least two ordered stages` });
      continue;
    }
    const stageIds = pipeline.stages.map((stage) => stage?.id);
    if (stageIds.some((id) => !ID_RE.test(id ?? '')) || new Set(stageIds).size !== stageIds.length) {
      findings.push({ rule: 'CPC2-stage-id', id: pipeline.id, message: `${pipeline.id} stage ids must be unique kebab-case` });
    }
    for (const stage of pipeline.stages) {
      for (const field of ['metadataCitation', 'implementationCitation']) {
        if (!splitCitation(stage?.[field])) {
          findings.push({ rule: 'CPC3-stage-citation', id: pipeline.id, message: `${pipeline.id}.${stage?.id ?? '(stage)'}.${field} must be path#symbol` });
        }
      }
    }
    if (!Array.isArray(pipeline.ingress?.surfaceIds) || pipeline.ingress.surfaceIds.length === 0 || !splitCitation(pipeline.ingress?.wiringCitation)) {
      findings.push({ rule: 'CPC4-ingress-required', id: pipeline.id, message: `${pipeline.id} must declare ingress surface ids and wiring citation` });
    }
    const expectedEdges = stageIds.slice(0, -1).map((from, index) => `${from}\0${stageIds[index + 1]}`);
    const transitions = Array.isArray(pipeline.transitions) ? pipeline.transitions : [];
    const actualEdges = transitions.map((edge) => `${edge?.from}\0${edge?.to}`);
    if (transitions.length !== expectedEdges.length || expectedEdges.some((edge) => !actualEdges.includes(edge))) {
      findings.push({ rule: 'CPC5-transition-coverage', id: pipeline.id, message: `${pipeline.id} must declare every adjacent stage transition exactly once` });
    }
    for (const transition of transitions) {
      if (!splitCitation(transition?.implementationCitation) || !nonEmpty(transition?.persistentState) || !nonEmpty(transition?.idempotencyKey)) {
        findings.push({ rule: 'CPC5-transition-contract', id: pipeline.id, message: `${pipeline.id} transition ${transition?.from ?? '?'} -> ${transition?.to ?? '?'} needs implementation, persistent state, and idempotency key` });
      }
    }
    const terminal = pipeline.terminalHandoff;
    if (terminal?.stage !== stageIds.at(-1) || !nonEmpty(terminal?.consumer) || !splitCitation(terminal?.consumerCitation)) {
      findings.push({ rule: 'CPC6-terminal-consumer', id: pipeline.id, message: `${pipeline.id} must name a cited consumer at its final stage` });
    }
    if (!splitCitation(pipeline.cadence?.triggerCitation)) {
      findings.push({ rule: 'CPC7-cadence-citation', id: pipeline.id, message: `${pipeline.id} must cite an operated cadence/trigger` });
    }
    if (!splitCitation(pipeline.metrics?.readinessCitation)) {
      findings.push({ rule: 'CPC8-metrics-citation', id: pipeline.id, message: `${pipeline.id} must cite metrics/readiness` });
    }
    const smoke = pipeline.runtimeSmoke;
    if (!nonEmpty(smoke?.test) || !nonEmpty(smoke?.command) || smoke?.productionConsumerAdapter !== true || smoke?.authoritativeReadBack !== true) {
      findings.push({ rule: 'CPC9-runtime-contract', id: pipeline.id, message: `${pipeline.id} must declare a production-adapter authoritative-read-back runtime smoke/E2E` });
    }
    if (!nonEmpty(pipeline.rollout?.posture) || !nonEmpty(pipeline.rollout?.rollbackSwitch)) {
      findings.push({ rule: 'CPC10-rollout-contract', id: pipeline.id, message: `${pipeline.id} must declare rollout posture and rollback switch` });
    }
  }
  return findings;
}

/**
 * Read the closed TypeScript intake registry without executing repository code.
 * @param {string} filePath
 */
export function parseIntakeRegistry(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  /** @type {Record<string, string>[]} */
  const declarations = [];
  const literal = (node) => ts.isStringLiteral(node) ? node.text : undefined;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'CANONICAL_INTAKE_SURFACES') {
      let initializer = node.initializer;
      while (initializer && (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer))) initializer = initializer.expression;
      if (!initializer || !ts.isArrayLiteralExpression(initializer)) return;
      for (const element of initializer.elements) {
        if (!ts.isObjectLiteralExpression(element)) continue;
        const record = {};
        for (const property of element.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined;
          const value = literal(property.initializer);
          if (key && value !== undefined) record[key] = value;
        }
        declarations.push(record);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return declarations;
}

/**
 * @param {{root:string, manifest:any, intakeDeclarations:Record<string,string>[], readText?:(path:string)=>string|undefined, pathExists?:(path:string)=>boolean}} input
 * @returns {Finding[]}
 */
export function auditCanonicalPipelineCompleteness(input) {
  const findings = [...validateCanonicalPipelineManifest(input.manifest)];
  if (findings.some((finding) => finding.rule === 'CPC0-manifest-shape')) return findings;
  const pipelines = new Map((input.manifest.pipelines ?? []).map((pipeline) => [pipeline.id, pipeline]));
  const declarations = new Map();
  const readText = input.readText ?? ((relativePath) => {
    try { return fs.readFileSync(path.join(input.root, relativePath), 'utf8'); } catch { return undefined; }
  });
  const pathExists = input.pathExists ?? ((relativePath) => fs.existsSync(path.join(input.root, relativePath)));

  for (const surface of input.intakeDeclarations) {
    if (!nonEmpty(surface.id) || declarations.has(surface.id)) {
      findings.push({ rule: 'CPC11-intake-id', id: surface.id, message: 'intake surface id must be non-empty and unique' });
      continue;
    }
    declarations.set(surface.id, surface);
    const canonical = nonEmpty(surface.canonicalPipelineId);
    const excluded = nonEmpty(surface.nonCanonicalReason);
    if (canonical === excluded) {
      findings.push({ rule: 'CPC12-intake-classification', id: surface.id, message: `${surface.id} must declare exactly one canonicalPipelineId or nonCanonicalReason` });
    }
    if (canonical && !pipelines.has(surface.canonicalPipelineId)) {
      findings.push({ rule: 'CPC12-unknown-pipeline', id: surface.id, message: `${surface.id} names unregistered pipeline ${surface.canonicalPipelineId}` });
    }
    if (excluded && (!nonEmpty(surface.owner) || surface.nonCanonicalReason.length < 12 || !/^\d{4}-\d{2}-\d{2}$/.test(surface.expiresAt ?? ''))) {
      findings.push({ rule: 'CPC13-exclusion-contract', id: surface.id, message: `${surface.id} exclusion needs owner, substantive reason, and YYYY-MM-DD expiry` });
    }
    const source = readText(surface.sourcePath);
    if (!source) {
      findings.push({ rule: 'CPC14-intake-source-missing', id: surface.id, path: surface.sourcePath, message: `${surface.id} source path is missing` });
    } else {
      const needle = surface.kind === 'route' ? surface.route : surface.jobSlug;
      if (!nonEmpty(needle) || !source.includes(needle)) {
        findings.push({ rule: 'CPC14-intake-wiring-missing', id: surface.id, path: surface.sourcePath, message: `${surface.id} declared route/job is absent from its source` });
      }
    }
  }

  const citations = [];
  for (const pipeline of input.manifest.pipelines ?? []) {
    for (const surfaceId of pipeline.ingress?.surfaceIds ?? []) {
      const surface = declarations.get(surfaceId);
      if (!surface || surface.canonicalPipelineId !== pipeline.id) {
        findings.push({ rule: 'CPC15-ingress-registry-link', id: pipeline.id, message: `${pipeline.id} ingress ${surfaceId} is missing or classified elsewhere` });
      }
    }
    for (const stage of pipeline.stages ?? []) {
      citations.push(stage.metadataCitation, stage.implementationCitation);
      const metadata = splitCitation(stage.metadataCitation);
      const source = metadata ? readText(metadata.path) : undefined;
      if (metadata && source) {
        const symbolOffset = source.indexOf(metadata.symbol);
        const declaration = symbolOffset >= 0 ? source.slice(symbolOffset, symbolOffset + 700) : '';
        const pipelinePattern = new RegExp(`canonicalPipelineId\\s*:\\s*['\"]${pipeline.id}['\"]`);
        const stagePattern = new RegExp(`stage\\s*:\\s*['\"]${stage.id}['\"]`);
        if (!pipelinePattern.test(declaration) || !stagePattern.test(declaration)) {
          findings.push({
            rule: 'CPC3-stage-metadata-mismatch', id: pipeline.id, path: metadata.path,
            message: `${stage.metadataCitation} must declare canonicalPipelineId ${pipeline.id} and stage ${stage.id}`,
          });
        }
      }
    }
    for (const edge of pipeline.transitions ?? []) citations.push(edge.implementationCitation);
    citations.push(pipeline.ingress?.wiringCitation, pipeline.terminalHandoff?.consumerCitation, pipeline.cadence?.triggerCitation, pipeline.metrics?.readinessCitation);

    const testPath = pipeline.runtimeSmoke?.test;
    if (nonEmpty(testPath) && !pathExists(testPath)) {
      findings.push({ rule: 'CPC16-runtime-test-missing', id: pipeline.id, path: testPath, message: `${pipeline.id} runtime smoke/E2E path is missing` });
    }
    const packageText = readText('package.json');
    let packageJson;
    try { packageJson = packageText ? JSON.parse(packageText) : null; } catch { packageJson = null; }
    const command = pipeline.runtimeSmoke?.command;
    const script = packageJson?.scripts?.[command];
    if (!nonEmpty(command) || !nonEmpty(script) || !script.includes(testPath)) {
      findings.push({ rule: 'CPC17-runtime-test-uncollected', id: pipeline.id, path: testPath, message: `${pipeline.id} runtime test must be collected by package script ${command ?? '(missing)'}` });
    }
  }

  for (const rawCitation of citations) {
    const citation = splitCitation(rawCitation);
    if (!citation) continue;
    const source = readText(citation.path);
    if (!source) {
      findings.push({ rule: 'CPC18-citation-path-missing', path: citation.path, message: `citation path is missing: ${rawCitation}` });
    } else if (!source.includes(citation.symbol)) {
      findings.push({ rule: 'CPC18-citation-symbol-missing', path: citation.path, message: `citation symbol/token is missing: ${rawCitation}` });
    }
  }
  return findings;
}

function main() {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const root = rootIndex >= 0 && args[rootIndex + 1] ? path.resolve(args[rootIndex + 1]) : SCRIPT_ROOT;
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST_PATH), 'utf8')); }
  catch (error) {
    console.error(`CPC0-manifest-missing-or-invalid: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  let intakeDeclarations;
  try { intakeDeclarations = parseIntakeRegistry(path.join(root, REGISTRY_PATH)); }
  catch (error) {
    console.error(`CPC0-intake-registry-invalid: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const findings = auditCanonicalPipelineCompleteness({ root, manifest, intakeDeclarations });
  if (findings.length === 0) {
    console.log('lint-canonical-pipeline-completeness: clean (structural coverage evidence only)');
    return;
  }
  console.error(`lint-canonical-pipeline-completeness: ${findings.length} finding(s)`);
  for (const finding of findings) console.error(`  ${finding.rule}${finding.path ? ` ${finding.path}` : ''}: ${finding.message}`);
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
