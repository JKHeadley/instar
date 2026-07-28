/**
 * lint-no-unregistered-self-action.test.ts — the forcing-lint fixtures (Part
 * D5). The pure evaluator over injected files: unmarked emitter → violation;
 * marked+registered → clean; marked-but-unregistered → violation; allowlisted →
 * clean; a controller-shape file with no emit → clean; a non-controller file →
 * skipped.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateSelfActionLint,
  loadRegistryIds,
} from '../../scripts/lint-no-unregistered-self-action.js';

const EMIT = 'class FooMonitor { tick() { this.swap(target); } }';
const NO_EMIT = 'class FooMonitor { tick() { return 1; } }';

function run(files: Record<string, string>, registryIds: Set<string>, allowlist?: Set<string>) {
  return evaluateSelfActionLint({
    files: Object.keys(files),
    registryIds,
    allowlist,
    readFile: (rel: string) => (rel in files ? files[rel] : null),
  });
}

describe('loadRegistryIds', () => {
  it('parses greppable id: "..." declarations', () => {
    const ids = loadRegistryIds(`const x = [{ id: 'proactive-swap-monitor', }, { id: "age-kill-backoff" }];`);
    expect(ids.has('proactive-swap-monitor')).toBe(true);
    expect(ids.has('age-kill-backoff')).toBe(true);
  });
});

describe('evaluateSelfActionLint', () => {
  it('unmarked controller emitter → violation', () => {
    const { violations } = run({ 'src/monitoring/FooMonitor.ts': EMIT }, new Set());
    expect(violations.length).toBe(1);
    expect(violations[0].file).toBe('src/monitoring/FooMonitor.ts');
  });

  it('marked + registered → clean', () => {
    const content = `/* @self-action-controller: foo-monitor */\n${EMIT}`;
    const { violations } = run({ 'src/monitoring/FooMonitor.ts': content }, new Set(['foo-monitor']));
    expect(violations.length).toBe(0);
  });

  it('marked but NOT registered → violation', () => {
    const content = `/* @self-action-controller: foo-monitor */\n${EMIT}`;
    const { violations } = run({ 'src/monitoring/FooMonitor.ts': content }, new Set(['other-id']));
    expect(violations.length).toBe(1);
    expect(violations[0].reason).toMatch(/NOT in SELF_ACTION_CONTROLLERS/);
  });

  it('allowlisted → clean', () => {
    const { violations } = run(
      { 'src/monitoring/FooMonitor.ts': EMIT },
      new Set(),
      new Set(['src/monitoring/FooMonitor.ts']),
    );
    expect(violations.length).toBe(0);
  });

  it('controller-shape file with NO emit → clean', () => {
    const { violations, considered } = run({ 'src/monitoring/FooMonitor.ts': NO_EMIT }, new Set());
    expect(violations.length).toBe(0);
    expect(considered).toBe(0);
  });

  it('a NON-controller-shape file with an emit → skipped (out of report-only scope)', () => {
    const { violations, considered } = run({ 'src/core/types.ts': EMIT }, new Set());
    expect(violations.length).toBe(0);
    expect(considered).toBe(0);
  });

  it('a marker on a non-shape file brings it INTO scope', () => {
    const content = `/* @self-action-controller: thing */\n${EMIT}`;
    const { violations } = run({ 'src/core/thing.ts': content }, new Set());
    expect(violations.length).toBe(1);
  });

  it('test files are ignored', () => {
    const { violations, considered } = run({ 'src/monitoring/FooMonitor.test.ts': EMIT }, new Set());
    expect(violations.length).toBe(0);
    expect(considered).toBe(0);
  });
});
