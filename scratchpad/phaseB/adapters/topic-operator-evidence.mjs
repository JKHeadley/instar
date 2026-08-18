import fs from 'node:fs';
import path from 'node:path';

const STORE = 'src/users/TopicOperatorStore.ts';
const ROUTES = 'src/server/routes.ts';
const UNIT_GUARD = 'tests/unit/topic-operator-store.test.ts';
const ROUTE_GUARD = 'tests/integration/topic-operator-routes.test.ts';
const AUTH_PATH_GUARD = 'tests/integration/topic-operator-autobind-route.test.ts';

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

function replaceThroughMarker(root, rel, startMarker, endMarker, replacement) {
  const content = read(root, rel);
  const start = content.indexOf(startMarker);
  if (start === -1 || content.indexOf(startMarker, start + startMarker.length) !== -1) {
    throw new Error(`${rel}: start marker is missing or ambiguous: ${startMarker}`);
  }
  const end = content.indexOf(endMarker, start);
  if (end === -1) throw new Error(`${rel}: end marker missing after ${startMarker}`);
  write(root, rel, `${content.slice(0, start)}${replacement}${content.slice(end)}`);
}

function verifyIncludes(root, rel, included, excluded = []) {
  const content = read(root, rel);
  const checks = [
    ...included.map((value) => ({ check: `${rel} includes ${JSON.stringify(value)}`, passed: content.includes(value) })),
    ...excluded.map((value) => ({ check: `${rel} excludes ${JSON.stringify(value)}`, passed: !content.includes(value) })),
  ];
  return { ok: checks.every((item) => item.passed), checks };
}

const TEST_ARGS = [UNIT_GUARD, ROUTE_GUARD, AUTH_PATH_GUARD];

export const pipelineCommands = [
  {
    argv: ['npm', 'run', 'test:push', '--', ...TEST_ARGS, '--reporter=verbose'],
    observeAny: [
      'TopicOperatorStore asserted and legacy bindings',
      'Topic Operator Routes (integration)',
      'topic-operator auto-bind (integration)',
      'No test files found',
    ],
    timeoutMs: 1_200_000,
  },
];

export const guardCommands = [
  {
    argv: [
      'node_modules/.bin/vitest', 'run', ...TEST_ARGS,
      '--config=.b0-fix-verifier.vitest.config.mjs',
      '--reporter=verbose',
    ],
    observeAny: [
      'TopicOperatorStore asserted and legacy bindings',
      'Topic Operator Routes (integration)',
      'topic-operator auto-bind (integration)',
      'No test files found',
    ],
    timeoutMs: 120_000,
  },
];

export function prepareWorkspace(root) {
  write(root, '.b0-fix-verifier.vitest.config.mjs', `export default {\n  test: {\n    environment: 'node',\n    fileParallelism: false,\n    testTimeout: 20_000,\n  },\n};\n`);
}

const PREDICATE_START = 'export function isVerifiedTopicOperatorBinding(value: unknown): value is TopicOperator {';
const PREDICATE_END = '\n\nexport class TopicOperatorStore {';
const AUTH_WRITER_START = '  setAuthenticatedOperator(';
const AUTH_WRITER_END = '\n\n  private persistBinding(';
const ALL_START = '  all(): Record<string, TopicOperator> {';
const ALL_END = '\n\n  /** All raw bindings for inspection only. */';

function structuredRelevance(mode, checks) {
  return {
    status: checks.length > 0 && checks.every((item) => item.passed === true) ? 'proven' : 'unknown',
    mode,
    checks,
  };
}

/**
 * Carry semantic evidence that each mutation actually reaches a load-bearing
 * subject input.  The verifier deliberately refuses an unstructured claim;
 * these checks are read-only and describe the mutation after it is applied.
 */
export function verifyMutationRelevant({ root, mutation, changedPaths, guardFiles = [], subjectFiles = [] }) {
  const declared = new Set([...guardFiles, ...subjectFiles]);
  const routed = changedPaths.some((rel) => declared.has(rel));
  const store = () => read(root, STORE);
  const routes = () => read(root, ROUTES);
  const declaredCheck = { check: 'mutation changed a declared load-bearing subject path', passed: routed };

  if (mutation.id === 'p4b-hidden-real-violation') {
    const content = store();
    return structuredRelevance('outside-enumeration', [
      declaredCheck,
      {
        check: 'non-numeric topic key is explicitly excluded by the mutated enumeration',
        passed: content.includes("if (!/^\\d+$/.test(topicId)) continue;"),
      },
      {
        check: 'the mutated enumeration still subjects numeric entries to the evidence predicate',
        passed: content.includes('isVerifiedTopicOperatorBinding(binding)'),
      },
    ]);
  }

  const checks = [declaredCheck];
  const content = mutation.id === 'p5-blind-input' ? routes() : store();
  switch (mutation.id) {
    case 'p1-symbol-preserving-hollow':
      checks.push({ check: 'authenticated writer body is the type-correct hollow mutation', passed: content.includes('B0.1 P1: API preserved, authenticated state transition hollowed.') && content.includes('return null;') });
      break;
    case 'p2-subject-self-reports-clean':
      checks.push({ check: 'predicate now trusts provenance instead of evidence', passed: content.includes("B0.1 P2: trust the subject's provenance claim") && content.includes(".boundFrom === 'authenticated-inbound'") && !content.includes('evidence.kind !==') });
      break;
    case 'p3a-delete':
      checks.push({ check: 'predicate declaration is absent after deletion', passed: !content.includes(PREDICATE_START) });
      break;
    case 'p3b-comment-out':
      checks.push({ check: 'predicate declaration and verdict are comments, not executable code', passed: content.includes(`// ${PREDICATE_START}`) && !content.split('\n').includes(PREDICATE_START) });
      break;
    case 'p3c-superstring-rename':
      checks.push({ check: 'only the longer superstring predicate name remains', passed: content.includes('isVerifiedTopicOperatorBindingDisabled') && !content.includes(PREDICATE_START) });
      break;
    case 'p3d-type-preserving-hollow':
      checks.push({ check: 'predicate returns a type-valid constant verdict', passed: content.includes('B0.1 P3d: type-preserving constant passing verdict.') && content.includes('return true;') });
      break;
    case 'p4a-empty-population':
      checks.push({ check: 'enumerator returns the deliberately empty population', passed: content.includes('B0.1 P4a: force a vacuous verified-binding population.') && content.includes('return {};') });
      break;
    case 'p5-blind-input':
      checks.push({ check: 'both direct and raw evidence inputs are blinded', passed: content.includes("messageId: '', // B0.1 P5: authenticated evidence input unavailable.") && content.includes("telegramMessageId: '', // B0.1 P5: raw lifeline evidence input unavailable.") });
      break;
    default:
      checks.push({ check: `adapter recognizes mutation ${mutation.id}`, passed: false });
  }
  return structuredRelevance('declared-load-bearing-input', checks);
}

export const mutations = [
  {
    id: 'p1-symbol-preserving-hollow',
    property: 'P1',
    violationClass: 'hollowing',
    label: 'SYMBOL-PRESERVING HOLLOW',
    paths: [STORE],
    apply(root) {
      replaceThroughMarker(
        root,
        STORE,
        AUTH_WRITER_START,
        AUTH_WRITER_END,
        `  setAuthenticatedOperator(\n    topicId: number | string,\n    input: { platform: string; uid: string; displayName?: string; boundAt?: string },\n    evidence: AuthenticatedTopicOperatorEvidence,\n  ): TopicOperator | null {\n    // B0.1 P1: API preserved, authenticated state transition hollowed.\n    void topicId;\n    void input;\n    void evidence;\n    return null;\n  }`,
      );
    },
    verify(root) {
      return verifyIncludes(root, STORE, [
        AUTH_WRITER_START,
        'B0.1 P1: API preserved, authenticated state transition hollowed.',
        'return null;',
      ]);
    },
  },
  {
    id: 'p2-subject-self-reports-clean',
    property: 'P2',
    violationClass: 'self-report / false testimony',
    label: 'SUBJECT SELF-REPORTS CLEAN',
    paths: [STORE],
    apply(root) {
      replaceThroughMarker(
        root,
        STORE,
        PREDICATE_START,
        PREDICATE_END,
        `${PREDICATE_START}\n  // B0.1 P2: trust the subject's provenance claim and ignore its evidence.\n  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;\n  return (value as Partial<TopicOperatorBinding>).boundFrom === 'authenticated-inbound';\n}`,
      );
    },
    verify(root) {
      return verifyIncludes(root, STORE, [
        PREDICATE_START,
        "B0.1 P2: trust the subject's provenance claim",
        ".boundFrom === 'authenticated-inbound'",
      ], ['evidence.kind !==']);
    },
  },
  {
    id: 'p3a-delete',
    property: 'P3',
    violationClass: 'guard removal',
    label: 'DELETE',
    paths: [STORE],
    apply(root) {
      replaceThroughMarker(root, STORE, PREDICATE_START, PREDICATE_END, '');
    },
    verify(root) {
      return verifyIncludes(root, STORE, [], [PREDICATE_START]);
    },
  },
  {
    id: 'p3b-comment-out',
    property: 'P3',
    violationClass: 'guard removal',
    label: 'COMMENT OUT',
    paths: [STORE],
    apply(root) {
      const content = read(root, STORE);
      const start = content.indexOf(PREDICATE_START);
      const end = content.indexOf(PREDICATE_END, start);
      if (start === -1 || end === -1) throw new Error('predicate block not found');
      const commented = content.slice(start, end).split('\n').map((line) => `// ${line}`).join('\n');
      write(root, STORE, `${content.slice(0, start)}${commented}${content.slice(end)}`);
    },
    verify(root) {
      const lines = read(root, STORE).split('\n');
      const checks = [
        { check: 'commented predicate declaration exists', passed: lines.includes(`// ${PREDICATE_START}`) },
        { check: 'commented terminal verdict exists', passed: lines.includes('//   return true;') },
        { check: 'no executable predicate declaration line remains', passed: !lines.includes(PREDICATE_START) },
      ];
      return { ok: checks.every((item) => item.passed), checks };
    },
  },
  {
    id: 'p3c-superstring-rename',
    property: 'P3',
    violationClass: 'guard removal',
    label: 'SUPERSTRING RENAME',
    paths: [STORE],
    apply(root) {
      replaceOnce(
        root,
        STORE,
        PREDICATE_START,
        'export function isVerifiedTopicOperatorBindingDisabled(value: unknown): value is TopicOperator {',
      );
    },
    verify(root) {
      const content = read(root, STORE);
      const checks = [
        { check: 'longer superstring declaration exists', passed: content.includes('isVerifiedTopicOperatorBindingDisabled') },
        { check: 'original remains a substring', passed: content.includes('isVerifiedTopicOperatorBinding') },
        { check: 'standalone original declaration is absent', passed: !content.includes(PREDICATE_START) },
      ];
      return { ok: checks.every((item) => item.passed), checks };
    },
  },
  {
    id: 'p3d-type-preserving-hollow',
    property: 'P3',
    violationClass: 'guard removal',
    label: 'TYPE-PRESERVING HOLLOW',
    paths: [STORE],
    apply(root) {
      replaceThroughMarker(
        root,
        STORE,
        PREDICATE_START,
        PREDICATE_END,
        `${PREDICATE_START}\n  // B0.1 P3d: type-preserving constant passing verdict.\n  void value;\n  return true;\n}`,
      );
    },
    verify(root) {
      return verifyIncludes(root, STORE, [
        PREDICATE_START,
        'B0.1 P3d: type-preserving constant passing verdict.',
        'return true;',
      ]);
    },
  },
  {
    id: 'p4a-empty-population',
    property: 'P4',
    violationClass: 'vacuous measurement',
    label: 'EMPTY THE POPULATION',
    paths: [STORE],
    apply(root) {
      replaceThroughMarker(
        root,
        STORE,
        ALL_START,
        ALL_END,
        `${ALL_START}\n    // B0.1 P4a: force a vacuous verified-binding population.\n    return {};\n  }`,
      );
    },
    verify(root) {
      return verifyIncludes(root, STORE, [
        ALL_START,
        'B0.1 P4a: force a vacuous verified-binding population.',
        'return {};',
      ]);
    },
  },
  {
    id: 'p4b-hidden-real-violation',
    property: 'P4',
    violationClass: 'population evasion',
    label: 'HIDE A REAL VIOLATION OUTSIDE THE ENUMERATION',
    paths: [STORE],
    apply(root) {
      replaceThroughMarker(
        root,
        STORE,
        ALL_START,
        ALL_END,
        `${ALL_START}\n    const verified: Record<string, TopicOperator> = {};\n    for (const [topicId, binding] of Object.entries(this.load())) {\n      // B0.1 P4b: silently evade a real non-numeric topic key.\n      if (!/^\\d+$/.test(topicId)) continue;\n      if (isVerifiedTopicOperatorBinding(binding)) verified[topicId] = binding;\n    }\n    return verified;\n  }`,
      );
    },
    verify(root) {
      return verifyIncludes(root, STORE, [
        ALL_START,
        'B0.1 P4b: silently evade a real non-numeric topic key.',
        "if (!/^\\d+$/.test(topicId)) continue;",
      ]);
    },
  },
  {
    id: 'p5-blind-input',
    property: 'P5',
    violationClass: 'blind input / fail-open',
    label: 'BLIND THE GUARD',
    paths: [ROUTES],
    apply(root) {
      replaceOnce(
        root,
        ROUTES,
        "            messageId: String(messageId ?? ''),",
        "            messageId: '', // B0.1 P5: authenticated evidence input unavailable.",
      );
      replaceOnce(
        root,
        ROUTES,
        "          telegramMessageId: messageId !== undefined && messageId !== null\n            ? String(messageId)\n            : '',",
        "          telegramMessageId: '', // B0.1 P5: raw lifeline evidence input unavailable.",
      );
    },
    verify(root) {
      return verifyIncludes(root, ROUTES, [
        "messageId: '', // B0.1 P5: authenticated evidence input unavailable.",
        "telegramMessageId: '', // B0.1 P5: raw lifeline evidence input unavailable.",
      ], [
        "messageId: String(messageId ?? ''),",
        'telegramMessageId: messageId !== undefined && messageId !== null',
      ]);
    },
  },
];

export function applyDeliberatelyHollowGuard(root) {
  const hollow = `import { describe, it, expect } from 'vitest';\n\ndescribe('topic-operator evidence deliberately hollow guard', () => {\n  it('self-reports clean without invoking production code', () => {\n    expect(true).toBe(true);\n  });\n});\n`;
  for (const rel of TEST_ARGS) write(root, rel, hollow);
  return {
    paths: TEST_ARGS,
    verify() {
      const checks = TEST_ARGS.map((rel) => ({
        check: `${rel} carries deliberate hollow marker`,
        passed: read(root, rel).includes('topic-operator evidence deliberately hollow guard'),
      }));
      return { ok: checks.every((item) => item.passed), checks };
    },
  };
}
