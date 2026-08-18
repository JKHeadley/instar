import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const VALIDATOR = 'scripts/write-audit-convergence.mjs';
const GUARD_IMPLEMENTATION = 'scripts/write-audit-convergence.mjs';
const CI_RATCHET = 'tests/unit/audit-convergence-reports.test.ts';
const UNIT_GUARD = 'tests/unit/write-audit-convergence.test.ts';
const STANDARDS = 'docs/STANDARDS-REGISTRY.md';
const ENUMERATED_AUDIT_INPUT = 'docs/audits/full-decision-visibility-enactment.md';

function absolute(root, rel) {
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`path escapes isolated root: ${rel}`);
  }
  return resolved;
}
function read(root, rel) {
  return fs.readFileSync(absolute(root, rel), 'utf8');
}

function write(root, rel, content) {
  fs.writeFileSync(absolute(root, rel), content, 'utf8');
}

function replaceOnce(root, rel, before, after) {
  const content = read(root, rel);
  const first = content.indexOf(before);
  const last = content.lastIndexOf(before);
  if (first === -1 || first !== last) {
    throw new Error(`${rel}: expected exactly one replacement target; first=${first} last=${last}`);
  }
  write(root, rel, `${content.slice(0, first)}${after}${content.slice(first + before.length)}`);
}

function replaceFunctionThroughMarker(root, rel, signature, endMarker, replacement) {
  const content = read(root, rel);
  const start = content.indexOf(signature);
  if (start === -1 || content.indexOf(signature, start + signature.length) !== -1) {
    throw new Error(`${rel}: function signature is missing or ambiguous: ${signature}`);
  }
  const end = content.indexOf(endMarker, start);
  if (end === -1) throw new Error(`${rel}: end marker missing after ${signature}`);
  write(root, rel, `${content.slice(0, start)}${replacement}${content.slice(end)}`);
}

function runGit(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`);
  }
}

function verifyIncludes(root, rel, included, excluded = []) {
  const content = read(root, rel);
  const checks = [
    ...included.map((value) => ({ check: `${rel} includes ${JSON.stringify(value)}`, passed: content.includes(value) })),
    ...excluded.map((value) => ({ check: `${rel} excludes ${JSON.stringify(value)}`, passed: !content.includes(value) })),
  ];
  return { ok: checks.every((item) => item.passed), checks };
}

export const pipelineCommands = [
  {
    argv: [
      'npm', 'run', 'test:push', '--',
      CI_RATCHET,
      UNIT_GUARD,
      '--reporter=verbose',
    ],
    observeAny: [
      'audit-convergence CI ratchet',
      'validateAuditReport',
      'write-audit-convergence',
      'No test files found',
    ],
    timeoutMs: 300_000,
  },
];

export const guardCommands = [
  {
    argv: [
      'node_modules/.bin/vitest', 'run',
      CI_RATCHET,
      UNIT_GUARD,
      '--config=.b0-fix-verifier.vitest.config.mjs',
      '--reporter=verbose',
    ],
    observeAny: [
      'audit-convergence CI ratchet',
      'validateAuditReport',
      'write-audit-convergence',
      'No test files found',
    ],
    timeoutMs: 60_000,
  },
];

export function prepareWorkspace(root) {
  write(root, '.b0-fix-verifier.vitest.config.mjs', `export default {\n  test: {\n    environment: 'node',\n    fileParallelism: false,\n    testTimeout: 10_000,\n  },\n};\n`);
}

export function verifyMutationRelevant({ root, mutation, changedPaths, guardFiles, subjectFiles }) {
  const declared = new Set([...guardFiles, ...subjectFiles]);
  const routed = changedPaths.some((rel) => declared.has(rel));
  if (mutation.id === 'p4b-hidden-real-violation') {
    const outsideEnumeration = changedPaths.some((rel) => rel.startsWith('docs/phase-b-b0-4-hidden/'));
    const planted = outsideEnumeration && fs.existsSync(absolute(root, changedPaths.find((rel) => outsideEnumeration && rel)));
    const rel = changedPaths.find((item) => item.startsWith('docs/phase-b-b0-4-hidden/'));
    const auditShaped = planted && /^---\naudit:/m.test(read(root, rel));
    return {
      status: outsideEnumeration && planted && auditShaped ? 'proven' : 'unknown',
      mode: 'outside-enumeration',
      checks: [
        { check: 'planted path is outside docs/audits/ and outside declared baseline inputs', passed: outsideEnumeration && rel && !declared.has(rel) },
        { check: 'planted path exists in isolated tree', passed: planted },
        { check: 'planted bytes are a real audit-frontmatter violation', passed: auditShaped },
      ],
    };
  }
  let semantic = false;
  if (mutation.id === 'p1-symbol-preserving-hollow') semantic = read(root, VALIDATOR).includes('B0.4 symbol-preserving inert stub');
  if (mutation.id === 'p2-subject-self-reports-clean') semantic = read(root, VALIDATOR).includes('B0.4 false testimony');
  if (mutation.id === 'p3a-delete') semantic = [CI_RATCHET, UNIT_GUARD].every((rel) => !fs.existsSync(absolute(root, rel)));
  if (mutation.id === 'p3b-comment-out') semantic = [CI_RATCHET, UNIT_GUARD].every((rel) => read(root, rel).split('\n').filter(Boolean).every((line) => line.startsWith('// ')));
  if (mutation.id === 'p3c-superstring-rename') semantic = [CI_RATCHET, UNIT_GUARD].every((rel) => read(root, rel).includes('validateAuditReportDisabled') && !/\bvalidateAuditReport\b/.test(read(root, rel)));
  if (mutation.id === 'p3d-type-preserving-hollow') semantic = read(root, GUARD_IMPLEMENTATION).includes('B0.4 type-preserving hollow');
  if (mutation.id === 'p4a-empty-population') semantic = read(root, CI_RATCHET).includes('B0.4 forced vacuous denominator');
  if (mutation.id === 'p5-blind-input') {
    const blinded = `${ENUMERATED_AUDIT_INPUT}.b0-4-blinded`;
    semantic = !fs.existsSync(absolute(root, ENUMERATED_AUDIT_INPUT)) && fs.existsSync(absolute(root, blinded)) && /^---\naudit:/m.test(read(root, blinded));
  }
  return {
    status: routed && semantic ? 'proven' : 'unknown',
    mode: 'declared-load-bearing-input',
    checks: [
      { check: 'changed path routed through declared guard/subject set', passed: routed },
      { check: `semantic mutation ${mutation.id} changes the load-bearing body/input`, passed: semantic },
    ],
  };
}

export const mutations = [
  {
    id: 'p1-symbol-preserving-hollow',
    property: 'P1',
    violationClass: 'hollowing',
    label: 'SYMBOL-PRESERVING HOLLOW',
    paths: [VALIDATOR],
    apply(root) {
      replaceFunctionThroughMarker(
        root,
        VALIDATOR,
        'export function stampConverged(text, roundsCount, nowIso) {',
        '\n// ─── main ───────────────────────────────────────────────────────────────────',
        `export function stampConverged(text, roundsCount, nowIso) {\n  // B0.4 symbol-preserving inert stub: same API, no state transition.\n  void roundsCount;\n  void nowIso;\n  return text;\n}\n`,
      );
    },
    verify(root) {
      return verifyIncludes(root, VALIDATOR, [
        'export function stampConverged(text, roundsCount, nowIso) {',
        'B0.4 symbol-preserving inert stub',
        'return text;',
      ]);
    },
  },
  {
    id: 'p2-subject-self-reports-clean',
    property: 'P2',
    violationClass: 'self-report / false testimony',
    label: 'SUBJECT SELF-REPORTS CLEAN',
    paths: [VALIDATOR],
    apply(root) {
      replaceFunctionThroughMarker(
        root,
        VALIDATOR,
        'export function validateAuditReport(text, opts = {}) {',
        '\n// ─── stamping (byte-idempotent) ─────────────────────────────────────────────',
        `export function validateAuditReport(text, opts = {}) {\n  // B0.4 false testimony: behavior is not inspected, but the subject claims clean.\n  void text;\n  void opts;\n  return {\n    ok: true,\n    reason: 'subject-self-reports-clean',\n    rounds: [{ n: 1 }, { n: 2 }],\n    responseKind: 'no-change',\n  };\n}\n`,
      );
    },
    verify(root) {
      return verifyIncludes(root, VALIDATOR, [
        'export function validateAuditReport(text, opts = {}) {',
        'B0.4 false testimony',
        "reason: 'subject-self-reports-clean'",
      ]);
    },
  },
  {
    id: 'p3a-delete',
    property: 'P3',
    violationClass: 'guard removal',
    label: 'DELETE',
    paths: [CI_RATCHET, UNIT_GUARD],
    apply(root) {
      fs.unlinkSync(absolute(root, CI_RATCHET));
      fs.unlinkSync(absolute(root, UNIT_GUARD));
    },
    verify(root) {
      const checks = [CI_RATCHET, UNIT_GUARD].map((rel) => ({
        check: `${rel} is absent`,
        passed: !fs.existsSync(absolute(root, rel)),
      }));
      return { ok: checks.every((item) => item.passed), checks };
    },
  },
  {
    id: 'p3b-comment-out',
    property: 'P3',
    violationClass: 'guard removal',
    label: 'COMMENT OUT',
    paths: [CI_RATCHET, UNIT_GUARD],
    apply(root) {
      for (const rel of [CI_RATCHET, UNIT_GUARD]) {
        write(root, rel, read(root, rel).split('\n').map((line) => `// ${line}`).join('\n'));
      }
    },
    verify(root) {
      const checks = [CI_RATCHET, UNIT_GUARD].map((rel) => {
        const lines = read(root, rel).split('\n').filter((line) => line.length > 0);
        return { check: `${rel} has no executable non-comment line`, passed: lines.length > 0 && lines.every((line) => line.startsWith('// ')) };
      });
      return { ok: checks.every((item) => item.passed), checks };
    },
  },
  {
    id: 'p3c-superstring-rename',
    property: 'P3',
    violationClass: 'guard removal',
    label: 'SUPERSTRING RENAME',
    paths: [CI_RATCHET, UNIT_GUARD],
    apply(root) {
      for (const rel of [CI_RATCHET, UNIT_GUARD]) {
        const content = read(root, rel);
        if (!content.includes('validateAuditReport')) throw new Error(`${rel}: validateAuditReport symbol missing`);
        write(root, rel, content.replaceAll('validateAuditReport', 'validateAuditReportDisabled'));
      }
    },
    verify(root) {
      const checks = [CI_RATCHET, UNIT_GUARD].flatMap((rel) => {
        const content = read(root, rel);
        return [
          { check: `${rel} contains longer superstring`, passed: content.includes('validateAuditReportDisabled') },
          { check: `${rel} still contains original substring`, passed: content.includes('validateAuditReport') },
          { check: `${rel} has no standalone original symbol`, passed: !/\bvalidateAuditReport\b/.test(content) },
        ];
      });
      return { ok: checks.every((item) => item.passed), checks };
    },
  },
  {
    id: 'p3d-type-preserving-hollow',
    property: 'P3',
    violationClass: 'guard removal',
    label: 'TYPE-PRESERVING HOLLOW',
    paths: [GUARD_IMPLEMENTATION],
    apply(root) {
      replaceFunctionThroughMarker(
        root,
        GUARD_IMPLEMENTATION,
        'export function validateAuditReport(text, opts = {}) {',
        '\n// ─── stamping (byte-idempotent) ─────────────────────────────────────────────',
        `export function validateAuditReport(text, opts = {}) {
  // B0.4 type-preserving hollow: constant passing verdict; suite must assert behavior.
  void text;
  void opts;
  return { ok: true, rounds: [{ n: 1 }, { n: 2 }], responseKind: 'no-change' };
}
`,
      );
    },
    verify(root) {
      return verifyIncludes(root, GUARD_IMPLEMENTATION, [
        'export function validateAuditReport(text, opts = {}) {',
        'B0.4 type-preserving hollow',
        "return { ok: true, rounds: [{ n: 1 }, { n: 2 }], responseKind: 'no-change' };",
      ]);
    },
  },
  {
    id: 'p4a-empty-population',
    property: 'P4',
    violationClass: 'vacuous measurement',
    label: 'EMPTY THE POPULATION',
    paths: [CI_RATCHET],
    apply(root) {
      const before = `function committedDocsMd(): string[] {\n  const out = execFileSync('git', ['ls-files', 'docs/**/*.md'], { cwd: ROOT, encoding: 'utf8' });\n  return out.split('\\n').map((s) => s.trim()).filter(Boolean);\n}`;
      const after = `function committedDocsMd(): string[] {\n  // B0.4 forced vacuous denominator.\n  return [];\n}`;
      replaceOnce(root, CI_RATCHET, before, after);
    },
    verify(root) {
      return verifyIncludes(root, CI_RATCHET, ['B0.4 forced vacuous denominator', 'return [];']);
    },
  },
  {
    id: 'p4b-hidden-real-violation',
    property: 'P4',
    violationClass: 'population evasion',
    label: 'HIDE A REAL VIOLATION OUTSIDE THE PRIMARY ENUMERATION',
    paths: ['docs/phase-b-b0-4-hidden/audit-outside-canonical-root.md'],
    apply(root) {
      const rel = this.paths[0];
      fs.mkdirSync(path.dirname(absolute(root, rel)), { recursive: true });
      write(root, rel, `---\naudit: "outside-canonical-root"\nconverged: "2099-01-01T00:00:00.000Z"\n---\n\n# Real audit-shaped violation outside docs/audits/\n`);
      // The CI ratchet enumerates committed/indexed docs. Stage only inside the isolated clone.
      runGit(root, ['add', '--', rel]);
    },
    verify(root) {
      const rel = this.paths[0];
      const content = read(root, rel);
      const indexed = spawnSync('git', ['ls-files', '--error-unmatch', rel], { cwd: root, encoding: 'utf8' });
      const checks = [
        { check: `${rel} contains audit frontmatter`, passed: /^---\naudit:/m.test(content) },
        { check: `${rel} is outside docs/audits/`, passed: rel.startsWith('docs/') && !rel.startsWith('docs/audits/') },
        { check: `${rel} is in the isolated Git index`, passed: indexed.status === 0 },
      ];
      return { ok: checks.every((item) => item.passed), checks };
    },
  },
  {
    id: 'p5-blind-input',
    property: 'P5',
    violationClass: 'blind input / fail-open',
    label: 'BLIND THE GUARD',
    paths: [ENUMERATED_AUDIT_INPUT, `${ENUMERATED_AUDIT_INPUT}.b0-4-blinded`],
    apply(root) {
      fs.renameSync(
        absolute(root, ENUMERATED_AUDIT_INPUT),
        absolute(root, `${ENUMERATED_AUDIT_INPUT}.b0-4-blinded`),
      );
    },
    verify(root) {
      const checks = [
        { check: `${ENUMERATED_AUDIT_INPUT} is unavailable`, passed: !fs.existsSync(absolute(root, ENUMERATED_AUDIT_INPUT)) },
        { check: 'blinded control file retains the bytes', passed: fs.existsSync(absolute(root, `${ENUMERATED_AUDIT_INPUT}.b0-4-blinded`)) },
      ];
      return { ok: checks.every((item) => item.passed), checks };
    },
  },
];

export function applyDeliberatelyHollowGuard(root) {
  const hollow = `import { describe, it, expect } from 'vitest';\n\ndescribe('audit-convergence deliberately hollow guard', () => {\n  it('self-reports clean without inspecting the subject', () => {\n    expect(true).toBe(true);\n  });\n});\n`;
  for (const rel of [CI_RATCHET, UNIT_GUARD]) write(root, rel, hollow);
  return {
    paths: [CI_RATCHET, UNIT_GUARD],
    verify() {
      const checks = [CI_RATCHET, UNIT_GUARD].map((rel) => ({
        check: `${rel} carries deliberate hollow marker`,
        passed: read(root, rel).includes('audit-convergence deliberately hollow guard'),
      }));
      return { ok: checks.every((item) => item.passed), checks };
    },
  };
}
