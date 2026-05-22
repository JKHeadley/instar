/**
 * Unit tests — PostUpdateMigrator ORG-INTENT runtime CLAUDE.md migration.
 *
 * Verifies Migration Parity Standard for the ORG-INTENT runtime gate:
 *   - Agents whose CLAUDE.md predates the runtime wiring receive the new
 *     "ORG-INTENT.md (Organizational Intent at Runtime)" subsection inserted
 *     into their existing Coherence Gate section.
 *   - Agents without any Coherence Gate section receive the full new section
 *     with the ORG-INTENT subsection already embedded.
 *   - Re-running the migration is a no-op (idempotent — content-sniff guards
 *     prevent duplication).
 *   - Missing CLAUDE.md skips cleanly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function makeAgentHome(): {
  tmp: string;
  projectDir: string;
  stateDir: string;
  claudeMd: string;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'org-intent-runtime-migration-'));
  const projectDir = path.join(tmp, 'agent');
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  return { tmp, projectDir, stateDir, claudeMd: path.join(projectDir, 'CLAUDE.md') };
}

function buildMigrator(projectDir: string, stateDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir,
    hasTelegram: false,
    port: 4042,
  });
}

const PREEXISTING_COHERENCE_GATE_SECTION = `# CLAUDE.md

## Coherence Gate (Pre-Action Verification)

**BEFORE any high-risk action**:

1. Check coherence
4. Generate a reflection prompt: POST http://localhost:4042/coherence/reflect

**Topic-Project Bindings**: Each Telegram topic can be bound to a specific project.
- View bindings: GET http://localhost:4042/topic-bindings

**Project Map**: Your spatial awareness of the working environment.
- View: GET http://localhost:4042/project-map?format=compact
`;

describe('PostUpdateMigrator — ORG-INTENT runtime CLAUDE.md migration', () => {
  let home: ReturnType<typeof makeAgentHome>;

  beforeEach(() => {
    home = makeAgentHome();
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(home.tmp, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-org-intent-runtime.test.ts:afterEach',
    });
  });

  it('inserts the ORG-INTENT.md subsection into existing Coherence Gate sections', () => {
    fs.writeFileSync(home.claudeMd, PREEXISTING_COHERENCE_GATE_SECTION);
    const migrator = buildMigrator(home.projectDir, home.stateDir);
    migrator.migrate();

    const content = fs.readFileSync(home.claudeMd, 'utf-8');
    expect(content).toContain('ORG-INTENT.md (Organizational Intent at Runtime)');
    expect(content).toContain('Constraints** are mandatory');
    expect(content).toContain('instar intent org-init');
    // Subsection lands inside the Coherence Gate block, before Topic-Project Bindings
    const orgIntentIdx = content.indexOf('ORG-INTENT.md (Organizational Intent at Runtime)');
    const topicBindingsIdx = content.indexOf('**Topic-Project Bindings**');
    expect(orgIntentIdx).toBeGreaterThan(0);
    expect(orgIntentIdx).toBeLessThan(topicBindingsIdx);
  });

  it('is idempotent when run twice', () => {
    fs.writeFileSync(home.claudeMd, PREEXISTING_COHERENCE_GATE_SECTION);
    const migrator = buildMigrator(home.projectDir, home.stateDir);
    migrator.migrate();
    const afterFirst = fs.readFileSync(home.claudeMd, 'utf-8');

    migrator.migrate();
    const afterSecond = fs.readFileSync(home.claudeMd, 'utf-8');
    expect(afterSecond).toBe(afterFirst);

    // Single occurrence, no duplicate subsection
    const matches = afterSecond.match(/ORG-INTENT\.md \(Organizational Intent at Runtime\)/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('embeds the ORG-INTENT subsection in fresh Coherence Gate sections (no pre-existing block)', () => {
    fs.writeFileSync(home.claudeMd, '# CLAUDE.md\n\nNo coherence gate section yet.\n');
    const migrator = buildMigrator(home.projectDir, home.stateDir);
    migrator.migrate();

    const content = fs.readFileSync(home.claudeMd, 'utf-8');
    expect(content).toContain('### Coherence Gate (Pre-Action Verification)');
    expect(content).toContain('ORG-INTENT.md (Organizational Intent at Runtime)');
    expect(content).toContain('Constraints** are mandatory');
  });

  it('skips cleanly when CLAUDE.md is missing', () => {
    // No CLAUDE.md created
    const migrator = buildMigrator(home.projectDir, home.stateDir);
    expect(() => migrator.migrate()).not.toThrow();
    expect(fs.existsSync(home.claudeMd)).toBe(false);
  });

  it('upgrades the Phase-1-only subsection to mention Phase 2 session-start injection', () => {
    // A CLAUDE.md that has the Phase 1 ORG-INTENT runtime subsection (from
    // the first ORG-INTENT runtime PR) but no Phase 2 session-context route
    // mention — the agent state right before this PR lands.
    const phase1Only = PREEXISTING_COHERENCE_GATE_SECTION.replace(
      '**Topic-Project Bindings**',
      `#### ORG-INTENT.md (Organizational Intent at Runtime)

If \`.instar/ORG-INTENT.md\` exists on disk, the Coherence Gate now reads it on every outbound message review and surfaces the three-rule contract to the value-alignment reviewer: **constraints** are mandatory (violations block), **goals** are organizational defaults (contradictions warn or block), **values** shape representation (drift warns), and the **tradeoff hierarchy** resolves ties when two values pull in opposite directions (earlier entry wins).

Manage it:
- Scaffold a starter: \`instar intent org-init "Your Org Name"\`
- Static validation against agent intent: \`instar intent validate\`
- Inspect parsed structure: \`curl -H "Authorization: Bearer $AUTH" http://localhost:4042/intent/org\`

**Topic-Project Bindings**`,
    );
    fs.writeFileSync(home.claudeMd, phase1Only);

    const migrator = buildMigrator(home.projectDir, home.stateDir);
    migrator.migrate();

    const content = fs.readFileSync(home.claudeMd, 'utf-8');
    // Phase 2 mention now present
    expect(content).toContain('session-start hook (Phase 2)');
    expect(content).toContain('/intent/org/session-context');
    expect(content).toContain('Preview the session-start block');
    // Still only one ORG-INTENT subsection (replacement, not duplication)
    const matches = content.match(/ORG-INTENT\.md \(Organizational Intent at Runtime\)/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('is idempotent on Phase-2-upgraded CLAUDE.md (re-running does not re-modify)', () => {
    // A CLAUDE.md already with the Phase 2 subsection — the post-migration state.
    const phase2Done = PREEXISTING_COHERENCE_GATE_SECTION.replace(
      '**Topic-Project Bindings**',
      `#### ORG-INTENT.md (Organizational Intent at Runtime)

If \`.instar/ORG-INTENT.md\` exists on disk, two runtime surfaces consume it: the Coherence Gate (Phase 1) reads it on every outbound message review, and the session-start hook (Phase 2) fetches it at session boot via \`GET /intent/org/session-context\`.

**Topic-Project Bindings**`,
    );
    fs.writeFileSync(home.claudeMd, phase2Done);

    const migrator = buildMigrator(home.projectDir, home.stateDir);
    migrator.migrate();
    const afterFirst = fs.readFileSync(home.claudeMd, 'utf-8');
    migrator.migrate();
    const afterSecond = fs.readFileSync(home.claudeMd, 'utf-8');
    expect(afterSecond).toBe(afterFirst);
  });

  it('adds Phase 3 tradeoff-resolve curl line to a Phase-1+2 CLAUDE.md', () => {
    // A CLAUDE.md that has Phase 1+2 wording but no Phase 3 curl yet.
    const phase12Only = PREEXISTING_COHERENCE_GATE_SECTION.replace(
      '**Topic-Project Bindings**',
      `#### ORG-INTENT.md (Organizational Intent at Runtime)

If \`.instar/ORG-INTENT.md\` exists on disk, two runtime surfaces consume it: the Coherence Gate (Phase 1) reads it on every outbound message review, and the session-start hook (Phase 2) fetches it at session boot via \`GET /intent/org/session-context\` and injects the structured contract into your context.

Manage it:
- Scaffold a starter: \`instar intent org-init "Your Org Name"\`
- Static validation against agent intent: \`instar intent validate\`
- Inspect parsed structure: \`curl -H "Authorization: Bearer $AUTH" http://localhost:4042/intent/org\`
- Preview the session-start block: \`curl -H "Authorization: Bearer $AUTH" http://localhost:4042/intent/org/session-context\`

**Topic-Project Bindings**`,
    );
    fs.writeFileSync(home.claudeMd, phase12Only);

    const migrator = buildMigrator(home.projectDir, home.stateDir);
    migrator.migrate();

    const content = fs.readFileSync(home.claudeMd, 'utf-8');
    expect(content).toContain('/intent/tradeoff-resolve');
    expect(content).toContain('Resolve a tradeoff via the org hierarchy (Phase 3)');
    // Single insertion — no duplication on re-run
    migrator.migrate();
    const reread = fs.readFileSync(home.claudeMd, 'utf-8');
    expect(reread).toBe(content);
    const matches = reread.match(/\/intent\/tradeoff-resolve/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('does not double-insert when CLAUDE.md already contains the subsection', () => {
    // Pre-existing CLAUDE.md already carries the subsection (e.g. from a fresh init)
    const alreadyMigrated = PREEXISTING_COHERENCE_GATE_SECTION.replace(
      '**Topic-Project Bindings**',
      '#### ORG-INTENT.md (Organizational Intent at Runtime)\n\nThe three-rule contract applies.\n\n**Topic-Project Bindings**',
    );
    fs.writeFileSync(home.claudeMd, alreadyMigrated);

    const migrator = buildMigrator(home.projectDir, home.stateDir);
    migrator.migrate();

    const content = fs.readFileSync(home.claudeMd, 'utf-8');
    const matches = content.match(/ORG-INTENT\.md \(Organizational Intent at Runtime\)/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
