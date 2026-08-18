// safe-git-allow: protected measurement uses only content-addressed read operations through /usr/bin/git.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import {
  isLiveAuthenticatedExecutionArtifact,
  STANDARDS_EXECUTION_RUNNER,
  verifyProtectedExecutionProof,
} from './standards-enforcement-execution-verifier.mjs';

export const CANONICAL_PROTECTED_REMOTE = 'https://github.com/JKHeadley/instar.git';
export const PROTECTED_MAIN_REF = 'refs/heads/main';
export const PROTECTED_VERDICTS_PATH = 'docs/standards-enforcement-verdicts.json';
export const PROTECTED_VERDICT_SCHEMA_VERSION = 3;
const SYSTEM_GIT = '/usr/bin/git';
const SHA256_RE = /^[a-f0-9]{64}$/;
const STRENGTH_RANK = {
  'documented-only': 0,
  'spec-only': 1,
  lint: 2,
  gate: 3,
  ratchet: 4,
};

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isObject(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const weaker = (left, right) => STRENGTH_RANK[left] <= STRENGTH_RANK[right] ? left : right;

function safeRepoPath(rel) {
  return typeof rel === 'string' && rel.length > 0 && !path.isAbsolute(rel) &&
    !rel.includes('\0') && !rel.split(/[\\/]/).includes('..');
}

function scrubbedGitEnv(root) {
  const {
    GIT_ALTERNATE_OBJECT_DIRECTORIES: _alternateObjects,
    GIT_CONFIG_COUNT: _configCount,
    GIT_CONFIG_PARAMETERS: _configParameters,
    GIT_DIR: _gitDir,
    GIT_OBJECT_DIRECTORY: _objectDirectory,
    GIT_WORK_TREE: _workTree,
    ...ambient
  } = process.env;
  return { ...ambient, HOME: path.parse(root).root, GIT_NO_REPLACE_OBJECTS: '1' };
}

function git(root, args, timeout = 20_000) {
  const child = spawnSync(SYSTEM_GIT, args, {
    cwd: root,
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    env: scrubbedGitEnv(root),
  });
  if (child.error || child.status !== 0) return null;
  return child.stdout;
}

function canonicalRemoteMain(root) {
  const child = spawnSync(SYSTEM_GIT, [
    'ls-remote', '--refs', CANONICAL_PROTECTED_REMOTE, PROTECTED_MAIN_REF,
  ], {
    cwd: path.parse(root).root,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: path.parse(root).root,
      LANG: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_COUNT: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  if (child.error || child.status !== 0) return null;
  const fields = child.stdout.trim().split(/\s+/);
  if (fields.length !== 2 || fields[1] !== PROTECTED_MAIN_REF || !/^[a-f0-9]{40}$/.test(fields[0])) return null;
  return fields[0];
}

function directorySnapshot(root) {
  const absolute = path.resolve(root);
  const listFiles = (prefix) => {
    const start = path.resolve(absolute, prefix);
    const out = [];
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) out.push(path.relative(absolute, full).split(path.sep).join('/'));
      }
    };
    walk(start);
    return out.sort();
  };
  return {
    source: 'explicit-test-fixture',
    protectedMainSha: null,
    baseRevision: `fixture:${sha256(absolute).slice(0, 12)}`,
    readFile(rel) {
      if (!safeRepoPath(rel)) return null;
      const full = path.resolve(absolute, rel);
      if (full !== absolute && !full.startsWith(`${absolute}${path.sep}`)) return null;
      try {
        const stat = fs.lstatSync(full);
        if (!stat.isFile() || stat.isSymbolicLink()) return null;
        return fs.readFileSync(full, 'utf8');
      } catch {
        return null;
      }
    },
    listFiles,
    hasMarker(marker) {
      if (typeof marker !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(marker)) return false;
      const re = new RegExp(`\\b${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      return listFiles('src').some((rel) => {
        if (!/\.(?:ts|js|mjs|cjs)$/.test(rel)) return false;
        const content = this.readFile(rel);
        return content !== null && re.test(content);
      });
    },
  };
}

/**
 * Resolve the measurement oracle. Production ignores candidate remotes and tracking refs:
 * the server-advertised main SHA is reduced to a content-addressed merge base. An explicit
 * directory exists only for `--allow-partial-registry` test fixtures; the caller controls
 * that boundary and never passes it in a real check.
 */
export function resolveProtectedMeasurementSnapshot({ root, fixtureRoot = null }) {
  if (fixtureRoot !== null) return directorySnapshot(fixtureRoot);
  const protectedMainSha = canonicalRemoteMain(root);
  if (!protectedMainSha) throw new Error('protected main unavailable from canonical server');
  const baseRevision = git(root, ['merge-base', 'HEAD', protectedMainSha])?.trim() ?? '';
  if (!/^[a-f0-9]{40}$/.test(baseRevision)) {
    throw new Error(`protected merge base unavailable for canonical main ${protectedMainSha.slice(0, 12)}`);
  }
  return {
    source: 'canonical-server-content-addressed-merge-base',
    protectedMainSha,
    baseRevision,
    readFile(rel) {
      if (!safeRepoPath(rel)) return null;
      return git(root, ['show', `${baseRevision}:${rel}`]);
    },
    listFiles(prefix) {
      if (!safeRepoPath(prefix)) return [];
      const output = git(root, ['ls-tree', '-r', '--name-only', baseRevision, '--', prefix]);
      return output === null ? [] : output.trim().split('\n').filter(Boolean).sort();
    },
    hasMarker(marker) {
      if (typeof marker !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(marker)) return false;
      return git(root, ['grep', '-q', '-w', '--fixed-strings', marker, baseRevision, '--', 'src']) !== null;
    },
  };
}

export function routeTableFromSnapshot(snapshot) {
  const out = new Set();
  const re = /router\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  for (const rel of snapshot.listFiles('src/server')) {
    if (!rel.endsWith('.ts') || rel.endsWith('.test.ts')) continue;
    const content = snapshot.readFile(rel);
    if (content === null) continue;
    for (const match of content.matchAll(re)) out.add(`${match[1].toUpperCase()} ${match[2]}`);
  }
  return out;
}

function candidateReader(root) {
  return (rel) => {
    if (!safeRepoPath(rel)) return null;
    const full = path.resolve(root, rel);
    if (full !== root && !full.startsWith(`${root}${path.sep}`)) return null;
    try {
      const stat = fs.lstatSync(full);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      return fs.readFileSync(full, 'utf8');
    } catch {
      return null;
    }
  };
}

function calleeName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return '';
}

function analyzeProgram(content, rel) {
  const kind = /\.(?:ts|tsx)$/.test(rel) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(rel, content, ts.ScriptTarget.Latest, true, kind);
  const facts = {
    test: false,
    assertion: false,
    conditional: false,
    failure: false,
    diagnostic: false,
  };
  const visit = (node) => {
    if (ts.isIfStatement(node) || ts.isSwitchStatement(node) || ts.isConditionalExpression(node)) facts.conditional = true;
    if (ts.isThrowStatement(node)) facts.failure = true;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) && ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === 'process' && node.left.name.text === 'exitCode') facts.failure = true;
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name === 'it' || name === 'test') facts.test = true;
      if (name === 'expect' || name === 'assert' || name.startsWith('assert')) facts.assertion = true;
      if (name === 'exit' && ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'process') facts.failure = true;
      if (name === 'error' || name === 'warn') facts.diagnostic = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return facts;
}

function inferredStrength(ref) {
  const base = ref.split('/').pop() ?? ref;
  if (/\.test\.(?:ts|js|mjs)$/.test(base) || base.startsWith('no-') || /-coverage\.(?:mjs|js)$/.test(base)) return 'ratchet';
  if (ref.startsWith('scripts/') && base.startsWith('lint-')) return 'lint';
  if (ref.startsWith('.husky/') || /precommit/i.test(base)) return 'gate';
  if (ref.startsWith('scripts/')) return 'lint';
  if (ref.startsWith('docs/')) return 'spec-only';
  if (ref.startsWith('src/')) return 'gate';
  return 'spec-only';
}

/** A comment or prose sentence cannot satisfy these syntax-tree predicates. */
export function gradeFileReference(ref, content) {
  if (content === null) return { proven: false, strength: 'documented-only', reason: 'reference-unreadable' };
  if (content.trim().length === 0) return { proven: false, strength: 'documented-only', reason: 'reference-empty' };
  const expected = inferredStrength(ref);
  if (expected === 'spec-only') {
    return content.trim().length >= 20
      ? { proven: false, strength: 'documented-only', observedStrength: 'spec-only', reason: 'protected-relevance-proof-missing' }
      : { proven: false, strength: 'documented-only', reason: 'reference-structurally-hollow' };
  }
  if (!/\.(?:ts|tsx|js|mjs|cjs)$/.test(ref)) {
    const shellGate = /(^|\n)\s*(?:exit\s+[1-9]|return\s+[1-9])/m.test(content) && /(^|\n)\s*(?:if|case)\b/m.test(content);
    return shellGate
      ? { proven: false, strength: 'documented-only', observedStrength: expected, reason: 'protected-relevance-proof-missing' }
      : { proven: false, strength: 'documented-only', reason: 'reference-structurally-hollow' };
  }
  const facts = analyzeProgram(content, ref);
  if (expected === 'ratchet' && /\.test\./.test(ref)) {
    return facts.test && facts.assertion
      ? { proven: false, strength: 'documented-only', observedStrength: 'ratchet', reason: 'protected-relevance-proof-missing' }
      : { proven: false, strength: 'documented-only', reason: 'reference-structurally-hollow' };
  }
  if (facts.conditional && facts.failure) {
    return { proven: false, strength: 'documented-only', observedStrength: expected, reason: 'protected-relevance-proof-missing' };
  }
  return { proven: false, strength: 'documented-only', reason: 'reference-structurally-hollow' };
}

function validProofRecord(record, index) {
  if (!exactKeys(record, ['articleId', 'articleSha256', 'proof', 'ref', 'sha256', 'verdict']) ||
    typeof record.articleId !== 'string' || record.articleId.length < 3 ||
    !SHA256_RE.test(record.articleSha256) || !safeRepoPath(record.ref) ||
    !SHA256_RE.test(record.sha256) || !['EFFECTIVE', 'WIRED', 'EXISTS'].includes(record.verdict)) {
    return `record ${index} is malformed`;
  }
  const proof = record.proof;
  if (!exactKeys(proof, ['schemaVersion', 'execution', 'relevance', 'mutation']) || proof.schemaVersion !== 2) {
    return `record ${index} proof envelope is malformed`;
  }
  const execution = proof.execution;
  if (!exactKeys(execution, ['runner', 'argv', 'workspaceRefs']) ||
    execution.runner !== STANDARDS_EXECUTION_RUNNER ||
    JSON.stringify(execution.argv) !== JSON.stringify(['node', '--test', record.ref]) ||
    !Array.isArray(execution.workspaceRefs) || execution.workspaceRefs.length < 2 ||
    execution.workspaceRefs.some((ref) => !safeRepoPath(ref)) ||
    new Set(execution.workspaceRefs).size !== execution.workspaceRefs.length ||
    JSON.stringify([...execution.workspaceRefs].sort()) !== JSON.stringify(execution.workspaceRefs)) {
    return `record ${index} execution plan is malformed or is not the pinned runner`;
  }
  const relevance = proof.relevance;
  if (!exactKeys(relevance, [
    'articleId', 'ruleSha256', 'observerRef', 'observerSha256', 'subjectRef', 'subjectBeforeSha256',
  ]) || relevance.articleId !== record.articleId || !SHA256_RE.test(relevance.ruleSha256) ||
    relevance.observerRef !== record.ref || relevance.observerSha256 !== record.sha256 ||
    !safeRepoPath(relevance.subjectRef) || relevance.subjectRef === record.ref ||
    relevance.subjectRef === PROTECTED_VERDICTS_PATH || !SHA256_RE.test(relevance.subjectBeforeSha256)) {
    return `record ${index} relevance envelope is malformed or crosses the subject/observer boundary`;
  }
  if (!execution.workspaceRefs.includes(record.ref) || !execution.workspaceRefs.includes(relevance.subjectRef)) {
    return `record ${index} execution workspace omits the observer or subject`;
  }
  const mutation = proof.mutation;
  if (!exactKeys(mutation, ['mutationId', 'subjectRef', 'search', 'replacement', 'subjectAfterSha256']) ||
    typeof mutation.mutationId !== 'string' || mutation.mutationId.trim().length < 3 ||
    mutation.subjectRef !== relevance.subjectRef || typeof mutation.search !== 'string' || mutation.search.length === 0 ||
    typeof mutation.replacement !== 'string' || mutation.replacement === mutation.search ||
    !SHA256_RE.test(mutation.subjectAfterSha256) || mutation.subjectAfterSha256 === relevance.subjectBeforeSha256) {
    return `record ${index} subject mutation is malformed or crosses the relevance boundary`;
  }
  return null;
}

function readProtectedVerdicts(snapshot) {
  const text = snapshot.readFile(PROTECTED_VERDICTS_PATH);
  if (text === null) return { records: new Map(), errors: [] };
  try {
    const value = JSON.parse(text);
    if (!exactKeys(value, ['schemaVersion', 'records']) ||
      value.schemaVersion !== PROTECTED_VERDICT_SCHEMA_VERSION || !Array.isArray(value.records)) {
      throw new Error(`must contain exactly schemaVersion: ${PROTECTED_VERDICT_SCHEMA_VERSION} and records[]`);
    }
    const records = new Map();
    for (const [index, record] of value.records.entries()) {
      const error = validProofRecord(record, index);
      if (error) throw new Error(error);
      const key = `${record.articleId}\0${record.ref}`;
      if (records.has(key)) throw new Error(`duplicate article/reference proof ${record.articleId} -> ${record.ref}`);
      records.set(key, record);
    }
    return { records, errors: [] };
  } catch (error) {
    return { records: new Map(), errors: [`protected verdict ledger invalid: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

function verdictStrength(verdict) {
  if (verdict === 'EFFECTIVE') return 'ratchet';
  if (verdict === 'WIRED') return 'gate';
  return 'spec-only';
}

const refKey = (kind, ref) => `${kind}\0${ref}`;

/**
 * Closed-census measurement. `articles` contain `{id,family,name,refs}` and refs
 * contain sorted `files/routes/markers`. Only a reference already associated with
 * the same protected article may contribute. Candidate-only testimony is unverified.
 */
export async function measureAnchoredEnforcement({
  root,
  protectedArticles,
  candidateArticles,
  snapshot,
  protectedRouteExists = () => false,
  candidateRouteExists = () => false,
  protectedMarkerExists = () => false,
  candidateMarkerExists = () => false,
  candidateReadFile = null,
}) {
  const errors = [];
  if (!Array.isArray(protectedArticles) || protectedArticles.length === 0) errors.push('protected rule population is empty or unreadable');
  if (!Array.isArray(candidateArticles) || candidateArticles.length === 0) errors.push('candidate rule population is empty or unreadable');
  const protectedById = new Map();
  const candidateById = new Map();
  for (const article of protectedArticles ?? []) {
    if (!article.id || protectedById.has(article.id)) errors.push(`protected article identity is missing or duplicated: ${article.id ?? 'missing'}`);
    else protectedById.set(article.id, article);
  }
  for (const article of candidateArticles ?? []) {
    if (!article.id || candidateById.has(article.id)) errors.push(`candidate article identity is missing or duplicated: ${article.id ?? 'missing'}`);
    else candidateById.set(article.id, article);
  }

  const additions = [...candidateById.keys()].filter((id) => !protectedById.has(id)).sort();
  const removals = [...protectedById.keys()].filter((id) => !candidateById.has(id)).sort();
  const continuityIds = [...new Set([...protectedById.keys(), ...candidateById.keys()])].sort();
  const protectedFamilies = new Map();
  const candidateFamilies = new Map();
  for (const article of protectedById.values()) {
    if (!protectedFamilies.has(article.family)) protectedFamilies.set(article.family, new Set());
    protectedFamilies.get(article.family).add(article.id);
  }
  for (const article of candidateById.values()) {
    if (!candidateFamilies.has(article.family)) candidateFamilies.set(article.family, new Set());
    candidateFamilies.get(article.family).add(article.id);
  }
  const byFamily = Object.create(null);
  for (const family of new Set([...protectedFamilies.keys(), ...candidateFamilies.keys()])) {
    const protectedIds = protectedFamilies.get(family) ?? new Set();
    const candidateIds = candidateFamilies.get(family) ?? new Set();
    byFamily[family] = {
      protectedBase: protectedIds.size,
      candidate: candidateIds.size,
      continuity: new Set([...protectedIds, ...candidateIds]).size,
    };
  }
  if (removals.length > 0) errors.push(`population shrank by ${removals.length} (direction: removal)`);

  const protectedVerdicts = readProtectedVerdicts(snapshot);
  errors.push(...protectedVerdicts.errors);
  const readCandidateFile = candidateReadFile ?? candidateReader(root);
  const unverifiedReferences = [];
  const articleResults = [];

  for (const id of continuityIds) {
    const candidate = candidateById.get(id) ?? null;
    const protectedArticle = protectedById.get(id) ?? null;
    if (!candidate) {
      articleResults.push({ id, family: protectedArticle.family, name: protectedArticle.name, strength: 'documented-only', references: [] });
      continue;
    }
    const protectedRefs = new Set();
    if (protectedArticle) {
      for (const kind of ['files', 'routes', 'markers']) {
        for (const ref of protectedArticle.refs[kind] ?? []) protectedRefs.add(refKey(kind, ref));
      }
    }
    const references = [];
    for (const kind of ['files', 'routes', 'markers']) {
      for (const ref of candidate.refs[kind] ?? []) {
        let result;
        if (!protectedArticle || !protectedRefs.has(refKey(kind, ref))) {
          result = { proven: false, strength: 'documented-only', reason: 'reference-not-in-protected-census' };
        } else if (kind === 'files') {
          const protectedContent = snapshot.readFile(ref);
          const candidateContent = readCandidateFile(ref);
          if (candidateContent === null) {
            result = { proven: false, strength: 'documented-only', reason: 'candidate-reference-unreadable' };
          } else if (candidateContent.trim().length === 0) {
            result = { proven: false, strength: 'documented-only', reason: 'candidate-reference-empty' };
          } else {
            const protectedGrade = gradeFileReference(ref, protectedContent);
            const candidateGrade = gradeFileReference(ref, candidateContent);
            const certified = protectedVerdicts.records.get(`${id}\0${ref}`);
            if (certified && protectedContent !== null && certified.sha256 !== sha256(protectedContent)) {
              errors.push(`protected verdict digest mismatch for ${ref}`);
              result = { proven: false, strength: 'documented-only', reason: 'protected-verdict-digest-mismatch' };
            } else if (certified && protectedContent !== null && sha256(candidateContent) !== certified.sha256) {
              result = { proven: false, strength: 'documented-only', reason: 'certified-reference-changed' };
            } else if (certified && (
              certified.articleSha256 !== protectedArticle.articleSha256 ||
              certified.proof.relevance.ruleSha256 !== protectedArticle.ruleSha256
            )) {
              errors.push(`protected relevance proof article digest mismatch for ${id} -> ${ref}`);
              result = { proven: false, strength: 'documented-only', reason: 'protected-relevance-proof-article-mismatch' };
            } else if (certified && candidate.ruleSha256 !== certified.proof.relevance.ruleSha256) {
              result = { proven: false, strength: 'documented-only', reason: 'candidate-cited-rule-changed' };
            } else if (certified) {
              const subjectRef = certified.proof.relevance.subjectRef;
              const protectedSubject = snapshot.readFile(subjectRef);
              const candidateSubject = readCandidateFile(subjectRef);
              if (protectedSubject === null || sha256(protectedSubject) !== certified.proof.relevance.subjectBeforeSha256) {
                errors.push(`protected relevance proof subject digest mismatch for ${id} -> ${ref}`);
                result = { proven: false, strength: 'documented-only', reason: 'protected-relevance-proof-subject-mismatch' };
              } else if (candidateSubject === null || sha256(candidateSubject) !== certified.proof.relevance.subjectBeforeSha256) {
                result = { proven: false, strength: 'documented-only', reason: 'certified-subject-changed' };
              } else {
                let unavailableWorkspaceRef = null;
                let changedWorkspaceRef = null;
                for (const workspaceRef of certified.proof.execution.workspaceRefs) {
                  const protectedInput = snapshot.readFile(workspaceRef);
                  const candidateInput = readCandidateFile(workspaceRef);
                  if (protectedInput === null) {
                    unavailableWorkspaceRef = workspaceRef;
                    break;
                  }
                  if (candidateInput === null || sha256(candidateInput) !== sha256(protectedInput)) {
                    changedWorkspaceRef = workspaceRef;
                    break;
                  }
                }
                if (unavailableWorkspaceRef !== null) {
                  result = {
                    proven: false,
                    strength: 'documented-only',
                    reason: `protected-execution-workspace-input-unknown:${unavailableWorkspaceRef}`,
                    evidenceStatus: 'unknown',
                  };
                } else if (changedWorkspaceRef !== null) {
                  result = {
                    proven: false,
                    strength: 'documented-only',
                    reason: `candidate-execution-workspace-input-changed:${changedWorkspaceRef}`,
                    evidenceStatus: 'not-proven',
                  };
                } else {
                  const observed = await verifyProtectedExecutionProof({ record: certified, snapshot });
                const artifact = observed.artifact;
                const liveArtifact = artifact !== null && isLiveAuthenticatedExecutionArtifact(artifact);
                if (observed.status === 'proven' && liveArtifact) {
                  result = {
                    proven: true,
                    strength: verdictStrength(certified.verdict),
                    reason: `protected-observed-${certified.verdict.toLowerCase()}-with-authenticated-fail-direction`,
                    evidenceStatus: 'proven',
                    executionArtifactSha256: artifact.artifactSha256,
                    execution: {
                      cleanExitCode: artifact.clean.exitCode,
                      cleanTestsRun: artifact.clean.testsRun,
                      mutatedExitCode: artifact.mutated.exitCode,
                      mutatedTestsRun: artifact.mutated.testsRun,
                      confirmationExitCode: artifact.confirmation.exitCode,
                      confirmationTestsRun: artifact.confirmation.testsRun,
                      mutationLanded: artifact.subject.mutationLanded,
                      decidingOutput: artifact.mutated.decidingOutput,
                    },
                  };
                } else {
                  const evidenceStatus = observed.status === 'unknown' ? 'unknown' : 'not-proven';
                  result = {
                    proven: false,
                    strength: 'documented-only',
                    reason: `protected-execution-proof-${evidenceStatus}:${observed.reason}`,
                    evidenceStatus,
                    ...(liveArtifact ? {
                      executionArtifactSha256: artifact.artifactSha256,
                      execution: {
                        cleanExitCode: artifact.clean.exitCode,
                        cleanTestsRun: artifact.clean.testsRun,
                        mutatedExitCode: artifact.mutated.exitCode,
                        mutatedTestsRun: artifact.mutated.testsRun,
                        confirmationExitCode: artifact.confirmation.exitCode,
                        confirmationTestsRun: artifact.confirmation.testsRun,
                        mutationLanded: artifact.subject.mutationLanded,
                        decidingOutput: artifact.mutated.decidingOutput,
                      },
                    } : {}),
                  };
                }
                }
              }
            } else {
              result = !protectedGrade.proven && protectedGrade.reason === 'reference-structurally-hollow'
                ? protectedGrade
                : candidateGrade.reason === 'reference-structurally-hollow'
                  ? candidateGrade
                  : { proven: false, strength: 'documented-only', reason: 'protected-relevance-proof-missing' };
            }
          }
        } else {
          const onProtected = kind === 'routes' ? protectedRouteExists(ref) : protectedMarkerExists(ref);
          const onCandidate = kind === 'routes' ? candidateRouteExists(ref) : candidateMarkerExists(ref);
          result = onProtected && onCandidate
            ? { proven: false, strength: 'documented-only', reason: 'protected-relevance-proof-missing' }
            : { proven: false, strength: 'documented-only', reason: onCandidate ? 'protected-reference-unresolved' : 'candidate-reference-unresolved' };
        }
        references.push({ kind, ref, ...result });
        if (!result.proven) unverifiedReferences.push({ articleId: id, standard: candidate.name, kind, ref, reason: result.reason });
      }
    }
    let strength = 'documented-only';
    for (const reference of references) {
      if (reference.proven && STRENGTH_RANK[reference.strength] > STRENGTH_RANK[strength]) strength = reference.strength;
    }
    articleResults.push({ id, family: candidate.family, name: candidate.name, strength, references });
  }

  return {
    status: errors.length === 0 ? 'proven' : 'not-proven',
    errors,
    basis: {
      source: snapshot.source,
      protectedMainSha: snapshot.protectedMainSha,
      baseRevision: snapshot.baseRevision,
      candidateTreeMayRaiseStrength: false,
    },
    population: {
      protectedBase: protectedById.size,
      candidate: candidateById.size,
      continuity: continuityIds.length,
      additions,
      removals,
      byFamily,
    },
    unverifiedReferences,
    articles: articleResults,
  };
}
