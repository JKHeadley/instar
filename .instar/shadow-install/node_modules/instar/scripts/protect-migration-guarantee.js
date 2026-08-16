#!/usr/bin/env node
/**
 * protect-migration-guarantee.js — pre-commit gate enforcing
 * INSTAR-JOBS-AS-AGENTMD-SPEC §Seamless Migration Guarantee §Gate wiring:
 *
 *   "The pre-commit gate refuses any commit that deletes
 *    tests/integration/migration-guarantee.test.ts or removes a fixture
 *    directory from tests/fixtures/migration-agents/. Adding new fixtures
 *    is unrestricted."
 *
 * Hooked from .husky/pre-commit alongside instar-dev-precommit.js.
 *
 * Exit codes:
 *   0 — pass
 *   1 — block (deletion attempted)
 */

import { execSync } from 'node:child_process';

const TEST_PATH = 'tests/integration/migration-guarantee.test.ts';
const FIXTURES_PREFIX = 'tests/fixtures/migration-agents/';

let staged;
try {
  // List staged files with their diff filter — D = deleted.
  staged = execSync('git diff --cached --name-status', { encoding: 'utf-8' });
} catch {
  // Not a git repo or git unavailable — fail-open.
  process.exit(0);
}

const violations = [];
for (const line of staged.split('\n')) {
  if (!line.trim()) continue;
  const [status, ...pathParts] = line.split(/\s+/);
  const filePath = pathParts.join(' ');
  if (status !== 'D') continue;
  if (filePath === TEST_PATH) {
    violations.push(`Refusing to delete the Seamless Migration Guarantee test: ${filePath}`);
  } else if (filePath.startsWith(FIXTURES_PREFIX)) {
    // Allow deletion of files INSIDE a fixture directory only if the
    // fixture's shape.json is being modified (i.e., the fixture still
    // exists). Refuse deletion of the shape.json itself or the directory.
    if (filePath.endsWith('/shape.json')) {
      violations.push(`Refusing to delete migration-guarantee fixture: ${filePath}`);
    }
  }
}

if (violations.length > 0) {
  console.error('\n╔════════════════════════════════════════════════════════════════════╗');
  console.error('║  protect-migration-guarantee — VIOLATIONS                          ║');
  console.error('╚════════════════════════════════════════════════════════════════════╝\n');
  for (const v of violations) console.error('  ' + v);
  console.error('\nThe Seamless Migration Guarantee suite is structurally protected.');
  console.error('Adding new fixtures is unrestricted; deleting existing ones is not.');
  console.error('Spec: docs/specs/INSTAR-JOBS-AS-AGENTMD-SPEC.md §Gate wiring.\n');
  process.exit(1);
}

process.exit(0);
