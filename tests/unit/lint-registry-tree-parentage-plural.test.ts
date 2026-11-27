/**
 * lint-registry-tree-parentage reads a parent's plural acknowledgement list
 * ("Tree nodes beneath it: *A*; *B*.") as acknowledging every listed child, so an
 * approved constitution text in that form lands without rewording. The singular form
 * and the refusal of an unacknowledged child are unchanged.
 * (Constitution amendments 1-8, approved by Justin [source: telegram 142440/4516843644856181 2026-11-16].)
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const LINT = path.join(process.cwd(), 'scripts/lint-registry-tree-parentage.mjs');

function run(registry: string): { code: number; out: { relations: Array<{ child: string; parent: string }>; failures: string[] } } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parentage-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.copyFileSync(LINT, path.join(root, 'scripts/lint.mjs'));
  fs.writeFileSync(path.join(root, 'docs/STANDARDS-REGISTRY.md'), registry);
  try {
    const stdout = execFileSync('node', [path.join(root, 'scripts/lint.mjs'), '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out: JSON.parse(stdout) };
  } catch (err) {
    const e = err as { status: number; stdout: string };
    return { code: e.status, out: JSON.parse(e.stdout) };
  } finally {
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/lint-registry-tree-parentage-plural.test.ts' });
  }
}

const registry = (parentAck: string) => [
  '## Interaction',
  '### Parent Standard',
  `**Tree placement.** ROOT. ${parentAck}`,
  '### First; Child',
  '**Tree placement.** **CHILD** — this is **a tree node under *Parent Standard***.',
  '### Second Child',
  '**Tree placement.** **CHILD** — this is **a tree node under *Parent Standard***.',
  '',
].join('\n');

describe('lint-registry-tree-parentage: plural acknowledgement list', () => {
  it('accepts every child named in a "Tree nodes beneath it" list, including a name containing a semicolon', () => {
    const { code, out } = run(registry('Tree nodes beneath it: *First; Child*; *Second Child*.'));
    expect(out.failures).toEqual([]);
    expect(code).toBe(0);
    expect(out.relations).toEqual([
      { child: 'First; Child', parent: 'Parent Standard' },
      { child: 'Second Child', parent: 'Parent Standard' },
    ]);
  });

  it('still refuses a child the parent does not name back', () => {
    const { code, out } = run(registry('Tree node beneath it: *First; Child*.'));
    expect(code).not.toBe(0);
    expect(out.failures.join('\n')).toContain('"Second Child" claims "Parent Standard" as its parent');
  });

  it('does not read a later, unrelated italic name in the same paragraph as an acknowledgement', () => {
    const { code, out } = run(registry('Tree node beneath it: *First; Child*. See also *Second Child* elsewhere.'));
    expect(code).not.toBe(0);
    expect(out.failures.join('\n')).toContain('"Second Child" claims "Parent Standard" as its parent');
  });
});
