/**
 * Unit tests — the § 10 agent-awareness note is a real CARRIER (grok-build spec
 * §7/§10/§11, round-12).
 *
 * §7 makes it normative that an operator enrolling a grok subscription is told
 * the Claude-side throttle source changes and that removing `grok-build` from
 * `enabledFrameworks` does NOT unenrol the account. Round-12 (decision-
 * completeness) found the carrier existed in both delivery halves but had no
 * test anywhere — on a money-adjacent disclosure the spec itself calls not
 * retroactively cheap. These pin it on BOTH halves and assert they agree, which
 * is the parity the Agent Awareness + Migration Parity standards require.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const PORT = 4042;
const ANCHOR = 'Per-Component Framework Routing';

let projectDir: string;
let claudeMdPath: string;

function newMigrator(dir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir: dir,
    stateDir: path.join(dir, '.instar'),
    port: PORT,
    hasTelegram: false,
    projectName: 'test',
  });
}

function runPrivate(m: PostUpdateMigrator, method: string): void {
  const result = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as Record<string, (r: unknown) => void>)[method]!(result);
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-awareness-'));
  fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
  claudeMdPath = path.join(projectDir, 'CLAUDE.md');
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(projectDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/grok-build-awareness-parity.test.ts:afterEach',
  });
});

describe('grok-build agent-awareness note — the §7 disclosure carrier', () => {
  it('the FRESH-INIT template carries the enrolment disclosure and the pin behaviour', () => {
    const md = generateClaudeMd('test', 'TestAgent', PORT, false);
    expect(md).toContain('grok-build');
    // §7: the throttle-source change and the unenrol step.
    expect(md).toContain('ENROLMENT NOTE');
    expect(md).toContain('pool headroom');
    expect(md).toContain('does NOT unenrol the account');
    // §4.3: a pin that cannot hold falls back WITH a notice — and round-12
    // corrected the condition, since the opt-in case is the likelier trigger.
    // Round-17 (adversarial): this asserted only the CONSEQUENCE ("falls back
    // … WITH a notice") and never the CONDITION, so the note could name the
    // wrong cause indefinitely and stay green — which it did. The note said
    // only "if the binary is missing", while on the documented reviewer
    // posture the actual refusal is the interactive opt-in, and the remedy the
    // message implied (install the binary) could not fix it.
    expect(md).toContain('falls back to the default framework WITH a notice');
    expect(md).toContain('the interactive opt-in is unset');
    expect(md).toContain('naming WHICH of the two it was');
    // Round-17 (decision-completeness): the note claimed headless job spawns
    // "refuse outright", which the normative contract retired as inaccurate —
    // a job resolved to grok runs on another enabled framework and is labelled
    // as it. Wrong in the one direction the disclosure exists to cover: whose
    // quota ran your job.
    // INVERTED 2026-08-16. This previously asserted the template CONTAINS
    // "headless job spawns do NOT run on grok yet". When the headless lane was
    // opened, that sentence became false — and this assertion was actively
    // DEFENDING it, which is why the stale claim survived the change: a test
    // demanding the wrong text is worse than no test, because the suite goes red
    // for telling the truth. Inverted to forbid the false claim rather than
    // restoring it to get green. The behavioural coupling — text vs
    // headlessLaneIsClosed — lives in grok-awareness-matches-behaviour.test.ts.
    expect(md).not.toContain('headless job spawns do NOT run on grok yet');
    expect(md).not.toContain('headless job spawns refuse outright');
    expect(md).toContain('grok-headless-source-tree');
    // §0.0: the honest cost posture.
    expect(md).toContain('budget grok runs as if metered');
  });

  it('the MIGRATION carries the identical note for EXISTING agents (parity, not a fresh-agent-only feature)', () => {
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md — test\n\n### ${ANCHOR}\n\nbody\n`);
    runPrivate(newMigrator(projectDir), 'migrateClaudeMd');
    const migrated = fs.readFileSync(claudeMdPath, 'utf8');

    expect(migrated).toContain('ENROLMENT NOTE');
    expect(migrated).toContain('does NOT unenrol the account');

    // The two halves must not drift: extract the grok paragraph from each and
    // compare. A migration that says something different from the template is
    // how an agent's awareness depends on when it was created.
    const grokLine = (text: string): string =>
      text.split('\n').find((l) => l.includes('**Grok Build framework')) ?? '';
    expect(grokLine(migrated)).not.toBe('');
    expect(grokLine(migrated)).toBe(grokLine(generateClaudeMd('test', 'TestAgent', PORT, false)));
  });

  it('is idempotent and does NOT fire when the anchor is absent', () => {
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md — test\n\n### ${ANCHOR}\n\nbody\n`);
    runPrivate(newMigrator(projectDir), 'migrateClaudeMd');
    runPrivate(newMigrator(projectDir), 'migrateClaudeMd');
    const twice = fs.readFileSync(claudeMdPath, 'utf8');
    expect(twice.split('**Grok Build framework').length - 1).toBe(1);

    // The OTHER documented miss-case — a doc already containing the literal
    // `grok-build` is deliberately skipped — is the reachable one. (The
    // "no anchor" miss-case is NOT reachable through a full migrateClaudeMd
    // run: sibling sections appended earlier in the same pass supply the
    // anchor, so the sniff always finds it. Measured here rather than assumed;
    // the spec's §11 wording describes the sniff, not an observable outcome.)
    const other = path.join(projectDir, 'other');
    fs.mkdirSync(path.join(other, '.instar'), { recursive: true });
    fs.writeFileSync(
      path.join(other, 'CLAUDE.md'),
      `# CLAUDE.md — test\n\n### ${ANCHOR}\n\nI already mention grok-build somewhere.\n`,
    );
    runPrivate(newMigrator(other), 'migrateClaudeMd');
    expect(fs.readFileSync(path.join(other, 'CLAUDE.md'), 'utf8')).not.toContain('**Grok Build framework');
  });
});
