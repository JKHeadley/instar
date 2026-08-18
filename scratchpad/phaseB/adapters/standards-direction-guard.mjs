import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REGISTRY = 'docs/STANDARDS-REGISTRY.md';
const APPROVALS = 'docs/standards-direction-approvals.json';
const CANDIDATE_PIN = '.github/keyrings/telegram-principal-pub.pem';
const GUARD = 'scripts/standards-direction-guard.mjs';
const PIPELINE = 'scripts/standards-coverage.mjs';
const GUARD_TEST = 'tests/unit/standards-direction-guard.test.ts';
const CONTRACT_TEST = 'tests/unit/standards-direction-guard-contract.test.ts';
const BASE_REGISTRY = '.b0-s5-protected-registry.md';
const BASE_PIN = '.b0-s5-protected-approver.pem';
const BASE_PIN_PRIVATE = '.b0-s5-protected-approver-private.pem';
const ATTACKER_PRIVATE = '.b0-s5-attacker-private.pem';
const BLINDED_BASE = `${BASE_REGISTRY}.blinded`;
const BASE_REVISION = 'b0-s5-protected-base';

const ORIGINAL_RULE = '**Rule.** If a behavior matters, enforce it in architecture, not in instructions. Never rely on an agent "remembering" to follow a rule buried in a long prompt.';
const HOLLOW_RULE = '**Rule.** If a behavior matters, we should prefer architecture where practical; documenting it and remembering to apply it is an acceptable alternative.';

function absolute(root, rel) {
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`path escapes isolated root: ${rel}`);
  return resolved;
}

function read(root, rel) {
  return fs.readFileSync(absolute(root, rel), 'utf8');
}

function write(root, rel, content) {
  fs.mkdirSync(path.dirname(absolute(root, rel)), { recursive: true });
  fs.writeFileSync(absolute(root, rel), content, 'utf8');
}

function replaceOnce(root, rel, before, after) {
  const content = read(root, rel);
  const first = content.indexOf(before);
  const last = content.lastIndexOf(before);
  if (first === -1 || first !== last) throw new Error(`${rel}: expected exactly one replacement target; first=${first} last=${last}`);
  write(root, rel, `${content.slice(0, first)}${after}${content.slice(first + before.length)}`);
}

function replaceFunctionThroughMarker(root, replacement) {
  const content = read(root, GUARD);
  const signature = 'export function evaluateStandardsDirection({';
  const start = content.indexOf(signature);
  const signatureEnd = content.indexOf('}) {', start) + 4;
  const end = content.indexOf('\n}\n\n/** Fail-closed protected-base registry acquisition', signatureEnd);
  if (start === -1 || signatureEnd < 4 || end === -1 || content.indexOf(signature, start + signature.length) !== -1) {
    throw new Error('evaluateStandardsDirection boundary is missing or ambiguous');
  }
  write(root, GUARD, `${content.slice(0, signatureEnd)}${replacement}${content.slice(end)}`);
}

function run(root, argv) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${argv.join(' ')} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  return result.stdout;
}

function verification(checks) {
  return { ok: checks.every((item) => item.passed), checks };
}

function weakeningApplied(root) {
  const content = read(root, REGISTRY);
  return verification([
    { check: 'Root identity and heading remain present', passed: content.includes('### Structure beats Willpower') },
    { check: 'original constitutional direction is absent', passed: !content.includes(ORIGINAL_RULE) },
    { check: 'opposite direction is present', passed: content.includes(HOLLOW_RULE) },
  ]);
}

function applyWeakening(root) {
  replaceOnce(root, REGISTRY, ORIGINAL_RULE, HOLLOW_RULE);
}

function writeAttackerApproval(root) {
  const generator = `
import crypto from 'node:crypto';
import fs from 'node:fs';
import { canonicalDirectionPayload, evaluateStandardsDirection, inventoryStandardsArticles } from './scripts/standards-direction-guard.mjs';
const [baseFile, candidateFile, privateFile] = process.argv.slice(1);
const base = fs.readFileSync(baseFile, 'utf8');
const candidate = fs.readFileSync(candidateFile, 'utf8');
const id = 'legacy/the-root/structure-beats-willpower';
const result = evaluateStandardsDirection({ baseMarkdown: base, candidateMarkdown: candidate, baseRevision: '${BASE_REVISION}' });
const summary = (article) => article ? ({ id: article.id, family: article.family, name: article.name, ruleSha256: article.ruleSha256, articleSha256: article.articleSha256 }) : null;
const before = inventoryStandardsArticles(base).articles.find((article) => article.id === id);
const after = inventoryStandardsArticles(candidate).articles.find((article) => article.id === id);
const payload = {
  schemaVersion: 1,
  baseRevision: '${BASE_REVISION}',
  baseRegistrySha256: result.baseRegistrySha256,
  candidateRegistrySha256: result.candidateRegistrySha256,
  articleId: id,
  change: 'edit',
  direction: 'weaken',
  before: summary(before),
  after: summary(after),
  approvedBy: 'subject-self-reports-clean',
  approvedAt: new Date().toISOString(),
};
const privateKey = crypto.createPrivateKey(fs.readFileSync(privateFile, 'utf8'));
const signature = crypto.sign(null, Buffer.from(canonicalDirectionPayload(payload), 'utf8'), privateKey).toString('base64');
process.stdout.write(JSON.stringify({ schemaVersion: 1, approvals: [{ payload, signature }] }, null, 2) + '\\n');
`;
  const ledger = run(root, [
    process.execPath,
    '--input-type=module',
    '-e',
    generator,
    BASE_REGISTRY,
    REGISTRY,
    ATTACKER_PRIVATE,
  ]);
  write(root, APPROVALS, ledger);
}

const baseEnv = [
  `STANDARDS_DIRECTION_BASE_FILE=${BASE_REGISTRY}`,
  `STANDARDS_DIRECTION_BASE_APPROVER_KEY_FILE=${BASE_PIN}`,
  `STANDARDS_DIRECTION_BASE_REVISION=${BASE_REVISION}`,
];

export const pipelineCommands = [{
  argv: ['env', ...baseEnv, 'node', PIPELINE, '--check'],
  observeAny: ['standards-coverage', 'standards-direction-guard.mjs', 'DIRECTION GUARD'],
  timeoutMs: 60_000,
}];

export const guardCommands = [
  {
    argv: ['env', ...baseEnv, 'node', PIPELINE, '--check'],
    observeAny: ['standards-coverage', 'standards-direction-guard.mjs', 'DIRECTION GUARD'],
    timeoutMs: 60_000,
  },
  {
    argv: ['node_modules/.bin/vitest', 'run', GUARD_TEST, CONTRACT_TEST, '--reporter=verbose'],
    observeAny: ['standards direction guard', 'standards-direction-guard', 'Test Files'],
    timeoutMs: 120_000,
  },
];

export function prepareWorkspace(root) {
  write(root, BASE_REGISTRY, run(root, ['git', 'show', 'HEAD^:docs/STANDARDS-REGISTRY.md']));
  const operator = crypto.generateKeyPairSync('ed25519');
  const attacker = crypto.generateKeyPairSync('ed25519');
  const operatorPin = operator.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  write(root, BASE_PIN, operatorPin);
  write(root, CANDIDATE_PIN, operatorPin);
  write(root, BASE_PIN_PRIVATE, operator.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  write(root, ATTACKER_PRIVATE, attacker.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  fs.chmodSync(absolute(root, BASE_PIN_PRIVATE), 0o600);
  fs.chmodSync(absolute(root, ATTACKER_PRIVATE), 0o600);
}

export function preparePipelineWorkspace(root, protectedBaseEvidence) {
  const protectedCommit = protectedBaseEvidence?.commit;
  if (!/^[a-f0-9]{40}$/.test(protectedCommit ?? '')) throw new Error('core did not supply a server-resolved protected base');
  write(root, BASE_REGISTRY, run(root, ['git', 'show', `${protectedCommit}:${REGISTRY}`]));
  write(root, BASE_PIN, run(root, ['git', 'show', `${protectedCommit}:${CANDIDATE_PIN}`]));
}

function inspectOutsideEnumeration(root) {
  const program = `
import fs from 'node:fs';
import { evaluateStandardsDirection, inventoryStandardsArticles } from './scripts/standards-direction-guard.mjs';
const [baseFile, candidateFile] = process.argv.slice(1);
const base = fs.readFileSync(baseFile, 'utf8');
const candidate = fs.readFileSync(candidateFile, 'utf8');
const hiddenRule = 'Hidden outside every article heading.';
const inventory = inventoryStandardsArticles(candidate);
const verdict = evaluateStandardsDirection({
  baseMarkdown: base,
  candidateMarkdown: candidate,
  baseRevision: '${BASE_REVISION}',
});
process.stdout.write(JSON.stringify({
  hiddenRuleOccurrences: candidate.split(hiddenRule).length - 1,
  enumeratedHiddenRules: inventory.articles.filter((article) => article.rule.includes(hiddenRule)).length,
  inventoryErrors: inventory.errors,
  verdictStatus: verdict.status,
  verdictErrors: verdict.errors,
}) + '\\n');
`;
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    program,
    BASE_REGISTRY,
    REGISTRY,
  ], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  let proof = null;
  try {
    proof = JSON.parse((result.stdout ?? '').trim());
  } catch { /* malformed output remains fail-closed below */ }
  return {
    exitCode: result.status,
    error: result.error?.message ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    proof,
  };
}

export function verifyMutationRelevant({ root, mutation, changedPaths, guardFiles, subjectFiles }) {
  const declared = new Set([...guardFiles, ...subjectFiles]);

  if (mutation.id === 'p4b-rule-outside-enumeration') {
    const mutationVerification = mutation.verify(root);
    const semantic = inspectOutsideEnumeration(root);
    const parserReportedOpenEnumeration = semantic.proof?.inventoryErrors?.some((error) =>
      error.includes('article enumeration is open')) === true;
    const guardRejectedSameCandidate = semantic.proof?.verdictStatus === 'not-proven'
      && semantic.proof?.verdictErrors?.some((error) =>
        error.includes('candidate: article enumeration is open')) === true;
    const checks = [
      {
        check: 'the real registry subject changed and the planted Rule bytes are present',
        passed: changedPaths.includes(REGISTRY) && declared.has(REGISTRY) && mutationVerification.ok === true,
      },
      {
        check: 'the live inventory parser leaves the planted Rule outside its article enumeration',
        passed: semantic.exitCode === 0
          && semantic.proof?.hiddenRuleOccurrences === 1
          && semantic.proof?.enumeratedHiddenRules === 0,
      },
      {
        check: 'the live parser reports the resulting article enumeration as open',
        passed: parserReportedOpenEnumeration,
      },
      {
        check: 'the production guard contract returns not-proven for that same unrecognized Rule',
        passed: guardRejectedSameCandidate,
      },
    ];
    return {
      status: checks.every((check) => check.passed) ? 'proven' : 'unknown',
      mode: 'outside-enumeration',
      checks,
      decidingOutput: {
        kind: 'live-unrecognized-rule-parser-contract',
        exitCode: semantic.exitCode,
        lines: [
          ...(semantic.stdout.trim() ? [semantic.stdout.trim()] : []),
          ...(semantic.stderr.trim() ? semantic.stderr.trim().split('\n').slice(-5) : []),
        ],
      },
    };
  }

  const protectedBaseRouted = mutation.id === 'p5-blind-protected-base'
    && changedPaths.includes(BASE_REGISTRY)
    && baseEnv.includes(`STANDARDS_DIRECTION_BASE_FILE=${BASE_REGISTRY}`);
  const routed = changedPaths.some((rel) => declared.has(rel)) || protectedBaseRouted;
  const semantic = mutation.verify(root);
  const checks = [
    {
      check: 'mutation changes a declared guard/subject input or the explicitly configured protected-base input',
      passed: routed,
    },
    {
      check: `semantic mutation ${mutation.id} changes its load-bearing body or input`,
      passed: semantic.ok === true && semantic.checks.length > 0 && semantic.checks.every((check) => check.passed === true),
    },
  ];
  return {
    status: checks.every((check) => check.passed) ? 'proven' : 'unknown',
    mode: 'declared-load-bearing-input',
    checks,
  };
}

export const mutations = [
  {
    id: 'p1-symbol-preserving-rule-hollow',
    property: 'P1',
    violationClass: 'hollowing',
    label: 'SYMBOL-PRESERVING HOLLOW',
    paths: [REGISTRY],
    apply(root) { applyWeakening(root); },
    verify(root) { return weakeningApplied(root); },
  },
  {
    id: 'p2-self-report-plus-candidate-pin-replacement',
    property: 'P2',
    violationClass: 'self-report / false testimony',
    label: 'SUBJECT SELF-REPORTS CLEAN AND MOVES THE CANDIDATE PIN',
    paths: [REGISTRY, APPROVALS, CANDIDATE_PIN],
    apply(root) {
      applyWeakening(root);
      const attackerPrivate = crypto.createPrivateKey(read(root, ATTACKER_PRIVATE));
      const attackerPublic = crypto.createPublicKey(attackerPrivate).export({ type: 'spki', format: 'pem' }).toString();
      write(root, CANDIDATE_PIN, attackerPublic);
      writeAttackerApproval(root);
    },
    verify(root) {
      const weakened = weakeningApplied(root);
      const ledger = JSON.parse(read(root, APPROVALS));
      const candidatePin = read(root, CANDIDATE_PIN);
      return verification([
        ...weakened.checks,
        { check: 'subject declares itself a clean approved weakening', passed: ledger.approvals?.[0]?.payload?.direction === 'weaken' },
        { check: 'subject carries a syntactically valid signature', passed: typeof ledger.approvals?.[0]?.signature === 'string' && ledger.approvals[0].signature.length > 40 },
        { check: 'candidate pin was replaced with the attacker public key', passed: candidatePin.includes('BEGIN PUBLIC KEY') && candidatePin !== read(root, BASE_PIN) },
      ]);
    },
  },
  {
    id: 'p2-pin-only-two-step-goalpost-move',
    property: 'P2',
    violationClass: 'self-report / false testimony',
    label: 'MOVE THE TRUST ROOT WITHOUT CHANGING THE REGISTRY',
    paths: [CANDIDATE_PIN],
    apply(root) {
      const attackerPrivate = crypto.createPrivateKey(read(root, ATTACKER_PRIVATE));
      const attackerPublic = crypto.createPublicKey(attackerPrivate).export({ type: 'spki', format: 'pem' }).toString();
      write(root, CANDIDATE_PIN, attackerPublic);
    },
    verify(root) {
      return verification([
        { check: 'registry remains byte-identical to protected base', passed: read(root, REGISTRY) === read(root, BASE_REGISTRY) },
        { check: 'candidate pin differs from protected base', passed: read(root, CANDIDATE_PIN) !== read(root, BASE_PIN) },
        { check: 'candidate pin remains a syntactically valid public key', passed: read(root, CANDIDATE_PIN).includes('BEGIN PUBLIC KEY') },
      ]);
    },
  },
  {
    id: 'p3a-delete',
    property: 'P3',
    violationClass: 'guard removal',
    label: 'DELETE',
    paths: [GUARD],
    apply(root) { fs.unlinkSync(absolute(root, GUARD)); },
    verify(root) { return verification([{ check: `${GUARD} is absent`, passed: !fs.existsSync(absolute(root, GUARD)) }]); },
  },
  {
    id: 'p3b-comment-out',
    property: 'P3',
    violationClass: 'guard removal',
    label: 'COMMENT OUT',
    paths: [GUARD],
    apply(root) { write(root, GUARD, read(root, GUARD).split('\n').map((line) => `// ${line}`).join('\n')); },
    verify(root) {
      const lines = read(root, GUARD).split('\n').filter(Boolean);
      return verification([{ check: `${GUARD} has no executable line`, passed: lines.length > 0 && lines.every((line) => line.startsWith('// ')) }]);
    },
  },
  {
    id: 'p3c-superstring-rename',
    property: 'P3',
    violationClass: 'guard removal',
    label: 'SUPERSTRING RENAME',
    paths: [GUARD],
    apply(root) { write(root, GUARD, read(root, GUARD).replaceAll('evaluateStandardsDirection', 'evaluateStandardsDirectionDisabled')); },
    verify(root) {
      const content = read(root, GUARD);
      return verification([
        { check: 'longer superstring exists', passed: content.includes('evaluateStandardsDirectionDisabled') },
        { check: 'standalone symbol is absent', passed: !/\bevaluateStandardsDirection\b/.test(content) },
      ]);
    },
  },
  {
    id: 'p3d-type-preserving-hollow',
    property: 'P3',
    violationClass: 'guard removal',
    label: 'TYPE-PRESERVING HOLLOW',
    paths: [GUARD],
    apply(root) {
      replaceFunctionThroughMarker(root, `
  // B0 S5 type-preserving hollow: the exact API fabricates a passing verdict.
  return {
    status: 'passed', errors: [], baseRevision,
    baseRegistrySha256: '0'.repeat(64), candidateRegistrySha256: '0'.repeat(64), changes: [],
    population: { protectedBase: 1, candidate: 1, continuity: 1, additions: [], removals: [], byFamily: {} },
  };
`);
    },
    verify(root) {
      const content = read(root, GUARD);
      return verification([
        { check: 'exact exported name and signature remain', passed: content.includes('export function evaluateStandardsDirection({') },
        { check: 'constant passing body is present', passed: content.includes('B0 S5 type-preserving hollow') && content.includes("status: 'passed'") },
        { check: 'real evaluation body is absent', passed: !content.includes('const base = inventoryStandardsArticles(baseMarkdown);') },
      ]);
    },
  },
  {
    id: 'p4a-empty-article-population',
    property: 'P4',
    violationClass: 'vacuous measurement',
    label: 'EMPTY THE POPULATION',
    paths: [REGISTRY],
    apply(root) { write(root, REGISTRY, '# Standards Registry\n'); },
    verify(root) { return verification([{ check: 'candidate has zero Rule articles', passed: !read(root, REGISTRY).includes('**Rule.**') }]); },
  },
  {
    id: 'p4b-rule-outside-enumeration',
    property: 'P4',
    violationClass: 'population evasion',
    label: 'HIDE A REAL RULE OUTSIDE THE ENUMERATION',
    paths: [REGISTRY],
    apply(root) { write(root, REGISTRY, `${read(root, REGISTRY)}\n**Rule.** Hidden outside every article heading.\n`); },
    verify(root) {
      const content = read(root, REGISTRY);
      return verification([{ check: 'a real Rule field exists after all article blocks', passed: content.endsWith('**Rule.** Hidden outside every article heading.\n') }]);
    },
  },
  {
    id: 'p5-blind-protected-base',
    property: 'P5',
    violationClass: 'blind input / fail-open',
    label: 'BLIND THE GUARD',
    paths: [BASE_REGISTRY, BLINDED_BASE],
    apply(root) { fs.renameSync(absolute(root, BASE_REGISTRY), absolute(root, BLINDED_BASE)); },
    verify(root) {
      return verification([
        { check: 'configured protected-base input is unavailable', passed: !fs.existsSync(absolute(root, BASE_REGISTRY)) },
        { check: 'control retains the original bytes', passed: fs.existsSync(absolute(root, BLINDED_BASE)) && read(root, BLINDED_BASE).includes('### Structure beats Willpower') },
      ]);
    },
  },
];
