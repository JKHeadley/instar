/**
 * Unit tests for PlanDocParser.
 *
 * Covers:
 *   - happy path: valid frontmatter + tier table → project seed + child seeds
 *   - frontmatter schema rejection (missing keys, wrong types, unknown keys)
 *   - path traversal in source_docs
 *   - slug regex rejection
 *   - malformed tier-table tolerance
 *
 * Plan docs are synthesized in a temp dir per spec ("use a small synthetic
 * plan for tests" — Phase 1.6).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePlanDoc } from '../../src/core/PlanDocParser.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('PlanDocParser', () => {
  let tmpRepo: string;
  let plansDir: string;

  beforeAll(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-parser-repo-'));
    fs.mkdirSync(path.join(tmpRepo, 'docs/specs'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'docs/specs/a.md'), '');
    fs.writeFileSync(path.join(tmpRepo, 'docs/specs/b.md'), '');
    plansDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-parser-plans-'));
  });

  afterAll(() => {
    SafeFsExecutor.safeRmSync(tmpRepo, { recursive: true, force: true, operation: 'tests/unit/PlanDocParser.test.ts:afterAll-tmpRepo' });
    SafeFsExecutor.safeRmSync(plansDir, { recursive: true, force: true, operation: 'tests/unit/PlanDocParser.test.ts:afterAll-plansDir' });
  });

  function writePlan(name: string, body: string): string {
    const p = path.join(plansDir, name);
    fs.writeFileSync(p, body);
    return p;
  }

  it('parses a valid plan doc with frontmatter + two-tier roster table', async () => {
    const planPath = writePlan(
      'good.md',
      `---
kind: project
id: openclaw-imports
title: OpenClaw imports
status: active
owner: Echo
target_repo_path: ${tmpRepo}
source_docs:
  - docs/specs/a.md
  - docs/specs/b.md
goal: |
  Multi-line goal that
  spans two lines.
auto_advance: true
defers:
  - defer-one
  - defer-two
---

## Roster

### Tier 1 — first three

| # | Item       | Source        | Effort |
|---|------------|---------------|--------|
| 1 | Widget A   | feedback-001  | s      |
| 2 | Widget B   | gap-003       | m      |

### Tier 2 — next five

| # | Item       | Source        | Effort |
|---|------------|---------------|--------|
| 3 | Tooling X  | gap-009       | l      |
`
    );

    const parsed = await parsePlanDoc(planPath);
    expect(parsed.errors).toEqual([]);
    expect(parsed.project).not.toBeNull();
    expect(parsed.project!.id).toBe('openclaw-imports');
    expect(parsed.project!.title).toBe('OpenClaw imports');
    expect(parsed.project!.targetRepoPath).toBe(tmpRepo);
    expect(parsed.project!.sourceDocs).toEqual([
      'docs/specs/a.md',
      'docs/specs/b.md',
    ]);
    expect(parsed.project!.autoAdvance).toBe(true);
    expect(parsed.project!.defers).toEqual(['defer-one', 'defer-two']);
    expect(parsed.project!.description).toMatch(/Multi-line goal/);

    expect(parsed.children).toHaveLength(3);
    expect(parsed.children[0]).toMatchObject({
      id: 'openclaw-imports-1',
      title: 'Widget A',
      sourceTag: 'feedback-001',
      effortTag: 's',
      pipelineStage: 'outline',
      parentProjectId: 'openclaw-imports',
    });
    expect(parsed.children[0].roundName).toMatch(/^Tier 1/);
    expect(parsed.children[2].roundName).toMatch(/^Tier 2/);
  });

  it('rejects frontmatter with kind != project', async () => {
    const planPath = writePlan(
      'wrong-kind.md',
      `---
kind: task
id: foo
title: foo
status: active
owner: Echo
target_repo_path: ${tmpRepo}
source_docs:
  - docs/specs/a.md
goal: hi
---
`
    );
    const parsed = await parsePlanDoc(planPath);
    expect(parsed.project).toBeNull();
    expect(parsed.errors.some((e) => /kind.*must be.*project/.test(e))).toBe(true);
  });

  it('rejects frontmatter with invalid slug', async () => {
    const planPath = writePlan(
      'bad-slug.md',
      `---
kind: project
id: BadSlug!
title: foo
status: active
owner: Echo
target_repo_path: ${tmpRepo}
source_docs:
  - docs/specs/a.md
goal: hi
---
`
    );
    const parsed = await parsePlanDoc(planPath);
    expect(parsed.project).toBeNull();
    expect(parsed.errors.some((e) => /id.*must match/.test(e))).toBe(true);
  });

  it('rejects source_docs paths that escape target_repo_path', async () => {
    const planPath = writePlan(
      'escape.md',
      `---
kind: project
id: escape-test
title: escape test
status: active
owner: Echo
target_repo_path: ${tmpRepo}
source_docs:
  - ../../etc/passwd
goal: try to escape
---
`
    );
    const parsed = await parsePlanDoc(planPath);
    expect(parsed.project).toBeNull();
    expect(
      parsed.errors.some((e) => /escapes target_repo_path/.test(e) || /source_docs/.test(e))
    ).toBe(true);
  });

  it('rejects unknown frontmatter keys', async () => {
    const planPath = writePlan(
      'unknown-key.md',
      `---
kind: project
id: unknown-key-test
title: t
status: active
owner: Echo
target_repo_path: ${tmpRepo}
source_docs:
  - docs/specs/a.md
goal: g
malicious_field: hi
---
`
    );
    const parsed = await parsePlanDoc(planPath);
    expect(parsed.errors.some((e) => /unknown frontmatter key/.test(e))).toBe(true);
  });

  it('rejects when target_repo_path does not exist', async () => {
    const planPath = writePlan(
      'missing-target.md',
      `---
kind: project
id: missing-target
title: t
status: active
owner: Echo
target_repo_path: /this/path/does/not/exist-xyz123
source_docs:
  - foo
goal: g
---
`
    );
    const parsed = await parsePlanDoc(planPath);
    expect(parsed.project).toBeNull();
    expect(parsed.errors.some((e) => /target_repo_path/.test(e))).toBe(true);
  });

  it('tolerates a malformed tier table (records error, keeps going)', async () => {
    const planPath = writePlan(
      'malformed-table.md',
      `---
kind: project
id: malformed-table
title: t
status: active
owner: Echo
target_repo_path: ${tmpRepo}
source_docs:
  - docs/specs/a.md
goal: g
---

### Tier 1 — broken

| Wrong | Headers |
|-------|---------|
| 1 | a |

### Tier 2 — works

| # | Item   | Source | Effort |
|---|--------|--------|--------|
| 1 | Alpha  | src-a  | s      |
`
    );
    const parsed = await parsePlanDoc(planPath);
    expect(parsed.project).not.toBeNull();
    // Malformed table error captured, but Tier 2 still parsed.
    expect(parsed.errors.some((e) => /column headers/.test(e))).toBe(true);
    expect(parsed.children).toHaveLength(1);
    expect(parsed.children[0].title).toBe('Alpha');
  });

  it('rejects plan doc with no frontmatter at all', async () => {
    const planPath = writePlan('no-fm.md', `# just a heading\n\nbody\n`);
    const parsed = await parsePlanDoc(planPath);
    expect(parsed.project).toBeNull();
    expect(parsed.errors.some((e) => /frontmatter/.test(e))).toBe(true);
  });

  it('rejects relative absPath argument', async () => {
    const parsed = await parsePlanDoc('relative/path.md');
    expect(parsed.project).toBeNull();
    expect(parsed.errors[0]).toMatch(/absolute/);
  });
});
